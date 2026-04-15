/**
 * webm-fixer.js — Fix WebM prodotto da MediaRecorder (v2)
 *
 * PROBLEMA:
 * Chrome MediaRecorder produce WebM senza il campo Duration nel SegmentInfo.
 * Senza questo campo, ffmpeg e VLC non riescono a determinare la durata
 * e il remux in MP4 produce black screen o errore di codec.
 *
 * SOLUZIONE:
 * Parsare il binario EBML, leggere i timecode di tutti i Cluster presenti,
 * calcolare la durata reale e iniettarla nel SegmentInfo.
 *
 * UTILIZZO:
 *   const fixedBlob = await fixWebM(originalBlob);
 *
 * RIFERIMENTI:
 *   https://www.matroska.org/technical/specs/index.html
 *   https://www.webmproject.org/docs/container/
 */

"use strict";

/* ── COSTANTI EBML ID (esadecimali come da spec Matroska) ── */
const EBML_ID = {
  EBML:          0x1A45DFA3,
  Segment:       0x18538067,
  SegmentInfo:   0x1549A966,
  TimecodeScale: 0xAD7B1836,
  Duration:      0x4489,
  Cluster:       0x1F43B675,
  Timecode:      0xE7,
  SeekHead:      0x114D9B74,
  Tracks:        0x1654AE6B,
  Cues:          0x1C53BB6B,
};

/* ── ENTRY POINT ── */

/**
 * @param {Blob} blob  WebM grezzo da MediaRecorder
 * @returns {Promise<Blob>} WebM con Duration nel SegmentInfo
 */
async function fixWebM(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const fixed  = patchDuration(buffer);
    return new Blob([fixed], { type: blob.type });
  } catch (err) {
    console.warn("[webm-fixer] Impossibile fixare il WebM, uso originale:", err);
    return blob;
  }
}

/* ── PATCH DURATION ── */

function patchDuration(buffer) {
  const data = new Uint8Array(buffer);

  // 1. Trova il Segment (wrapper principale di tutto il contenuto)
  const segEl = findElementAtLevel(data, 0, EBML_ID.Segment);
  if (!segEl) throw new Error("Segment non trovato");

  // 2. Trova il SegmentInfo dentro il Segment (primo livello figlio)
  const infoEl = findElementAtLevel(data, segEl.dataOffset, EBML_ID.SegmentInfo);
  if (!infoEl) throw new Error("SegmentInfo non trovato");

  // 3. Leggi TimecodeScale (default 1.000.000 ns = 1ms per tick)
  //    Si trova dentro SegmentInfo
  let timecodeScale = 1_000_000;
  const scaleEl = findElementAtLevel(data, infoEl.dataOffset, EBML_ID.TimecodeScale);
  if (scaleEl && scaleEl.dataOffset + scaleEl.size <= infoEl.dataOffset + infoEl.size) {
    timecodeScale = readUintBE(data, scaleEl.dataOffset, scaleEl.size);
    if (timecodeScale <= 0) timecodeScale = 1_000_000;
  }

  // 4. Calcola la durata leggendo i Timecode di tutti i Cluster
  //    I Cluster sono fratelli del SegmentInfo dentro il Segment
  const durationMs = computeDurationFromClusters(data, segEl.dataOffset, timecodeScale);

  if (durationMs <= 0) {
    console.warn("[webm-fixer] Durata calcolata non valida:", durationMs,
      "— il file potrebbe essere troppo corto o i Cluster non hanno Timecode.");
    return data; // restituisce originale senza modifiche
  }

  console.log("[webm-fixer] Durata calcolata:", durationMs.toFixed(0), "ms");

  // 5. Controlla se Duration esiste già nel SegmentInfo
  const durationEl = findElementAtLevel(data, infoEl.dataOffset, EBML_ID.Duration);
  const durationInInfo = durationEl &&
    durationEl.offset >= infoEl.dataOffset &&
    durationEl.offset < infoEl.dataOffset + infoEl.size;

  if (durationInInfo) {
    // Sovrascrivi il float64 esistente in-place (non cambia la dimensione del buffer)
    return overwriteDuration(data, durationEl.dataOffset, durationMs);
  } else {
    // Inserisci un nuovo elemento Duration come primo figlio di SegmentInfo
    return insertDuration(data, infoEl, durationMs);
  }
}

/* ── CALCOLO DURATA DAI CLUSTER ── */

/**
 * Scansiona tutti i Cluster al primo livello sotto il Segment e raccoglie
 * il loro Timecode. La durata finale è: maxTimecodeMs + stima un frame (33ms).
 *
 * STRATEGIA DI FALLBACK:
 * Chrome MediaRecorder a volte omette il Timecode esplicito nel Cluster header
 * (specialmente per registrazioni molto brevi o su hardware lento).
 * In questo caso leggiamo il timestamp dai SimpleBlock contenuti nei Cluster:
 * ogni SimpleBlock ha un timecode relativo a 16 bit nel suo header.
 * Il timestamp assoluto del SimpleBlock = Cluster.Timecode + SimpleBlock.timecode
 *
 * NOTA: i timecode sono in "ticks" dove 1 tick = timecodeScale nanosecondi.
 *   Con timecodeScale default (1.000.000 ns) → 1 tick = 1 ms.
 */
const EBML_ID_SIMPLEBLOCK = 0xA3;
const EBML_ID_BLOCKGROUP  = 0xA0;
const EBML_ID_BLOCK       = 0xA1;

function computeDurationFromClusters(data, segmentDataOffset, timecodeScale) {
  let maxTimecodeMs = 0;
  let offset = segmentDataOffset;
  let foundAnyTimecode = false;

  while (offset < data.length - 4) {
    const el = tryReadElement(data, offset);
    if (!el) break;

    if (el.id === EBML_ID.Cluster) {
      // Tentativo 1: Timecode esplicito nel Cluster header (standard)
      const tcEl = findElementAtLevel(data, el.dataOffset, EBML_ID.Timecode);
      let clusterTimecodeMs = 0;

      if (tcEl && tcEl.offset < el.dataOffset + Math.min(el.size, 512)) {
        const ticks = readUintBE(data, tcEl.dataOffset, tcEl.size);
        clusterTimecodeMs = (ticks * timecodeScale) / 1_000_000;
        if (clusterTimecodeMs > maxTimecodeMs) maxTimecodeMs = clusterTimecodeMs;
        foundAnyTimecode = true;
      }

      // Tentativo 2: leggi timecode dai SimpleBlock dentro il Cluster.
      // Utile quando il Cluster non ha Timecode esplicito, o per raffinare
      // la durata con l'ultimo blocco effettivo.
      const sbMs = readSimpleBlockTimecodes(data, el.dataOffset, el.size, clusterTimecodeMs, timecodeScale);
      if (sbMs > maxTimecodeMs) {
        maxTimecodeMs = sbMs;
        foundAnyTimecode = true;
      }
    }

    if (el.totalSize <= 0) break;
    offset += el.totalSize;
  }

  return foundAnyTimecode ? maxTimecodeMs + 33 : 0;
}

/**
 * Scansiona i SimpleBlock (e Block dentro BlockGroup) dentro un Cluster
 * e restituisce il timestamp assoluto massimo trovato in ms.
 *
 * Header SimpleBlock: [Track VINT] [Timecode int16 BE] [Flags 1 byte] [data...]
 * Il timecode del SimpleBlock è relativo al Cluster.Timecode.
 *
 * @param {Uint8Array} data
 * @param {number} clusterDataOffset  offset inizio dati del Cluster
 * @param {number} clusterSize        dimensione dati del Cluster
 * @param {number} clusterTimecodeMs  Timecode del Cluster in ms (può essere 0)
 * @param {number} timecodeScale      nanosecondi per tick
 * @returns {number} timestamp massimo in ms, 0 se nessun blocco trovato
 */
function readSimpleBlockTimecodes(data, clusterDataOffset, clusterSize, clusterTimecodeMs, timecodeScale) {
  let maxMs = 0;
  let offset = clusterDataOffset;
  const clusterEnd = Math.min(clusterDataOffset + clusterSize, data.length);

  while (offset < clusterEnd - 4) {
    const el = tryReadElement(data, offset);
    if (!el || el.totalSize <= 0) break;

    let blockDataOffset = -1;

    if (el.id === EBML_ID_SIMPLEBLOCK) {
      blockDataOffset = el.dataOffset;
    } else if (el.id === EBML_ID_BLOCKGROUP) {
      // Cerca Block dentro BlockGroup
      const blockEl = findElementAtLevel(data, el.dataOffset, EBML_ID_BLOCK);
      if (blockEl) blockDataOffset = blockEl.dataOffset;
    }

    if (blockDataOffset >= 0) {
      try {
        // Header Block: Track (VINT) + Timecode (int16 BE) + Flags (1 byte)
        const trackVint = readVINT(data, blockDataOffset, false);
        const tcOffset  = blockDataOffset + trackVint.len;
        if (tcOffset + 2 <= data.length) {
          // Il timecode del block è un int16 con segno (può essere negativo)
          const view = new DataView(data.buffer, data.byteOffset);
          const blockTc = view.getInt16(tcOffset, false /* big-endian */);
          // Converti tick → ms e somma al Cluster base
          const blockMs = clusterTimecodeMs + (blockTc * timecodeScale) / 1_000_000;
          if (blockMs > maxMs) maxMs = blockMs;
        }
      } catch { /* blocco malformato, salta */ }
    }

    offset += el.totalSize;
  }

  return maxMs;
}

/* ── SCRITTURA DURATION ── */

function overwriteDuration(data, dataOffset, durationMs) {
  const result = new Uint8Array(data);
  new DataView(result.buffer).setFloat64(dataOffset, durationMs, false /* big-endian */);
  return result;
}

function insertDuration(data, infoEl, durationMs) {
  // Elemento Duration EBML: ID(2) + Size VINT(1) + float64(8) = 11 byte
  const durBytes = buildDurationElement(durationMs);
  const insertAt = infoEl.dataOffset; // inseriamo subito dopo l'header del SegmentInfo

  const result = new Uint8Array(data.length + durBytes.length);
  result.set(data.subarray(0, insertAt));
  result.set(durBytes, insertAt);
  result.set(data.subarray(insertAt), insertAt + durBytes.length);

  // Aggiorna la size del SegmentInfo nell'header del buffer risultante
  patchElementSize(result, infoEl.offset, infoEl.size + durBytes.length);

  return result;
}

function buildDurationElement(durationMs) {
  const el   = new Uint8Array(11);
  const view = new DataView(el.buffer);
  el[0] = 0x44; // ID: 0x4489
  el[1] = 0x89;
  el[2] = 0x88; // VINT size = 8 byte (0x80 | 8 = 0x88)
  view.setFloat64(3, durationMs, false /* big-endian */);
  return el;
}

/**
 * Riscrive la size VINT di un elemento EBML.
 * Funziona solo se la nuova size occupa lo stesso numero di byte VINT.
 */
function patchElementSize(data, elementOffset, newSize) {
  const idVint   = readVINT(data, elementOffset, true);
  const sizeOff  = elementOffset + idVint.len;
  const sizeVint = readVINT(data, sizeOff, false);
  const encoded  = encodeVINT(newSize, sizeVint.len);
  data.set(encoded, sizeOff);
}

/* ── PARSER EBML ── */

/**
 * Cerca un elemento con un dato ID, scansionando linearmente da startOffset.
 * NON ricorsiva: visita solo gli elementi al livello dato (fratelli).
 *
 * @returns {object|null} { id, offset, dataOffset, size, totalSize }
 */
function findElementAtLevel(data, startOffset, targetId) {
  let offset = startOffset;
  // Limite di sicurezza: non andiamo oltre la fine del buffer
  while (offset < data.length - 4) {
    const el = tryReadElement(data, offset);
    if (!el) break;
    if (el.id === targetId) return el;
    // Salta questo elemento e passa al fratello successivo
    if (el.totalSize <= 0 || offset + el.totalSize > data.length) break;
    offset += el.totalSize;
  }
  return null;
}

/**
 * Tenta di leggere un elemento EBML all'offset dato.
 * Restituisce null se i byte non sono un elemento valido.
 */
function tryReadElement(data, offset) {
  try {
    const idVint   = readVINT(data, offset, true);
    const sizeVint = readVINT(data, offset + idVint.len, false);

    // Taglia elementi con size "unknown" (0x01FFFFFFFFFFFFFF) che MediaRecorder
    // usa per il Segment (size = fine file). Li trattiamo come size = bytes rimasti.
    let size = sizeVint.val;
    const UNKNOWN_SIZE = 0x00FFFFFFFFFFFFFF; // valore VINT "unknown"
    if (size >= UNKNOWN_SIZE) {
      size = data.length - offset - idVint.len - sizeVint.len;
    }

    return {
      id:        idVint.val,
      offset,
      dataOffset: offset + idVint.len + sizeVint.len,
      size,
      totalSize: idVint.len + sizeVint.len + size,
    };
  } catch {
    return null;
  }
}

/**
 * Legge un VINT (Variable-length Integer) EBML.
 *
 * In EBML, il numero di byte è determinato dal leading bit:
 *   1xxxxxxx → 1 byte
 *   01xxxxxx xxxxxxxx → 2 byte
 *   001xxxxx xxxxxxxx xxxxxxxx → 3 byte
 *   ecc.
 *
 * Per gli ID (keepMarker=true) il bit di lunghezza NON viene rimosso dal valore.
 * Per le size (keepMarker=false) il bit di lunghezza viene rimosso.
 */
function readVINT(data, offset, keepMarker) {
  const first = data[offset];
  if (first === undefined) throw new RangeError("EOF a offset " + offset);

  // Trova la larghezza: numero di leading zero + 1
  let width = 1;
  for (let i = 7; i >= 0; i--) {
    if (first & (1 << i)) { width = 8 - i; break; }
    if (i === 0) throw new RangeError("VINT non valido a offset " + offset);
  }

  // Assembla il valore
  let val = keepMarker
    ? first                               // mantieni il marker bit (per gli ID)
    : (first & ((1 << (8 - width)) - 1)); // rimuovi il marker bit (per le size)

  for (let i = 1; i < width; i++) {
    if (offset + i >= data.length) throw new RangeError("VINT troncato a offset " + offset);
    val = val * 256 + data[offset + i];
  }

  return { val, len: width };
}

/**
 * Codifica un intero come VINT di larghezza fissa (width byte).
 */
function encodeVINT(value, width) {
  const result = new Uint8Array(width);
  let remaining = value;
  for (let i = width - 1; i > 0; i--) {
    result[i] = remaining & 0xFF;
    remaining = Math.floor(remaining / 256);
  }
  result[0] = remaining | (1 << (8 - width));
  return result;
}

/**
 * Legge un intero big-endian senza segno di `byteCount` byte.
 */
function readUintBE(data, offset, byteCount) {
  let val = 0;
  for (let i = 0; i < byteCount && i < 8; i++) {
    val = val * 256 + data[offset + i];
  }
  return val;
}

// Esporta per Node.js (test unitari)
if (typeof module !== "undefined") module.exports = { fixWebM };

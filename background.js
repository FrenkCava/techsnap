/**
 * background.js — Service Worker (TechSnap v5)
 *
 * PROBLEMI RISOLTI:
 *
 * 1. SERVICE WORKER KILLATO DA CHROME (MV3)
 *    Chrome termina i SW dopo ~30s di inattività, anche con port long-lived aperta.
 *    Soluzione: keepalive tramite chrome.alarms (unico meccanismo affidabile in MV3).
 *    L'alarm scatta ogni 20s e fa una micro-operazione (lettura storage) che
 *    sveglia il SW e resetta il timer di inattività di Chrome.
 *
 * 2. STATO VOLATILE (perso al restart del SW)
 *    rec è un oggetto JS in-memory: se il SW viene killato, lo stato sparisce.
 *    Soluzione: ogni modifica di stato viene persistita su chrome.storage.session
 *    (session = sopravvive al restart del SW ma non alla chiusura di Chrome).
 *    Al riavvio del SW, lo stato viene ripristinato da storage prima di rispondere.
 *
 * 3. RACE CONDITION ALLA CONNESSIONE
 *    recorder.html si apre, il SW muore nel frattempo, recorder.js fa reconnect
 *    ma trova il SW ripartito da zero.
 *    Soluzione: onConnect ripristina sempre lo stato da storage prima di inviare
 *    il messaggio "init" alla finestra recorder.
 */
"use strict";

/* ── STATO IN MEMORIA (cache locale del SW) ─── */
const rec = {
  status:           "idle",
  startTime:        0,
  accumulatedMs:    0,
  resumeTime:       0,
  subtitlesByLang:  {},
  subtitleCounters: {},
  pageTitle:        "",
  pageUrl:          "",
  recorderWindowId: null,
  recorderPort:     null,
  _pendingTabId:    null,
  _keepaliveActive: false,
  _storagePersistWarned: false,
};

/* ── CHIAVE STORAGE SESSION ─────────────────── */
const STORAGE_KEY = "rec_state";
const STORAGE_SOFT_LIMIT_BYTES = 8 * 1024 * 1024; // margine sotto le quote tipiche

/* ── KEEPALIVE TRAMITE ALARMS ───────────────── */
// chrome.alarms è il modo corretto in MV3 per evitare che il SW venga terminato.
// Un alarm periodico ogni 20s fa una piccola operazione che mantiene il SW attivo.
// Viene attivato solo durante la registrazione per non sprecare risorse.

function startKeepalive() {
  if (rec._keepaliveActive) return;
  rec._keepaliveActive = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 1/3 }); // ogni 20s
  console.log("[BG] Keepalive avviato");
}

function stopKeepalive() {
  rec._keepaliveActive = false;
  chrome.alarms.clear("keepalive");
  console.log("[BG] Keepalive fermato");
}

// L'alarm listener è il cuore del keepalive: basta che esista e faccia qualcosa
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Una piccola operazione I/O è sufficiente per segnalare attività al browser
    chrome.storage.session.get(STORAGE_KEY, () => {
      // Solo per tenere vivo il SW — nessuna logica necessaria qui
    });
  }
});

/* ── PERSISTENZA STATO ──────────────────────── */

/**
 * Salva lo stato critico su chrome.storage.session.
 * Chiamato ogni volta che rec cambia.
 * Esclude recorderPort (non serializzabile) e _pendingTabId (transitorio).
 */
function getSerializableState() {
  return {
    status:           rec.status,
    startTime:        rec.startTime,
    accumulatedMs:    rec.accumulatedMs,
    resumeTime:       rec.resumeTime,
    subtitlesByLang:  rec.subtitlesByLang,
    subtitleCounters: rec.subtitleCounters,
    pageTitle:        rec.pageTitle,
    pageUrl:          rec.pageUrl,
    recorderWindowId: rec.recorderWindowId,
    _pendingTabId:    rec._pendingTabId,
  };
}

function estimateBytes(obj) {
  try {
    return new Blob([JSON.stringify(obj)]).size;
  } catch {
    return 0;
  }
}

function notifyPersistFailure(message) {
  if (rec._storagePersistWarned) return;
  rec._storagePersistWarned = true;
  push({ type: "error", message });
}

async function persistState() {
  const state = getSerializableState();
  const estimatedBytes = estimateBytes(state);
  if (estimatedBytes > STORAGE_SOFT_LIMIT_BYTES) {
    notifyPersistFailure("Spazio sessione quasi esaurito: rimuovi alcuni sottotitoli.");
    console.warn("[BG] Stato troppo grande per storage.session:", estimatedBytes, "bytes");
    return false;
  }

  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
    rec._storagePersistWarned = false;
    return true;
  } catch (err) {
    console.warn("[BG] Errore persistenza stato:", err);
    notifyPersistFailure("Errore salvataggio sessione: i nuovi dati potrebbero andare persi.");
    return false;
  }
}

/**
 * Ripristina lo stato da chrome.storage.session.
 * Chiamato all'avvio del SW e prima di ogni operazione critica.
 */
async function restoreState() {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const saved  = result[STORAGE_KEY];
    if (!saved) return;

    rec.status           = saved.status           ?? "idle";
    rec.startTime        = saved.startTime        ?? 0;
    rec.accumulatedMs    = saved.accumulatedMs    ?? 0;
    rec.resumeTime       = saved.resumeTime       ?? 0;
    rec.subtitlesByLang  = saved.subtitlesByLang  ?? {};
    rec.subtitleCounters = saved.subtitleCounters ?? {};
    rec.pageTitle        = saved.pageTitle        ?? "";
    rec.pageUrl          = saved.pageUrl          ?? "";
    rec.recorderWindowId = saved.recorderWindowId ?? null;
    rec._pendingTabId    = saved._pendingTabId    ?? null;

    // Se c'era una registrazione in corso quando il SW è morto,
    // il timer è congelato: aggiustiamo il resumeTime al momento attuale
    // in modo che getCurrentMs() restituisca un valore sensato.
    if (rec.status === "recording") {
      // Non possiamo sapere quanto tempo è passato mentre il SW era morto
      // (il MediaRecorder nella finestra recorder ha continuato a girare).
      // Resettiamo resumeTime a ora: il timer ripartirà da accumulatedMs.
      rec.resumeTime = Date.now();
      console.warn("[BG] SW riavviato durante recording — il timer è stato resettato al momento attuale");
    }

    console.log("[BG] Stato ripristinato da storage:", rec.status);
  } catch (err) {
    console.warn("[BG] Errore ripristino stato:", err);
  }
}

/* ── AVVIO SW: ripristina subito lo stato ───── */
// Questo blocco gira ogni volta che Chrome fa partire il service worker.
// È essenziale per la race condition: se il recorder è già aperto e si
// riconnette, trova lo stato corretto invece di "idle".
restoreState().then(() => {
  // Se c'era una registrazione attiva, riavvia il keepalive
  if (rec.status === "recording" || rec.status === "paused") {
    startKeepalive();
  }
});

/* ── POPUP → apri finestra recorder ────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openRecorderWindow") {
    openRecorderWindow(msg.tabId, msg.pageTitle, msg.pageUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // risposta asincrona
  }
});

async function openRecorderWindow(tabId, pageTitle, pageUrl) {
  // Se la finestra esiste già, portala in primo piano
  if (rec.recorderWindowId !== null) {
    try {
      await chrome.windows.update(rec.recorderWindowId, { focused: true });
      return;
    } catch {
      rec.recorderWindowId = null;
    }
  }

  resetSessionState();
  rec.pageTitle     = pageTitle;
  rec.pageUrl       = pageUrl;
  rec._pendingTabId = tabId;
  await persistState();

  const win = await chrome.windows.create({
    url:    chrome.runtime.getURL("recorder.html"),
    type:   "popup",
    width:  600,
    height: 860,
    top:    60,
    left:   60,
  });
  rec.recorderWindowId = win.id;
  await persistState();
}

function resetSessionState() {
  rec.status = "idle";
  rec.startTime = 0;
  rec.accumulatedMs = 0;
  rec.resumeTime = 0;
  rec.subtitlesByLang = {};
  rec.subtitleCounters = {};
  rec._storagePersistWarned = false;
}

chrome.windows.onRemoved.addListener(async (wid) => {
  if (wid === rec.recorderWindowId) {
    rec.recorderWindowId = null;
    if (rec.status === "recording" || rec.status === "paused") {
      stopRecording();
    }
    await persistState();
  }
});

/* ── LONG-LIVED PORT ────────────────────────── */
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== "recorder-port") return;

  // Ripristina lo stato prima di rispondere: gestisce il caso in cui
  // il SW si è riavviato mentre recorder.html era già aperto.
  await restoreState();

  rec.recorderPort = port;
  port.postMessage({ type: "init", state: getState() });
  port.onMessage.addListener(handleMsg);
  port.onDisconnect.addListener(() => {
    rec.recorderPort = null;
    // Non fermiamo il keepalive qui: la finestra potrebbe solo ricaricarsi
  });
});

async function handleMsg(msg) {
  switch (msg.action) {
    case "start":             await startCapture();                          break;
    case "recordingStarted":  await onRecordingStarted();                    break;
    case "pause":             await pauseRec();                              break;
    case "resume":            await resumeRec();                             break;
    case "stop":              await stopRecording();                         break;
    case "recordingStopped":  rec.status = "stopped"; await persistState(); push(); break;
    case "addSubtitle":       await addSubtitle(msg.text, msg.lang || "IT", msg.startMs, msg.endMs); break;
    case "removeSubtitle":    await removeSubtitle(msg.lang, msg.index);     break;
    case "requestDownloadVtt":     await downloadVtt(msg.lang);                  break;
    case "requestDownloadSrt":     await downloadSrt(msg.lang);                  break;
    case "requestDownloadPreview": await downloadPreview();                       break;
  }
}

/* ── CAPTURE ────────────────────────────────── */
async function startCapture() {
  try {
    const streamId = await new Promise((res, rej) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: rec._pendingTabId },
        (id) => {
          if (chrome.runtime.lastError || !id)
            rej(new Error(chrome.runtime.lastError?.message || "Stream non disponibile"));
          else
            res(id);
        }
      );
    });
    push({ type: "streamId", streamId });
  } catch (err) {
    push({ type: "error", message: err.message });
  }
}

/* ── RECORDING STATE ────────────────────────── */
async function onRecordingStarted() {
  rec.status           = "recording";
  rec.startTime        = Date.now();
  rec.resumeTime       = rec.startTime;
  rec.accumulatedMs    = 0;
  rec.subtitlesByLang  = {};
  rec.subtitleCounters = {};
  startKeepalive();
  await persistState();
  push();
}

async function pauseRec() {
  if (rec.status !== "recording") return;
  rec.accumulatedMs += Date.now() - rec.resumeTime;
  rec.status = "paused";
  await persistState();
  push();
}

async function resumeRec() {
  if (rec.status !== "paused") return;
  rec.resumeTime = Date.now();
  rec.status = "recording";
  await persistState();
  push();
}

async function stopRecording() {
  if (rec.status === "recording") rec.accumulatedMs += Date.now() - rec.resumeTime;
  rec.status = "stopped";
  stopKeepalive();
  await persistState();
  push();
}

/* ── SUBTITLES ──────────────────────────────── */
async function addSubtitle(text, lang, startMs, endMs) {
  if (!text || (rec.status !== "recording" && rec.status !== "paused")) return;
  if (!rec.subtitlesByLang[lang])  rec.subtitlesByLang[lang]  = [];
  if (!rec.subtitleCounters[lang]) rec.subtitleCounters[lang] = 0;

  // startMs e endMs vengono dal frontend (recorder.js) che ha la visione
  // più precisa del timing reale. Il background li accetta direttamente.
  // Guardia: durata minima 500ms per evitare sottotitoli impercettibili.
  const MIN_DURATION_MS = 500;
  const safeStart = startMs ?? getCurrentMs();
  const safeEnd   = Math.max((endMs ?? safeStart), safeStart + MIN_DURATION_MS);

  const nextIndex = rec.subtitleCounters[lang] + 1;
  const subtitle = {
    index:   nextIndex,
    startMs: safeStart,
    endMs:   safeEnd,
    text:    text.trim(),
    lang,
  };

  rec.subtitleCounters[lang] = nextIndex;
  rec.subtitlesByLang[lang].push(subtitle);
  const saved = await persistState();
  if (!saved) {
    rec.subtitlesByLang[lang].pop();
    rec.subtitleCounters[lang] = Math.max(0, nextIndex - 1);
    return;
  }
  push();
}

async function removeSubtitle(lang, index) {
  if (!rec.subtitlesByLang[lang]) return;
  const original = rec.subtitlesByLang[lang];
  rec.subtitlesByLang[lang] = original.filter((s) => s.index !== index);
  const saved = await persistState();
  if (!saved) {
    rec.subtitlesByLang[lang] = original;
    return;
  }
  push();
}

/* ── VTT DOWNLOAD ───────────────────────────── */
async function downloadVtt(lang) {
  const subs = rec.subtitlesByLang[lang];
  if (!subs || !subs.length) {
    push({ type: "toast", message: "Nessun sottotitolo per " + lang });
    return;
  }
  const langNames = { IT:"Italiano",EN:"Inglese",FR:"Francese",DE:"Tedesco",
                      ES:"Spagnolo",PT:"Portoghese",ZH:"Cinese",JA:"Giapponese" };
  const langName = langNames[lang] || lang;
  const content  = buildVtt(subs, lang, langName);
  const dataUrl  = "data:text/vtt;charset=utf-8," + encodeURIComponent(content);
  const filename = sanitize(rec.pageTitle) + "_subtitles_" + lang.toLowerCase() + ".vtt";
  await triggerDownload(dataUrl, filename, "VTT");
}

/* ── SRT DOWNLOAD ───────────────────────────── */
async function downloadSrt(lang) {
  const subs = rec.subtitlesByLang[lang];
  if (!subs || !subs.length) {
    push({ type: "toast", message: "Nessun sottotitolo per " + lang });
    return;
  }
  const content  = buildSrt(subs);
  const dataUrl  = "data:text/srt;charset=utf-8," + encodeURIComponent(content);
  const filename = sanitize(rec.pageTitle) + "_subtitles_" + lang.toLowerCase() + ".srt";
  await triggerDownload(dataUrl, filename, "SRT");
}

/* ── HTML PREVIEW DOWNLOAD ──────────────────── */
async function downloadPreview() {
  const base     = sanitize(rec.pageTitle);
  const content  = buildPreviewHtml(base, rec.subtitlesByLang, rec.pageTitle, rec.pageUrl);
  const dataUrl  = "data:text/html;charset=utf-8," + encodeURIComponent(content);
  const filename = base + "_preview.html";
  await triggerDownload(dataUrl, filename, "Preview HTML");
}


/* ── SRT BUILDER ────────────────────────────── */
/**
 * Genera un file SRT (SubRip) dal array di sottotitoli.
 * SRT è supportato nativamente da Windows Media Player, VLC, e quasi tutti
 * i player desktop. Non supporta stile CSS — testo puro.
 * Formato timestamp: HH:MM:SS,mmm --> HH:MM:SS,mmm  (virgola, non punto)
 */
async function triggerDownload(url, filename, label) {
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(chrome.runtime.lastError?.message || "Download non avviato"));
          return;
        }
        resolve(downloadId);
      });
    });
    push({ type: "toast", message: `${label} salvato: ${filename}` });
  } catch (err) {
    console.warn(`[BG] Errore download ${label}:`, err);
    push({ type: "error", message: `Download ${label} fallito: ${err.message}` });
  }
}

function buildSrt(subs) {
  return subs.map((s, i) => [
    String(i + 1),
    srtTime(s.startMs) + " --> " + srtTime(s.endMs),
    s.text,
    "",
  ].join("\n")).join("\n");
}

function srtTime(ms) {
  const h   = Math.floor(ms / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000)   / 1000);
  const mil = ms % 1000;
  return `${p(h)}:${p(m)}:${p(s)},${String(mil).padStart(3, "0")}`;
}

/* ── HTML PREVIEW BUILDER ───────────────────── */
/**
 * Genera una pagina HTML autonoma che carica WebM + VTT tramite tag <video>.
 * Va aperta con Chrome dalla stessa cartella dove si trovano i file.
 * I path sono relativi — nessuna dipendenza esterna.
 * Supporta più lingue con selettore, e ::cue con sfondo reale.
 */
function buildPreviewHtml(base, subtitlesByLang, pageTitle, pageUrl) {
  const langs = Object.keys(subtitlesByLang).filter(l => subtitlesByLang[l].length > 0);
  const langNames = { IT:"Italiano",EN:"Inglese",FR:"Francese",DE:"Tedesco",
                      ES:"Spagnolo",PT:"Portoghese",ZH:"Cinese",JA:"Giapponese" };
  const trackTags = langs.map((l, i) => {
    const vtt = buildVtt(subtitlesByLang[l], l, langNames[l] || l);
    const src = "data:text/vtt;charset=utf-8," + encodeURIComponent(vtt);
    return `  <track kind="subtitles" src="${src}" srclang="${l.toLowerCase()}" label="${l}"${i === 0 ? " default" : ""}>`;
  }).join("\n");

  const langButtons = langs.length > 1 ? `
    <div class="lang-bar">
      ${langs.map(l => `<button onclick="selectLang('${l}')">${l}</button>`).join("")}
      <button onclick="selectLang('')">Off</button>
    </div>` : "";

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(pageTitle)} — Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #111;
    color: #e8eaf0;
    font-family: Arial, Helvetica, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: 24px 16px;
    gap: 16px;
  }
  h1 { font-size: 16px; font-weight: 600; color: #a0a8c0; text-align: center; max-width: 800px; }
  .url { font-size: 11px; color: #606880; text-align: center; word-break: break-all; max-width: 800px; }
  video { width: 100%; max-width: 960px; border-radius: 8px; background: #000; outline: none; }
  video::cue {
    color: #ffffff;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 1.1em;
    font-weight: bold;
  }
  video::cue(.bg) {
    background-color: rgba(90,90,90,0.72);
  }
  .lang-bar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .lang-bar button {
    padding: 6px 16px; border-radius: 20px; border: 1px solid #404860;
    background: #1e2235; color: #a0a8c0; font-size: 13px; cursor: pointer; transition: all .15s;
  }
  .lang-bar button:hover { background: #2a3050; border-color: #f5a623; color: #f5a623; }
  .note { font-size: 11px; color: #505870; text-align: center; max-width: 600px; line-height: 1.6; }
  code { background: #1e2235; padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>
<h1>${escHtml(pageTitle)}</h1>
<div class="url">${escHtml(pageUrl)}</div>
<video controls>
  <source src="${base}_tutorial.webm" type="video/webm">
${trackTags}
</video>
${langButtons}
<p class="note">
  Apri con <strong>Chrome</strong> dalla stessa cartella di <code>${base}_tutorial.webm</code>.<br>
  I sottotitoli sono incorporati direttamente in questa preview HTML.<br>
  Generato da TechSnap &middot; ${new Date().toLocaleString("it-IT")}
</p>
<script>
function selectLang(code) {
  const tracks = document.querySelector('video').textTracks;
  for (const t of tracks) t.mode = (t.language === code.toLowerCase()) ? 'showing' : 'disabled';
}
document.querySelector('video').addEventListener('loadedmetadata', () => {
  const tracks = document.querySelector('video').textTracks;
  if (tracks.length > 0) tracks[0].mode = 'showing';
});
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escVttText(s) {
  return String(s || "")
    .replace(/\r?\n+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildVtt(subs, langCode, langName) {
  const lines = ["WEBVTT", ""];
  lines.push("NOTE");
  lines.push("TechSnap");
  lines.push("Lingua: " + langName + " (" + langCode + ")");
  lines.push("Pagina: " + rec.pageTitle);
  lines.push("URL: "    + rec.pageUrl);
  lines.push("Generato: " + new Date().toISOString());
  lines.push("");
  // Stile CSS per i cue: testo bianco + sfondo grigio semi-trasparente.
  // Lo sfondo è applicato solo ai cue con classe ".bg".
  lines.push("STYLE");
  lines.push("::cue {");
  lines.push("  color: #ffffff;");
  lines.push("  font-family: Arial, Helvetica, sans-serif;");
  lines.push("  font-size: 1.1em;");
  lines.push("  font-weight: bold;");
  lines.push("}");
  lines.push("::cue(.bg) {");
  lines.push("  background-color: rgba(90,90,90,0.72);");
  lines.push("}");
  lines.push("");
  subs.forEach((s) => {
    lines.push(String(s.index));
    lines.push(vttTime(s.startMs) + " --> " + vttTime(s.endMs));
    lines.push("<c.bg>" + escVttText(s.text) + "</c>");
    lines.push("");
  });
  return lines.join("\n");
}

/* ── UTILITIES ──────────────────────────────── */
function getCurrentMs() {
  if (rec.status === "paused" || rec.status === "stopped") return rec.accumulatedMs;
  return rec.accumulatedMs + (Date.now() - rec.resumeTime);
}

function getState() {
  return {
    status:          rec.status,
    currentMs:       getCurrentMs(),
    accumulatedMs:   rec.accumulatedMs,
    resumeTime:      rec.resumeTime,
    subtitlesByLang: rec.subtitlesByLang,
    pageTitle:       rec.pageTitle,
    pageUrl:         rec.pageUrl,
  };
}

function push(override) {
  if (!rec.recorderPort) return;
  try {
    rec.recorderPort.postMessage(override || { type: "stateUpdate", state: getState() });
  } catch { /* porta chiusa — nessuna azione */ }
}

function vttTime(ms) {
  const h   = Math.floor(ms / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000)   / 1000);
  const mil = ms % 1000;
  return `${p(h)}:${p(m)}:${p(s)}.${String(mil).padStart(3, "0")}`;
}

function p(n) { return String(n).padStart(2, "0"); }

function sanitize(name) {
  return (name || "tutorial")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 80);
}

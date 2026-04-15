/**
 * recorder.js — Tutorial Recorder Pro v3
 *
 * NOVITÀ:
 * - Sottotitoli multilingua: ogni lingua è una traccia VTT indipendente
 * - Lingua attiva selezionabile via tab (default: IT), aggiungibili altre
 * - Modalità input: TASTIERA (Ctrl+Enter) e VOCE (Web Speech API)
 *   → la dettatura usa la lingua attiva come lingua di riconoscimento
 * - Export: un .vtt per ogni lingua con almeno un sottotitolo
 * - Lista sottotitoli filtrabile per lingua
 */
"use strict";

/* ── CONFIGURAZIONE LINGUE ─────────────────────
   Mappa codice → label, nome, codice BCP-47 per SpeechRecognition
─────────────────────────────────────────────── */
const LANG_CONFIG = {
  IT: { label:"IT", name:"Italiano",   speechCode:"it-IT" },
  EN: { label:"EN", name:"Inglese",    speechCode:"en-US" },
  FR: { label:"FR", name:"Francese",   speechCode:"fr-FR" },
  DE: { label:"DE", name:"Tedesco",    speechCode:"de-DE" },
  ES: { label:"ES", name:"Spagnolo",   speechCode:"es-ES" },
  PT: { label:"PT", name:"Portoghese", speechCode:"pt-PT" },
  ZH: { label:"ZH", name:"Cinese",     speechCode:"zh-CN" },
  JA: { label:"JA", name:"Giapponese", speechCode:"ja-JP" },
};

/* ── STATO LOCALE ───────────────────────────── */
const local = {
  port:           null,   // chrome.runtime.Port
  mediaRecorder:  null,
  chunks:         [],
  videoBlob:      null,
  status:         "idle",
  /** @type {Object.<string, Array>} langCode → [{index,startMs,endMs,text,lang}] */
  subtitlesByLang: {},
  pageTitle: "", pageUrl: "",
  activeLangs:  ["IT"],   // lingue abilitate in questa sessione
  currentLang:  "IT",     // lingua attiva per input
  listFilter:   "ALL",    // filtro lista ("ALL" o codice lingua)
  inputMode:    "keyboard", // "keyboard" | "voice"
  recognition:  null,     // SpeechRecognition instance
  isListening:  false,
  voiceInterim: "",       // testo interim (in arrivo)
  voiceFinal:   "",       // testo finale (confermato, da aggiungere)
  rafHandle:    null,
  lastKnownMs:  0,
  lastUpdateAt: 0,
  privacyAccepted: false,
  voiceDisclosureAccepted: false,

  /**
   * TIMESTAMP IBRIDO
   *
   * Modalità TASTIERA (Opzione B):
   *   kbdStartMs  — impostato al click di "Segna inizio" (F2 / bottone dedicato).
   *                 null = nessun inizio segnato, usa il momento del click Aggiungi.
   *   kbdMarkActive — true quando il marker è attivo (evidenziazione UI)
   *
   * Modalità VOCE (Opzione A):
   *   voiceStartMs — impostato al primo evento onresult (primo suono riconosciuto).
   *                  Si azzera ad ogni "Aggiungi Testo" confermato.
   */
  kbdStartMs:    null,    // ms registrazione al momento del marker tastiera
  kbdMarkActive: false,   // mostra feedback visivo nel bottone marker
  voiceStartMs:  null,    // ms registrazione al primo interim vocale
};

const PRIVACY_ACK_KEY = "trp_privacy_ack_v1";
const VOICE_ACK_KEY   = "trp_voice_ack_v1";

/* ── DOM REFS ───────────────────────────────── */
const $  = (id) => document.getElementById(id);
const ui = {
  overlay:         $("connectingOverlay"),
  pageTitle:       $("pageTitle"),
  pageUrl:         $("pageUrl"),
  timerDisplay:    $("timerDisplay"),
  recBadge:        $("recBadge"),
  recStatus:       $("recStatus"),
  subCount:        $("subCount"),
  btnStart:        $("btnStart"),
  btnPause:        $("btnPause"),
  btnStop:         $("btnStop"),
  langTabs:        $("langTabs"),
  btnAddLang:      $("btnAddLang"),
  modeBtnKeyboard: $("modeBtnKeyboard"),
  modeBtnVoice:    $("modeBtnVoice"),
  modeKeyboard:    $("modeKeyboard"),
  modeVoice:       $("modeVoice"),
  btnMarkStart:    $("btnMarkStart"),   // bottone "Segna Inizio" (tastiera)
  subtitleText:    $("subtitleText"),
  btnAddSub:       $("btnAddSub"),
  voiceStatusBox:  $("voiceStatusBox"),
  voiceInterim:    $("voiceInterim"),
  voiceFinal:      $("voiceFinal"),
  voiceHint:       $("voiceHint"),
  btnVoiceToggle:  $("btnVoiceToggle"),
  btnVoiceAdd:     $("btnVoiceAdd"),
  subLangFilter:   $("subLangFilter"),
  subList:         $("subList"),
  subEmpty:        $("subEmpty"),
  subListWrap:     $("subListWrap"),
  btnExportVideo:  $("btnExportVideo"),
  vttLangExports:  $("vttLangExports"),
  toast:           $("toast"),
};

/**
 * Restituisce il tempo corrente della registrazione in ms,
 * interpolando tra l'ultimo stateUpdate ricevuto dal background e adesso.
 * Usato per catturare startMs/endMs lato recorder (più preciso del background
 * che riceve il messaggio con un delay di round-trip).
 */
function getLocalMs() {
  if (local.status === "paused") return local.lastKnownMs;
  if (local.status !== "recording") return 0;
  return local.lastKnownMs + (Date.now() - local.lastUpdateAt);
}

/**
 * Aggiorna l'aspetto del bottone "Segna Inizio" in base allo stato del marker.
 * Quando il marker è attivo, il bottone diventa verde e mostra il timestamp.
 */
function updateKbdMarkerUI() {
  if (!ui.btnMarkStart) return;
  if (local.kbdMarkActive && local.kbdStartMs !== null) {
    ui.btnMarkStart.classList.add("marker-active");
    ui.btnMarkStart.innerHTML =
      svgMarker() + " " + formatTime(local.kbdStartMs);
    ui.btnMarkStart.title = "Inizio segnato a " + formatTime(local.kbdStartMs) + " — premi F2 per aggiornare";
  } else {
    ui.btnMarkStart.classList.remove("marker-active");
    ui.btnMarkStart.innerHTML = svgMarker() + " Segna Inizio";
    ui.btnMarkStart.title = "Segna il momento di inizio del sottotitolo (F2)";
  }
}

/* ── INIT ───────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  loadPrivacyAcknowledgements();
  connectToBackground();
  initSpeechRecognition();
  bindEvents();
  renderLangTabs();
  renderSubLangFilter();
});

/* ── BACKGROUND CONNECTION ──────────────────── */

/**
 * Connette (o riconnette) al service worker background.
 * La finestra recorder può sopravvivere al background SW che viene
 * ucciso da Chrome dopo ~30s di inattività. Quando ciò accade:
 *   1. onDisconnect scatta
 *   2. mostriamo l'overlay "Connettendo…"
 *   3. riproviamo ogni 500ms finché non riceviamo "init"
 *   4. al primo "init" nascosdiamo l'overlay e ripristiniamo lo stato
 */
function connectToBackground() {
  // Mostra overlay durante ogni tentativo di connessione/riconnessione
  ui.overlay.classList.remove("hidden");

  try {
    local.port = chrome.runtime.connect({ name: "recorder-port" });
  } catch (e) {
    // chrome.runtime non disponibile (estensione invalidata/aggiornata)
    console.error("Impossibile connettersi al background:", e);
    setTimeout(connectToBackground, 1000);
    return;
  }

  local.port.onMessage.addListener(onBackgroundMessage);
  local.port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "disconnesso";
    console.warn("Background disconnesso:", err, "— riconnessione in 500ms");
    local.port = null;
    // Mostra overlay e riprova
    ui.overlay.classList.remove("hidden");
    setTimeout(connectToBackground, 500);
  });
}

async function onBackgroundMessage(msg) {
  switch (msg.type) {
    case "init":        applyState(msg.state); ui.overlay.classList.add("hidden"); break;
    case "stateUpdate": applyState(msg.state); break;
    case "streamId":    await initMediaRecorder(msg.streamId); break;
    case "triggerVideoDownload": downloadVideoBlob(msg.filename); break;
    case "toast":  showToast(msg.message); break;
    case "error":  showToast(msg.message, "error"); break;
  }
}

/**
 * Applica lo stato del background all'UI.
 * background.js ora manda subtitlesByLang (mappa langCode → array).
 */
function applyState(s) {
  local.status          = s.status;
  local.subtitlesByLang = s.subtitlesByLang || {};
  local.pageTitle       = s.pageTitle || "";
  local.pageUrl         = s.pageUrl   || "";
  local.lastKnownMs     = s.currentMs || 0;
  local.lastUpdateAt    = Date.now();

  ui.pageTitle.textContent = local.pageTitle || "—";
  ui.pageUrl.textContent   = local.pageUrl   || "—";
  ui.subCount.textContent  = getTotalSubCount();

  // Sincronizza lingue attive con quelle presenti nel background
  Object.keys(local.subtitlesByLang).forEach((l) => {
    if (!local.activeLangs.includes(l)) local.activeLangs.push(l);
  });

  renderLangTabs();
  renderSubLangFilter();
  renderSubtitleList();
  updateUI();

  if (s.status === "recording") startLocalTimer();
  else { stopLocalTimer(); updateTimerDisplay(local.lastKnownMs); }

  if (s.status === "stopped") {
    ui.btnExportVideo.disabled = (local.videoBlob === null);
    renderVttExportButtons();
  }
}

/* ── MEDIA RECORDER ─────────────────────────── */
async function initMediaRecorder(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource:"tab", chromeMediaSourceId:streamId, maxWidth:1920, maxHeight:1080, maxFrameRate:30 } },
      audio: { mandatory: { chromeMediaSource:"tab", chromeMediaSourceId:streamId } },
    });

    const mimeType = getBestMimeType();
    local.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    local.chunks = []; local.videoBlob = null;

    local.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) local.chunks.push(e.data);
    };

    local.mediaRecorder.onstop = async () => {
      send({ action: "recordingStopped" });
      ui.btnExportVideo.disabled    = true;
      ui.btnExportVideo.textContent = "⏳ Elaborazione…";
      try {
        local.videoBlob = await fixWebM(new Blob(local.chunks, { type: mimeType }));
        ui.btnExportVideo.innerHTML = svgDownload() + " Scarica Video (.webm)";
        ui.btnExportVideo.disabled  = false;
        showToast("Registrazione completata.");
      } catch (err) {
        console.error("[onstop]", err);
        local.videoBlob = new Blob(local.chunks, { type: mimeType });
        ui.btnExportVideo.disabled = false;
        showToast("Export pronto (fix EBML non applicato)", "warn");
      }
    };

    local.mediaRecorder.start(1000);
    send({ action: "recordingStarted" });

  } catch (err) {
    showToast("Impossibile avviare: " + err.message, "error");
  }
}

/* ── SPEECH RECOGNITION ─────────────────────── */
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    ui.modeBtnVoice.disabled = true;
    ui.modeBtnVoice.title = "Web Speech API non disponibile in questo browser";
    return;
  }
  local.recognition = new SR();
  local.recognition.continuous     = true;   // non si ferma dopo ogni frase
  local.recognition.interimResults  = true;   // testo in tempo reale mentre parla
  local.recognition.maxAlternatives = 1;

  local.recognition.onstart = () => { local.isListening = true;  updateVoiceUI(); };
  local.recognition.onend   = () => { local.isListening = false; updateVoiceUI(); };

  local.recognition.onerror = (e) => {
    if (e.error === "no-speech") return;
    local.isListening = false;
    updateVoiceUI();
    if (e.error === "not-allowed") showToast("Permesso microfono negato", "error");
    else showToast("Errore riconoscimento: " + e.error, "warn");
  };

  local.recognition.onresult = (e) => {
    let interim = "";
    let final   = local.voiceFinal;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += (final ? " " : "") + t.trim();
      else interim += t;
    }

    // OPZIONE A: cattura startMs al primo risultato vocale (interim o final).
    // Questo è il momento oggettivo in cui l'utente ha iniziato a parlare.
    // Si imposta una sola volta per sessione di dettatura (non si sovrascrive
    // se il riconoscimento continua).
    if (local.voiceStartMs === null && (interim || final)) {
      local.voiceStartMs = getLocalMs();
    }

    local.voiceInterim = interim;
    local.voiceFinal   = final;
    updateVoiceTextDisplay();
    ui.btnVoiceAdd.disabled = !local.voiceFinal.trim();
  };
}

function updateSpeechLang() {
  if (local.recognition) {
    local.recognition.lang = LANG_CONFIG[local.currentLang]?.speechCode || "it-IT";
  }
}

function toggleListening() {
  if (!local.recognition) return;
  if (!local.isListening && !ensureVoiceDisclosureAccepted()) return;
  if (local.isListening) {
    local.recognition.stop();
  } else {
    // Reset di tutto il testo e del timestamp di inizio per la nuova sessione
    local.voiceInterim = "";
    local.voiceFinal   = "";
    local.voiceStartMs = null;   // verrà catturato al primo suono riconosciuto
    updateVoiceTextDisplay();
    updateSpeechLang();
    local.recognition.start();
  }
}

function updateVoiceUI() {
  const active = local.status === "recording" || local.status === "paused";
  ui.btnVoiceToggle.disabled = !active;
  if (local.isListening) {
    ui.btnVoiceToggle.classList.add("listening");
    ui.btnVoiceToggle.innerHTML = svgMicOff() + " Stop ascolto";
    ui.voiceStatusBox.classList.add("listening");
  } else {
    ui.btnVoiceToggle.classList.remove("listening");
    ui.btnVoiceToggle.innerHTML = svgMic() + " Ascolta";
    ui.voiceStatusBox.classList.remove("listening");
  }
}

function updateVoiceTextDisplay() {
  ui.voiceInterim.textContent = local.voiceInterim || (local.isListening ? "In ascolto…" : "Premi Ascolta per iniziare…");
  ui.voiceFinal.textContent   = local.voiceFinal   || "";
}

/* ── RECORDING CONTROLS ─────────────────────── */
function onStartRecording() {
  if (!ensureCaptureDisclosureAccepted()) return;
  send({ action: "start" });
}

function loadPrivacyAcknowledgements() {
  try {
    local.privacyAccepted = localStorage.getItem(PRIVACY_ACK_KEY) === "1";
    local.voiceDisclosureAccepted = localStorage.getItem(VOICE_ACK_KEY) === "1";
  } catch {
    local.privacyAccepted = false;
    local.voiceDisclosureAccepted = false;
  }
}

function ensureCaptureDisclosureAccepted() {
  if (local.privacyAccepted) return true;
  const ok = window.confirm(
    "Privacy e trattamento dati:\n\n" +
    "- L'estensione registra audio/video del tab attivo solo quando premi Avvia.\n" +
    "- URL, titolo pagina e sottotitoli vengono usati per esportare i file.\n" +
    "- I dati restano locali (browser/download), senza invio a server del produttore.\n\n" +
    "Vuoi continuare?"
  );
  if (!ok) return false;
  local.privacyAccepted = true;
  try { localStorage.setItem(PRIVACY_ACK_KEY, "1"); } catch { /* ignore */ }
  return true;
}

function ensureVoiceDisclosureAccepted() {
  if (local.voiceDisclosureAccepted) return true;
  const ok = window.confirm(
    "Dettatura vocale:\n\n" +
    "Il riconoscimento vocale usa Web Speech API del browser/sistema.\n" +
    "L'audio del microfono puo essere trattato dal relativo servizio.\n\n" +
    "Vuoi abilitare la modalita voce?"
  );
  if (!ok) return false;
  local.voiceDisclosureAccepted = true;
  try { localStorage.setItem(VOICE_ACK_KEY, "1"); } catch { /* ignore */ }
  return true;
}

function onTogglePause() {
  if (local.status === "recording") {
    if (local.isListening) local.recognition?.stop();
    local.mediaRecorder?.pause();
    send({ action: "pause" });
  } else if (local.status === "paused") {
    local.mediaRecorder?.resume();
    send({ action: "resume" });
  }
}

function onStopRecording() {
  if (!local.mediaRecorder) return;
  if (local.isListening) local.recognition?.stop();
  send({ action: "stop" });
  local.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  local.mediaRecorder.stop();
}

/* ── LANG MANAGEMENT ────────────────────────── */
function selectLang(code) {
  local.currentLang = code;
  if (!local.activeLangs.includes(code)) local.activeLangs.push(code);
  updateSpeechLang();
  renderLangTabs();
  renderSubLangFilter();
  renderSubtitleList();
  updateVoiceTextDisplay();
  showToast("Lingua: " + (LANG_CONFIG[code]?.name || code));
}

function onAddLang() {
  const available = Object.entries(LANG_CONFIG)
    .filter(([c]) => !local.activeLangs.includes(c))
    .map(([c, v]) => `${v.label} — ${v.name}`)
    .join("\n");
  const codes = Object.keys(LANG_CONFIG).filter((c) => !local.activeLangs.includes(c));
  if (!codes.length) { showToast("Tutte le lingue sono già attive", "warn"); return; }
  const input = prompt("Lingue disponibili:\n" + available + "\n\nInserisci il codice (es. EN):");
  if (!input) return;
  const code = input.trim().toUpperCase();
  if (!LANG_CONFIG[code]) { showToast("Codice non riconosciuto: " + code, "error"); return; }
  selectLang(code);
}

/* ── SUBTITLE INPUT ─────────────────────────── */

/**
 * MODALITÀ TASTIERA — Opzione B
 * L'utente preme F2 (o il bottone dedicato) per segnare l'inizio del sottotitolo,
 * poi scrive il testo, poi clicca Aggiungi (o Ctrl+Enter) per chiudere.
 *
 * Se l'utente NON ha premuto F2, startMs = endMs = momento del click Aggiungi
 * (comportamento precedente come fallback silenzioso).
 */
function onMarkStart() {
  if (local.status !== "recording" && local.status !== "paused") return;
  local.kbdStartMs    = getLocalMs();
  local.kbdMarkActive = true;
  updateKbdMarkerUI();
  showToast("Inizio sottotitolo segnato — scrivi il testo e premi Aggiungi");
}

function onAddSubtitleKeyboard() {
  const text = ui.subtitleText.value.trim();
  if (!text) { showToast("Scrivi prima il testo", "warn"); return; }

  // endMs = adesso (click Aggiungi)
  const endMs   = getLocalMs();
  // startMs = marker F2 se presente, altrimenti stesso momento di fine
  // (sottotitolo puntuale, durata 0 → il background assegnerà un minimo)
  const startMs = local.kbdStartMs ?? endMs;

  submitSubtitle(text, startMs, endMs);
  ui.subtitleText.value = "";
  ui.subtitleText.focus();

  // Reset marker
  local.kbdStartMs    = null;
  local.kbdMarkActive = false;
  updateKbdMarkerUI();
}

/**
 * MODALITÀ VOCE — Opzione A
 * startMs = primo risultato vocale (catturato automaticamente in onresult)
 * endMs   = click "Aggiungi Testo"
 */
function onAddSubtitleVoice() {
  const text = local.voiceFinal.trim();
  if (!text) { showToast("Nessun testo riconosciuto", "warn"); return; }

  const endMs   = getLocalMs();
  const startMs = local.voiceStartMs ?? endMs;

  submitSubtitle(text, startMs, endMs);

  // Reset stato vocale
  local.voiceFinal   = "";
  local.voiceInterim = "";
  local.voiceStartMs = null;
  updateVoiceTextDisplay();
  ui.btnVoiceAdd.disabled = true;
}

/**
 * Invia il sottotitolo al background con startMs e endMs espliciti.
 * Il background non calcola più i timestamp: li riceve dal frontend
 * che è l'unico a conoscere il timing reale (via getLocalMs).
 */
function submitSubtitle(text, startMs, endMs) {
  if (local.status !== "recording" && local.status !== "paused") return;
  send({
    action: "addSubtitle",
    text,
    lang:    local.currentLang,
    startMs,
    endMs,
  });
}

function onRemoveSubtitle(lang, index) {
  send({ action: "removeSubtitle", lang, index });
}

/* ── EXPORT ─────────────────────────────────── */
function onExportVideo() {
  downloadVideoBlob(sanitizeFilename(local.pageTitle) + "_tutorial.webm");
}

function onExportVtt(langCode) {
  const subs = local.subtitlesByLang[langCode] || [];
  if (!subs.length) { showToast("Nessun sottotitolo per " + langCode, "warn"); return; }
  send({ action: "requestDownloadVtt", lang: langCode });
}

function onExportSrt(langCode) {
  const subs = local.subtitlesByLang[langCode] || [];
  if (!subs.length) { showToast("Nessun sottotitolo per " + langCode, "warn"); return; }
  send({ action: "requestDownloadSrt", lang: langCode });
}

function onExportPreview() {
  const total = getTotalSubCount();
  if (!total) { showToast("Nessun sottotitolo — aggiungi almeno un testo prima", "warn"); return; }
  send({ action: "requestDownloadPreview" });
}

function downloadVideoBlob(filename) {
  if (!local.videoBlob) { showToast("Nessun video disponibile", "warn"); return; }
  const url = URL.createObjectURL(local.videoBlob);
  const a   = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  showToast("Video salvato: " + filename);
}

/* ── LOCAL TIMER (RAF) ──────────────────────── */
function startLocalTimer() {
  stopLocalTimer();
  const tick = () => {
    if (local.status !== "recording") return;
    updateTimerDisplay(local.lastKnownMs + (Date.now() - local.lastUpdateAt));
    local.rafHandle = requestAnimationFrame(tick);
  };
  local.rafHandle = requestAnimationFrame(tick);
}
function stopLocalTimer() {
  if (local.rafHandle) { cancelAnimationFrame(local.rafHandle); local.rafHandle = null; }
}
function updateTimerDisplay(ms) {
  ui.timerDisplay.textContent = formatTime(ms);
}

/* ── EVENT BINDING ──────────────────────────── */
function bindEvents() {
  ui.btnStart.addEventListener("click",        onStartRecording);
  ui.btnPause.addEventListener("click",        onTogglePause);
  ui.btnStop.addEventListener("click",         onStopRecording);
  ui.btnAddLang.addEventListener("click",      onAddLang);
  ui.btnMarkStart.addEventListener("click",    onMarkStart);
  ui.btnAddSub.addEventListener("click",       onAddSubtitleKeyboard);
  ui.btnExportVideo.addEventListener("click",  onExportVideo);
  ui.btnVoiceToggle.addEventListener("click",  toggleListening);
  ui.btnVoiceAdd.addEventListener("click",     onAddSubtitleVoice);
  ui.modeBtnKeyboard.addEventListener("click", () => setInputMode("keyboard"));
  ui.modeBtnVoice.addEventListener("click",    () => setInputMode("voice"));

  // Tastiera:  Ctrl+Enter = Aggiungi,  F2 = Segna Inizio
  ui.subtitleText.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); onAddSubtitleKeyboard(); }
  });
  // F2 globale (funziona anche quando il focus è sul tab della pagina registrata,
  // purché la finestra recorder abbia il focus — non possiamo catturare F2
  // sulla pagina target senza content script, ma la finestra recorder è sempre
  // accessibile con un click)
  document.addEventListener("keydown", (e) => {
    if (e.key === "F2") { e.preventDefault(); onMarkStart(); }
  });
}

/* ── UI STATE MACHINE ───────────────────────── */
function setInputMode(mode) {
  local.inputMode = mode;
  ui.modeBtnKeyboard.classList.toggle("active", mode === "keyboard");
  ui.modeBtnVoice.classList.toggle("active",    mode === "voice");
  ui.modeKeyboard.style.display = mode === "keyboard" ? "block" : "none";
  ui.modeVoice.style.display    = mode === "voice"    ? "block" : "none";
  if (mode === "keyboard" && local.isListening) local.recognition?.stop();
  updateVoiceUI();
}

function updateUI() {
  const s = local.status;
  const active = s === "recording" || s === "paused";
  ui.recBadge.className     = "rec-badge" + (s==="recording"?" active":s==="paused"?" paused":"");
  ui.recStatus.textContent  = s==="recording"?"REC":s==="paused"?"PAUSA":s==="stopped"?"STOP":"IDLE";
  ui.timerDisplay.className = "timer" + (s==="recording"?" recording":s==="paused"?" paused":"");
  ui.btnStart.disabled  = (s === "recording" || s === "paused");
  ui.btnPause.disabled  = !active;
  ui.btnStop.disabled   = s === "idle" || s === "stopped";
  ui.btnAddSub.disabled = !active;
  ui.btnMarkStart.disabled = !active;
  ui.btnPause.innerHTML = s==="paused" ? svgPlay()+" Riprendi" : svgPause()+" Pausa";
  updateVoiceUI();
}

function renderLangTabs() {
  ui.langTabs.innerHTML = "";
  local.activeLangs.forEach((code) => {
    const btn = document.createElement("button");
    btn.className = "lang-tab" + (code === local.currentLang ? " active" : "");
    btn.textContent = LANG_CONFIG[code]?.label || code;
    btn.title = LANG_CONFIG[code]?.name || code;
    btn.addEventListener("click", () => selectLang(code));
    ui.langTabs.appendChild(btn);
  });
}

function renderSubLangFilter() {
  ui.subLangFilter.innerHTML = "";
  const makePill = (label, value) => {
    const p = document.createElement("span");
    p.className = "sub-lang-pill" + (local.listFilter === value ? " active" : "");
    p.textContent = label; p.dataset.lang = value;
    p.addEventListener("click", () => { local.listFilter = value; renderSubLangFilter(); renderSubtitleList(); });
    ui.subLangFilter.appendChild(p);
  };
  makePill("Tutte", "ALL");
  local.activeLangs.forEach((c) => makePill(LANG_CONFIG[c]?.label || c, c));
}

function renderSubtitleList() {
  ui.subList.innerHTML = "";
  let items = [];
  if (local.listFilter === "ALL") {
    Object.entries(local.subtitlesByLang).forEach(([lang, subs]) =>
      subs.forEach((s) => items.push({ ...s, lang })));
  } else {
    (local.subtitlesByLang[local.listFilter] || []).forEach((s) =>
      items.push({ ...s, lang: local.listFilter }));
  }
  items.sort((a, b) => a.startMs - b.startMs);

  if (!items.length) { ui.subEmpty.style.display = "block"; return; }
  ui.subEmpty.style.display = "none";

  items.forEach((sub) => {
    const el = document.createElement("div");
    el.className = "sub-item";
    el.innerHTML = `
      <span class="sub-lang-badge">${escapeHtml(sub.lang)}</span>
      <span class="sub-time">${formatTime(sub.startMs)}</span>
      <span class="sub-text">${escapeHtml(sub.text)}</span>
      <button class="sub-del" title="Rimuovi">×</button>`;
    el.querySelector(".sub-del").addEventListener("click", () => onRemoveSubtitle(sub.lang, sub.index));
    ui.subList.appendChild(el);
  });
  ui.subListWrap.scrollTop = ui.subListWrap.scrollHeight;
}

function renderVttExportButtons() {
  ui.vttLangExports.innerHTML = "";
  const langs = Object.entries(local.subtitlesByLang).filter(([,s]) => s.length > 0).map(([l]) => l);
  if (!langs.length) {
    ui.vttLangExports.innerHTML = '<span class="export-hint">Nessun sottotitolo da esportare.</span>';
    return;
  }

  // Per ogni lingua: bottone VTT + bottone SRT affiancati
  langs.forEach((code) => {
    const n    = local.subtitlesByLang[code].length;
    const label = (LANG_CONFIG[code]?.label || code);
    const count = `<span style="opacity:.6;font-size:9px">(${n})</span>`;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:5px;align-items:center";

    const btnVtt = document.createElement("button");
    btnVtt.className = "btn-vtt-lang";
    btnVtt.innerHTML = svgDownload() + ` VTT ${label} ${count}`;
    btnVtt.title = "WebVTT — per Chrome/Firefox e ffmpeg";
    btnVtt.addEventListener("click", () => onExportVtt(code));

    const btnSrt = document.createElement("button");
    btnSrt.className = "btn-vtt-lang";
    btnSrt.style.cssText = "background:rgba(99,102,241,.12);border-color:#3730a3;color:#818cf8";
    btnSrt.innerHTML = svgDownload() + ` SRT ${label} ${count}`;
    btnSrt.title = "SubRip SRT — per Windows Media Player e VLC";
    btnSrt.addEventListener("click", () => onExportSrt(code));

    row.appendChild(btnVtt);
    row.appendChild(btnSrt);
    ui.vttLangExports.appendChild(row);
  });

  // Bottone Preview HTML — unico, genera pagina per tutte le lingue
  const btnPreview = document.createElement("button");
  btnPreview.className = "btn-vtt-lang";
  btnPreview.style.cssText = "margin-top:4px;background:rgba(16,185,129,.1);border-color:#065f46;color:#34d399;width:100%";
  btnPreview.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg> Preview HTML (apri con Chrome)`;
  btnPreview.title = "Genera una pagina HTML con player video + sottotitoli stilizzati";
  btnPreview.addEventListener("click", onExportPreview);
  ui.vttLangExports.appendChild(btnPreview);
}

/* ── UTILITIES ──────────────────────────────── */
function getTotalSubCount() {
  return Object.values(local.subtitlesByLang).reduce((n, a) => n + a.length, 0);
}
function send(msg) {
  if (!local.port) { console.warn("send() ignorato: porta non connessa"); return; }
  try { local.port.postMessage(msg); } catch(e) { console.error("send() fallito:", e); }
}
function getBestMimeType() {
  return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}
function formatTime(ms) {
  const t = Math.floor((ms||0)/1000);
  return [Math.floor(t/3600),Math.floor((t%3600)/60),t%60].map((v)=>String(v).padStart(2,"0")).join(":");
}
function sanitizeFilename(n) {
  return (n||"tutorial").replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").replace(/\s+/g,"_").substring(0,80);
}
function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function showToast(msg, type="info") {
  const colors={info:"#e8eaf0",warn:"#f5a623",error:"#e05252"};
  ui.toast.textContent=msg; ui.toast.style.color=colors[type]||colors.info;
  ui.toast.classList.add("show");
  setTimeout(()=>ui.toast.classList.remove("show"),2800);
}
// SVG helpers
const svgPlay    = () => `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg>`;
const svgPause   = () => `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const svgDownload= () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const svgMic     = () => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>`;
const svgMicOff  = () => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v4M8 23h8"/></svg>`;
const svgMarker  = () => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;

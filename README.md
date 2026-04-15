# TechSnap — Chrome Extension

Registra video tutorial direttamente dal browser con sottotitoli VTT sincronizzati.

## Installazione (modalità sviluppatore)

1. Apri Chrome e vai su `chrome://extensions/`
2. Attiva **"Modalità sviluppatore"** (toggle in alto a destra)
3. Clicca **"Carica estensione non pacchettizzata"**
4. Seleziona la cartella `tutorial-recorder-extension`
5. L'icona apparirà nella barra degli strumenti

## Utilizzo

1. Naviga sulla pagina che vuoi registrare
2. Clicca l'icona dell'estensione
3. Premi **Avvia** — Chrome chiederà il permesso di acquisire lo schermo
4. Durante la registrazione:
   - Scrivi un testo nell'area sottotitoli e premi **Aggiungi Sottotitolo** (o `Ctrl+Enter`)
   - Il timestamp viene acquisito automaticamente
   - Usa **Pausa** / **Riprendi** quando necessario
5. Premi **Stop** per terminare
6. Scarica il video (`.webm`) e/o i sottotitoli (`.vtt`)

## Note tecniche importanti

### Formato video
Il browser Chromium genera video in formato **WebM** (codec VP8/VP9 + Opus audio).
Il file è riproducibile su tutti i browser moderni e su VLC.

Per convertire in MP4/H.264:
```bash
ffmpeg -i tutorial.webm -c:v libx264 -c:a aac tutorial.mp4
```

### File VTT
Il file di sottotitoli è in formato [WebVTT](https://www.w3.org/TR/webvtt1/) standard,
compatibile con HTML5 `<video>`, VLC, e la maggior parte dei player.

Per caricare i sottotitoli in HTML:
```html
<video controls>
  <source src="tutorial.webm" type="video/webm">
  <track kind="subtitles" src="tutorial_subtitles.vtt" srclang="it" label="Italiano" default>
</video>
```

### Timestamp e pause
Il timer esclude automaticamente i periodi in pausa.
I timestamp VTT riflettono il tempo reale di registrazione.

## Struttura file
```
tutorial-recorder-extension/
├── manifest.json      # Configurazione estensione (MV3)
├── popup.html         # UI principale
├── popup.js           # Logica recording, VTT, export
├── background.js      # Service worker (tabCapture API)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Privacy e compliance Chrome Web Store

- Privacy policy del progetto: `PRIVACY_POLICY.md`
- Disclosure in-app:
  - consenso esplicito prima dell'avvio registrazione
  - consenso separato prima dell'uso della modalita voce (Web Speech API)
- Trattamento dati: locale (browser + download) senza backend applicativo del produttore.

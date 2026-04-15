/**
 * popup.js — Launcher
 *
 * Il popup ha un solo compito: leggere le info del tab corrente e chiedere
 * al background di aprire la finestra recorder separata.
 * Tutta la logica di registrazione vive in background.js + recorder.js.
 */

"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");

  try {
    // Recupera il tab attivo nella finestra corrente
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      statusEl.textContent = "Nessun tab attivo trovato.";
      return;
    }

    statusEl.textContent = "Apertura pannello di registrazione…";

    // Delega al background worker che aprirà recorder.html come finestra separata
    const response = await chrome.runtime.sendMessage({
      action:    "openRecorderWindow",
      tabId:     tab.id,
      pageTitle: tab.title || "(senza titolo)",
      pageUrl:   tab.url   || "",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Impossibile aprire il pannello di registrazione.");
    }

    // Il popup può chiudersi: la finestra recorder è indipendente
    window.close();

  } catch (err) {
    statusEl.textContent = "Errore: " + err.message;
    console.error(err);
  }
});

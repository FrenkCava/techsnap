# Privacy Policy - TechSnap

Last updated: 2026-04-14

## Summary
TechSnap records the active browser tab only after an explicit user action (`Start`).
The extension is designed for local processing and local export of recordings/subtitles.

## Data processed
- Active tab title and URL (to label exports).
- Audio/video stream of the selected tab during recording.
- Subtitle text entered by the user (keyboard or voice dictation result).
- Temporary recorder state in browser session storage.

## How data is used
- To run the core feature: recording tutorials and exporting `.webm`, `.vtt`, `.srt`, and preview HTML files.
- To show recording metadata (page title/url) inside the recorder window and exported files.

## Data sharing and transfer
- No custom backend is used by this extension.
- No user data is transmitted to the developer's servers.
- Data stays in the browser context and user download folder, except browser/platform services used by built-in APIs.

## Voice input disclosure
Voice mode uses the browser Web Speech API.
Depending on browser/platform implementation, microphone audio may be processed by the browser's speech recognition service.
Users can avoid this by not enabling voice mode.

## Storage and retention
- Temporary state is stored in `chrome.storage.session` and may persist during the browser session.
- Exported files are saved only when the user explicitly requests download.
- Removing the extension removes extension-local data managed by Chrome.

## Permissions rationale
- `activeTab`: access to the tab explicitly chosen by user action.
- `tabCapture`: capture audio/video of the selected tab.
- `downloads`: save exported media/subtitle files.
- `alarms`: keep service worker alive during active recording.
- `storage`: store temporary recorder state and reliability metadata.

## Contact
For privacy requests, provide a support contact in your Chrome Web Store listing.

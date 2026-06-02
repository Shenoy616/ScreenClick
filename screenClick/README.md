# ScreenClick

A Chrome extension for QA testers. Capture screenshots while exploring a page via:

- Double-click anywhere on the page (visible-tab mode only)
- Keyboard shortcut (Ctrl+Shift+S, or Cmd+Shift+S on Mac)
- Timer (every N seconds)

Choose what to capture on each session: the visible browser tab, the full scrolled page, or the entire screen. Each capture is marked with a green ring at the click location (visible-tab mode), then compiled into a single PDF when you stop the session.

## Architecture

Manifest V3 extension with five moving parts:

- **popup** — Start, Stop, Save, Discard, target picker, Settings link
- **content script** — Listens for double-clicks, tracks mouse, renders the green ring and on-page recording indicator, handles full-page scroll orchestration
- **service worker** — State machine, capture queue (rate-limited), timer, keyboard command, download trigger
- **offscreen document** — Hosts jsPDF, stitches full-page tiles, holds the screen MediaStream
- **launcher window** — Tiny popup window opened only for screen-mode start; calls the desktopCapture picker reliably (the regular popup cannot, due to focus-loss closing it)

## Capture Modes

**Visible tab.** Captures the current viewport of the active tab. Fastest path; all three standard triggers (double-click, keyboard, timer) work. Cannot capture chrome:// pages or the Chrome Web Store.

**Process Record.** Step-by-step capture mode for documenting workflows. Every click on the page is captured as a labeled step. Each PDF page shows "Step N: <action label>" (e.g., "Step 3: Clicked button: Submit Order") above the screenshot. The element under the click is identified by aria-label, visible text, placeholder, or name attribute, in that order. Triggers: click (with an "only interactive elements" filter), form-input change on blur, keyboard shortcut, and timer. Configure in Settings → Process Record Mode.

**Full page.** Scrolls the page in viewport-height steps, captures each tile, then stitches the tiles into one tall image on a canvas in the offscreen document. Each full-page capture takes a few seconds depending on page length. Sticky and fixed-position elements are temporarily hidden during capture so they don't appear in every tile. Capped at 30 tiles or 32000px height for safety. Keyboard and timer triggers only.

**Entire screen.** Uses `chrome.desktopCapture.chooseDesktopMedia` to let the user pick a screen or window. Because Manifest V3 service workers cannot reliably show the picker, and popups close when focus shifts, this mode opens a small launcher window that shows the picker, sends the streamId back to the service worker, then closes itself. Once selected, the screen MediaStream stays open for the whole session. Keyboard and timer triggers only.

## How to Install (Developer Mode)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select this folder.
5. Pin the extension icon to your toolbar.

## How to Use

1. Open the page you want to QA (any normal http or https page).
2. Click the extension icon.
3. Click **Start Capturing**, then choose a capture mode: Visible Tab, Process Record, Full Page, or Entire Screen.
   - For Entire Screen, a small "Setting up screen capture" window appears, then Chrome's screen picker dialog. Choose a screen or window.
   - For Process Record, the on-page indicator says "QA PROCESS RECORDING" and every click on an interactive element captures a step.
4. Once recording, the badge on the icon turns red. For visible-tab and process modes, a "QA RECORDING" indicator appears on the page.
5. Trigger captures via your chosen triggers (configurable in Settings).
6. Click the extension icon again, click **Stop and Save PDF**, type a filename, click **Save PDF**.
7. The browser save dialog opens.

## Process Record Details

Each click on an interactive element (button, link, input, anything with role=button or tabindex) becomes a numbered step in the PDF. The element is identified in priority order: `aria-label`, `title`, visible text (under 60 chars), `placeholder`, `name`, or `value`. Categorization gives you labels like:

- `Step 1: Clicked button: Submit Order`
- `Step 2: Clicked link: Pricing`
- `Step 3: Typed in input: email: "user@acme.com"`
- `Step 4: Manual step 4` (keyboard shortcut, no click target)

Configure in Settings → Process Record Mode:

- **Click**: capture on every click (debounced to 250ms)
- **Only interactive elements**: ignore plain-text clicks; capture only buttons, links, inputs, role=button
- **Form input change**: capture when the user leaves a text field after typing in it (on blur)
- **Keyboard shortcut**: Ctrl+Shift+S also produces a step labeled "Manual step N"
- **Timer**: periodic capture for long processes

## Triggers (Settings page)

Click **Settings** at the bottom of the popup to:

- Toggle each trigger
- Set the timer interval (2 to 600 seconds)
- Adjust image quality

Note: double-click triggers only work in visible-tab mode. In full-page or entire-screen modes, only the keyboard shortcut and the timer fire captures.

## Rebinding the Keyboard Shortcut

Chrome does not let extensions set the shortcut directly. To change it:

1. Go to `chrome://extensions/shortcuts`
2. Find "ScreenClick"
3. Click the pencil icon next to "Capture screenshot during recording"
4. Press your new combination

## Known Limitations

- Visible-tab and full-page modes cannot capture chrome:// pages or the Chrome Web Store (Chrome blocks this)
- Maximum capture rate is roughly 1.5/sec across all modes (Chrome's API limit)
- Full-page capture on pages with infinite scroll, complex animations, or large dynamic content may produce imperfect stitches
- Full-page max height is 32000px; taller pages get truncated
- Screen-mode picker re-prompts the user once per session (when Start is clicked); the same stream is reused for all captures within that session
- Stopping the screen share from Chrome's "Sharing your screen" bar before clicking Stop will cause subsequent captures to fail

## File Structure

```
screenClick/
├── manifest.json
├── popup/         (Start/Stop/Save UI, target picker)
├── options/       (Settings page)
├── background/    (Service worker)
├── content/       (Click ring, indicator, full-page scroll handler)
├── offscreen/     (PDF build, tile stitching, screen-stream consumer)
├── launcher/      (One-shot window for desktopCapture picker)
├── lib/           (jsPDF 2.5.2 UMD build)
└── icons/         (16/48/128 PNG icons)
```

## Troubleshooting

Open `chrome://extensions`, find **ScreenClick**, and click **service worker** (or **Inspect views: offscreen.html**) to see console logs prefixed with `[QA Tool]`.

Common issues:

- **"Cannot capture this page"** — On a chrome:// or chrome-extension:// URL. Switch to a normal site, or use Entire Screen mode (which works regardless of the active tab).
- **Screen picker doesn't appear** — Check that no other extension is intercepting `desktopCapture`. Try clicking the launcher window if it appears but seems frozen.
- **Full-page capture looks misaligned** — Some pages do unusual things during scroll (lazy loading, parallax). Try increasing the settle time by editing FULLPAGE_TILE_SETTLE_MS in `background/service-worker.js`.
- **PDF download doesn't open the save dialog** — Open the offscreen document inspector to see jsPDF errors.

## For Distribution

This extension is designed to be distributed via Chrome Web Store as **Unlisted** for internal teams. To prepare:

1. Zip the contents of this folder (not the folder itself).
2. Register a Chrome Web Store developer account ($5 one-time fee).
3. Upload as Unlisted on the dashboard.
4. Write permission justifications for sensitive permissions: `desktopCapture`, `<all_urls>`, `tabs`. Be specific about the QA use case.
5. Host a one-page privacy policy stating that all data stays on-device, no network calls, no analytics.
6. Share the install link with your QA team.

All data processing happens locally on the user's machine. No screenshots, page content, or telemetry are sent anywhere.

# ScreenClick

Chrome extension that captures clicks, form fills, and pages into a labeled PDF. This repo contains the extension source and its marketing landing page.

## Repository layout

| Path | Purpose |
|------|---------|
| [`screenClick/`](screenClick/) | Manifest V3 Chrome extension — load this folder in Chrome |
| [`landing-page/`](landing-page/) | Static marketing site and `screenclick.zip` for end-user download |

## Install the extension (development)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `screenClick/` folder.
4. Pin the extension icon to your toolbar.

See [`screenClick/README.md`](screenClick/README.md) for capture modes, settings, and troubleshooting.

## Update the download zip

After changing the extension, rebuild the zip served from the landing page:

```bash
cd /path/to/ScreenClick
rm -f landing-page/screenclick.zip
zip -r landing-page/screenclick.zip screenClick -x "*.DS_Store" -x "*/.DS_Store"
```

The archive includes a top-level `screenClick/` folder so users can unzip and load it directly. For Chrome Web Store upload, zip the *contents* of `screenClick/` instead (see the extension README).

## Landing page

Open `landing-page/index.html` locally or deploy the `landing-page/` folder to any static host. Keep `screenclick.zip` in that folder in sync with the extension when you release.

## Privacy

All capture and PDF generation runs on-device. No network calls, analytics, or remote storage.

// Offscreen document. Runs in a real DOM context so it has access to
// Image, Canvas, navigator.mediaDevices, and the jsPDF library.
//
// Handles three tasks:
//   1. BUILD_PDF_OFFSCREEN        — assemble screenshots into a PDF
//   2. STITCH_TILES               — combine full-page scroll tiles into one
//   3. START/STOP_SCREEN_STREAM, CAPTURE_SCREEN_FRAME — desktop capture

const { jsPDF } = window.jspdf;

// State for the active screen-capture stream (kept for whole session in
// screen mode so we don't re-prompt the user per capture).
let screenStream = null;
let screenVideoEl = null;

// Buffer used to ensure freshness between calls; resets on RESET_STITCH_BUFFER.
let _stitchSeq = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    try {
      let result;
      switch (msg.type) {
        case 'BUILD_PDF_OFFSCREEN':
          result = { ok: true, dataUrl: await buildPdf(msg.screenshots, msg.settings) };
          break;
        case 'STITCH_TILES':
          result = { ok: true, dataUrl: await stitchTiles(msg) };
          break;
        case 'RESET_STITCH_BUFFER':
          _stitchSeq++;
          result = { ok: true };
          break;
        case 'START_SCREEN_STREAM':
          await startScreenStream(msg.streamId);
          result = { ok: true };
          break;
        case 'STOP_SCREEN_STREAM':
          stopScreenStream();
          result = { ok: true };
          break;
        case 'CAPTURE_SCREEN_FRAME':
          result = { ok: true, dataUrl: await captureScreenFrame(msg.quality || 0.8) };
          break;
        default:
          result = { ok: false, error: 'Unknown offscreen message: ' + msg.type };
      }
      sendResponse(result);
    } catch (e) {
      console.error('[QA Tool offscreen] failed:', msg.type, e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async sendResponse
});

// ---------- PDF building ----------

async function buildPdf(screenshots, settings) {
  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'pt',
    format: 'a4',
    compress: true,
  });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 20;

  // Detect whether this is a process-record session: at least one screenshot
  // carries a stepNumber. Layout grows a step-label band above the screenshot.
  const isProcess = screenshots.some((s) => s.stepNumber);
  const headerH = 18;
  const stepBandH = isProcess ? 26 : 0;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2 - headerH - stepBandH;

  for (let i = 0; i < screenshots.length; i++) {
    const shot = screenshots[i];
    if (i > 0) pdf.addPage();

    // Top-line metadata in muted gray. Format:
    //   "Screenshot N of M  -  <timestamp>  -  <page url>"
    // If we don't have a page URL (rare for visible/process modes; possible
    // for screen mode), fall back to just the timestamp.
    pdf.setFontSize(9);
    pdf.setTextColor(140);
    const stamp = new Date(shot.timestamp).toLocaleString();
    const base = `Screenshot ${i + 1} of ${screenshots.length}  -  ${stamp}`;
    let headerText;
    if (shot.pageUrl) {
      const baseWidth = pdf.getTextWidth(base + '  -  ');
      const maxUrlWidth = (pageW - margin * 2) - baseWidth;
      const urlFitted = fitText(pdf, shot.pageUrl, maxUrlWidth);
      headerText = `${base}  -  ${urlFitted}`;
    } else {
      headerText = base;
    }
    pdf.text(headerText, margin, margin);

    // Step band: "Step N: <action label>" in stronger ink.
    let imgY = margin + headerH;
    if (isProcess) {
      const step = shot.stepNumber || (i + 1);
      const label = shot.actionLabel || 'Capture';
      pdf.setFontSize(13);
      pdf.setTextColor(20);
      pdf.setFont(undefined, 'bold');
      const stepText = `Step ${step}:`;
      pdf.text(stepText, margin, margin + headerH + 12);
      pdf.setFont(undefined, 'normal');
      pdf.setTextColor(60);
      // Width of "Step N: " so we can place the action label right after.
      const stepTextWidth = pdf.getTextWidth(stepText + ' ');
      // Truncate long labels so they fit on one line.
      const maxLabelWidth = availW - stepTextWidth;
      const truncated = fitText(pdf, label, maxLabelWidth);
      pdf.text(truncated, margin + stepTextWidth, margin + headerH + 12);
      imgY = margin + headerH + stepBandH;
    }

    const { width: imgW, height: imgH } = await loadImageDims(shot.dataUrl);
    const ratio = Math.min(availW / imgW, availH / imgH);
    const w = imgW * ratio;
    const h = imgH * ratio;
    const x = (pageW - w) / 2;
    pdf.addImage(shot.dataUrl, 'JPEG', x, imgY, w, h);
  }

  const raw = pdf.output('datauristring');
  const b64 = raw.split(',')[1] || '';
  return 'data:application/pdf;base64,' + b64;
}

function fitText(pdf, text, maxWidth) {
  if (pdf.getTextWidth(text) <= maxWidth) return text;
  // Binary-trim with an ellipsis suffix.
  const ellipsis = '...';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + ellipsis;
    if (pdf.getTextWidth(candidate) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function loadImageDims(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = dataUrl;
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image decode failed'));
    img.src = dataUrl;
  });
}

// ---------- Full-page stitching ----------
//
// Each tile was captured at a known yOffset (in CSS pixels) with a known
// viewportHeight. captureVisibleTab returns the rasterized viewport at the
// device pixel ratio, so the tile image is potentially 2x or 3x the CSS
// dimensions on hidpi displays. We assemble into a single canvas sized to
// totalHeight * dpr, drawing each tile at yOffset * dpr.
//
// Tiles can overlap (the last tile usually does because we can't scroll
// past the bottom). Later tiles drawn on top is fine — the overlap area
// has the same pixels in either tile.

async function stitchTiles({ tiles, totalHeight, viewportHeight, devicePixelRatio, quality }) {
  if (!tiles || tiles.length === 0) throw new Error('No tiles to stitch.');

  // Load all tiles in parallel.
  const images = await Promise.all(tiles.map((t) => loadImage(t.dataUrl)));

  // Each tile's pixel dimensions tell us the actual DPR used by the browser.
  // Use the first tile's pixel width relative to viewport CSS width to compute.
  // We don't have viewport CSS width here, so we trust devicePixelRatio.
  const dpr = devicePixelRatio || 1;

  // Width comes from the first tile (all viewports are same width).
  const widthPx = images[0].naturalWidth;
  const heightPx = Math.round(totalHeight * dpr);

  // Cap the canvas height to prevent runaway memory on huge pages.
  // 32000 px is well under the browser max canvas size on modern Chrome.
  const MAX_PX = 32000;
  const finalHeight = Math.min(heightPx, MAX_PX);

  const canvas = new OffscreenCanvas(widthPx, finalHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, finalHeight);

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const img = images[i];
    const dstY = Math.round(tile.yOffset * dpr);
    if (dstY >= finalHeight) break;
    ctx.drawImage(img, 0, dstY);
  }

  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: Math.max(0.3, Math.min(1.0, quality || 0.8)),
  });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Stitched image FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ---------- Screen capture via desktopCapture ----------

async function startScreenStream(streamId) {
  if (screenStream) stopScreenStream();
  if (!streamId) throw new Error('No stream ID provided.');

  // Chrome accepts the legacy "mandatory" constraints for desktop streams.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxWidth: 3840,
        maxHeight: 2160,
      },
    },
  });
  screenStream = stream;

  // Attach to a video element so we can sample frames.
  screenVideoEl = document.createElement('video');
  screenVideoEl.autoplay = true;
  screenVideoEl.muted = true;
  screenVideoEl.playsInline = true;
  screenVideoEl.srcObject = stream;
  document.body.appendChild(screenVideoEl);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Video stream did not start (timeout).')), 5000);
    screenVideoEl.onloadedmetadata = () => {
      clearTimeout(t);
      screenVideoEl.play().then(resolve).catch(reject);
    };
  });

  // If the user stops sharing from the Chrome bar, the track ends. We don't
  // tear down the offscreen doc here; the SW handles that on Stop/Discard.
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    chrome.runtime.sendMessage({ type: 'SCREEN_STREAM_ENDED' }).catch(() => {});
  });
}

function stopScreenStream() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (screenVideoEl) {
    try { screenVideoEl.pause(); } catch {}
    screenVideoEl.srcObject = null;
    screenVideoEl.remove();
    screenVideoEl = null;
  }
}

async function captureScreenFrame(quality) {
  if (!screenVideoEl || !screenStream) throw new Error('Screen stream not started.');
  const w = screenVideoEl.videoWidth;
  const h = screenVideoEl.videoHeight;
  if (!w || !h) throw new Error('Screen video has no dimensions yet.');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(screenVideoEl, 0, 0, w, h);

  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: Math.max(0.3, Math.min(1.0, quality)),
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Signal ready so SW knows we're up.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

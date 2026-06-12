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
          result = { ok: true, dataUrl: await buildPdf(msg.screenshots, msg.settings, msg.session) };
          break;
        case 'STITCH_TILES':
          result = { ok: true, dataUrl: await stitchTiles(msg) };
          break;
        case 'RESET_STITCH_BUFFER':
          _stitchSeq++;
          result = { ok: true };
          break;
        case 'PING_OFFSCREEN':
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

function formatUtcTimestamp(ts) {
  if (typeof ts === 'string' && ts.endsWith('Z')) return `${ts} UTC`;
  return `${new Date(ts).toISOString()} UTC`;
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexFromDataUrl(dataUrl) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(digest);
}

async function sha256HexFromText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

async function buildCaptureManifest(screenshots) {
  const entries = [];
  let chainHash = '0'.repeat(64);

  for (let i = 0; i < screenshots.length; i++) {
    const shot = screenshots[i];
    const imageSha256 = await sha256HexFromDataUrl(shot.dataUrl);
    const entry = {
      n: i + 1,
      utc: shot.timestampUtc || new Date(shot.timestamp).toISOString(),
      url: shot.pageUrl || null,
      source: shot.source || 'manual',
      step: shot.stepNumber || null,
      label: shot.actionLabel || null,
      imageSha256,
    };
    chainHash = await sha256HexFromText(`${chainHash}|${JSON.stringify(entry)}`);
    entries.push({ ...entry, chainHash });
  }

  return { entries, chainRoot: chainHash };
}

async function signManifest(manifest) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const manifestJson = JSON.stringify(manifest);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(manifestJson)
  );
  const publicKey = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    manifestJson,
    manifestSha256: await sha256HexFromText(manifestJson),
    signatureHex: bytesToHex(signature),
    publicKeyJwk: JSON.stringify(publicKey),
  };
}

const ATTEST_STYLE = {
  banner: [20, 20, 19],
  headerFill: [243, 241, 234],
  border: [232, 230, 220],
  text: [20, 20, 19],
  muted: [90, 90, 85],
  white: [250, 249, 245],
  subtle: [232, 230, 220],
  accent: [217, 119, 87],
};

function attestRgb(pdf, rgb) {
  pdf.setFillColor(rgb[0], rgb[1], rgb[2]);
}

function attestStroke(pdf, rgb) {
  pdf.setDrawColor(rgb[0], rgb[1], rgb[2]);
}

function attestText(pdf, rgb) {
  pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
}

function formatUtcShort(iso) {
  return formatUtcTimestamp(iso).replace(' UTC', '');
}

function splitMono(pdf, text, maxWidth, fontSize) {
  pdf.setFont('courier', 'normal');
  pdf.setFontSize(fontSize);
  return pdf.splitTextToSize(String(text || '—'), Math.max(20, maxWidth - 10));
}

function measureTableRowHeight(lineCount, lineH, topPad, bottomPad, minH = 22) {
  return Math.max(minH, topPad + lineCount * lineH + bottomPad);
}

function ensureAttestSpace(pdf, y, needed, margin, pageH, onNewPage) {
  if (y + needed <= pageH - margin - 28) return y;
  pdf.addPage();
  if (onNewPage) onNewPage();
  return margin + 8;
}

function drawAttestBanner(pdf, margin, contentW, y) {
  const bannerH = 54;
  attestRgb(pdf, ATTEST_STYLE.accent);
  pdf.rect(margin, y, contentW, bannerH, 'F');
  pdf.setFont(undefined, 'bold');
  pdf.setFontSize(17);
  attestText(pdf, ATTEST_STYLE.white);
  pdf.text('Session Attestation Certificate', margin + 14, y + 22);
  pdf.setFont(undefined, 'normal');
  pdf.setFontSize(8.5);
  attestText(pdf, ATTEST_STYLE.white);
  pdf.text('Uni Capture  ·  On-device export  ·  Cryptographic integrity record', margin + 14, y + 38);
  return y + bannerH + 12;
}

function drawAttestSectionTitle(pdf, title, margin, y, contentW) {
  y += 16;

  pdf.setFont(undefined, 'bold');
  pdf.setFontSize(10);
  attestText(pdf, ATTEST_STYLE.text);
  pdf.text(title, margin, y);

  const lineY = y + 6;
  attestStroke(pdf, ATTEST_STYLE.border);
  pdf.setLineWidth(0.5);
  pdf.line(margin, lineY, margin + contentW, lineY);

  return lineY + 10;
}

function drawKeyValueTable(pdf, margin, y, contentW, rows, pageH) {
  const labelW = Math.min(148, contentW * 0.28);
  const valueW = contentW - labelW;
  const rowPad = 8;
  const lineH = 10;
  const fontSize = 8;

  rows.forEach(([label, value], idx) => {
    pdf.setFont('courier', 'normal');
    const valueLines = splitMono(pdf, value, valueW, fontSize);
    pdf.setFont(undefined, 'normal');
    const labelLines = pdf.splitTextToSize(String(label), labelW - 10);
    const textTop = rowPad + 7;
    const rowH = measureTableRowHeight(
      Math.max(labelLines.length, valueLines.length),
      lineH,
      textTop,
      rowPad,
    );

    y = ensureAttestSpace(pdf, y, rowH + 4, margin, pageH, null);

    const fill = idx % 2 === 0 ? ATTEST_STYLE.white : ATTEST_STYLE.headerFill;
    attestRgb(pdf, fill);
    pdf.rect(margin, y, contentW, rowH, 'F');
    attestStroke(pdf, ATTEST_STYLE.border);
    pdf.setLineWidth(0.35);
    pdf.rect(margin, y, contentW, rowH, 'S');
    pdf.line(margin + labelW, y, margin + labelW, y + rowH);

    let ty = y + rowPad + 7;
    pdf.setFont(undefined, 'bold');
    pdf.setFontSize(fontSize);
    attestText(pdf, ATTEST_STYLE.muted);
    labelLines.forEach((line) => {
      pdf.text(line, margin + 8, ty);
      ty += lineH;
    });

    ty = y + rowPad + 7;
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(fontSize);
    attestText(pdf, ATTEST_STYLE.text);
    valueLines.forEach((line) => {
      pdf.text(line, margin + labelW + 8, ty);
      ty += lineH;
    });

    y += rowH;
  });

  return y + 8;
}

function drawAttestFooter(pdf, margin, pageW, pageH, contentBottomY) {
  pdf.setFont(undefined, 'italic');
  pdf.setFontSize(7);
  attestText(pdf, ATTEST_STYLE.muted);
  const note = 'This certificate is generated locally at PDF export. It supports integrity verification but is not a legal identity attestation. Timestamps use the system clock at capture time.';
  const lines = pdf.splitTextToSize(note, pageW - margin * 2);
  const blockH = lines.length * 8 + 4;
  let footerY = contentBottomY + 14;
  if (footerY + blockH > pageH - margin) {
    pdf.addPage();
    footerY = margin + 8;
  }
  lines.forEach((line, i) => {
    pdf.text(line, margin, footerY + i * 8);
  });
}

function addAttestationPage(pdf, attestation, margin) {
  pdf.addPage();
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - margin * 2;
  let y = margin;

  y = drawAttestBanner(pdf, margin, contentW, y);

  pdf.setFont(undefined, 'normal');
  pdf.setFontSize(8.5);
  attestText(pdf, ATTEST_STYLE.muted);
  const intro = (
    'This page records a tamper-evident session certificate. Captures are hashed (SHA-256), chained in order, '
    + 'and signed with ECDSA P-256 at export. No data leaves your device during this process.'
  );
  pdf.splitTextToSize(intro, contentW).forEach((line) => {
    pdf.text(line, margin, y);
    y += 11;
  });
  y += 10;

  y = drawAttestSectionTitle(pdf, 'Session summary', margin, y, contentW);
  y = drawKeyValueTable(pdf, margin, y, contentW, [
    ['Session start (UTC)', formatUtcShort(attestation.sessionStartUtc)],
    ['Session end (UTC)', formatUtcShort(attestation.sessionEndUtc)],
    ['Total captures', String(attestation.captureCount)],
    ['Record version', 'Uni Capture v1.0.0'],
  ], pageH);

  y = ensureAttestSpace(pdf, y, 36, margin, pageH, null);
  y = drawAttestSectionTitle(pdf, 'Cryptographic integrity', margin, y, contentW);
  y = drawKeyValueTable(pdf, margin, y, contentW, [
    ['Manifest SHA-256', attestation.manifestSha256],
    ['Chain root', attestation.chainRoot],
    ['Signature (ECDSA P-256)', attestation.signatureHex],
    ['Public key (JWK)', attestation.publicKeyJwk],
  ], pageH);

  drawAttestFooter(pdf, margin, pageW, pageH, y);
}

function processPointLabel(shot) {
  const label = (shot.actionLabel || '').trim();
  if (!label) return '';
  const src = shot.source || '';
  if (/^Manual step \d+$/i.test(label) && (src === 'manual' || src === 'process-keyboard' || src === 'keyboard')) {
    return '';
  }
  if (/^Periodic step \d+$/i.test(label) && (src === 'timer' || src === 'process-timer')) return '';
  if (label === 'Capture' && src === 'process-click') return '';
  return label;
}

async function buildPdf(screenshots, settings, sessionMeta = {}) {
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
    const stamp = formatUtcTimestamp(shot.timestampUtc || shot.timestamp);
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

    // Step band: "Step N: <Point text>" in stronger ink.
    let imgY = margin + headerH;
    if (isProcess) {
      const step = shot.stepNumber || (i + 1);
      const label = processPointLabel(shot);
      pdf.setFontSize(13);
      pdf.setTextColor(20);
      pdf.setFont(undefined, 'bold');
      const stepText = `Step ${step}:`;
      pdf.text(stepText, margin, margin + headerH + 12);
      if (label) {
        pdf.setFont(undefined, 'normal');
        pdf.setTextColor(60);
        // Width of "Step N: " so we can place the action label right after.
        const stepTextWidth = pdf.getTextWidth(stepText + ' ');
        // Truncate long labels so they fit on one line.
        const maxLabelWidth = availW - stepTextWidth;
        const truncated = fitText(pdf, label, maxLabelWidth);
        pdf.text(truncated, margin + stepTextWidth, margin + headerH + 12);
      }
      imgY = margin + headerH + stepBandH;
    }

    const { width: imgW, height: imgH } = await loadImageDims(shot.dataUrl);
    const ratio = Math.min(availW / imgW, availH / imgH);
    const w = imgW * ratio;
    const h = imgH * ratio;
    const x = (pageW - w) / 2;
    pdf.addImage(shot.dataUrl, 'JPEG', x, imgY, w, h);
  }

  const sessionStartUtc = sessionMeta.startedAtUtc
    || (screenshots[0] && (screenshots[0].timestampUtc || new Date(screenshots[0].timestamp).toISOString()))
    || new Date().toISOString();
  const sessionEndUtc = sessionMeta.endedAtUtc || new Date().toISOString();
  const { entries, chainRoot } = await buildCaptureManifest(screenshots);
  const manifest = {
    version: 1,
    generator: 'Uni Capture',
    sessionStartUtc,
    sessionEndUtc,
    captureCount: screenshots.length,
    chainRoot,
    entries: entries.map(({ n, utc, url, source, step, label, imageSha256, chainHash }) => ({
      n, utc, url, source, step, label, imageSha256, chainHash,
    })),
  };
  const signed = await signManifest(manifest);
  addAttestationPage(pdf, {
    sessionStartUtc,
    sessionEndUtc,
    captureCount: screenshots.length,
    manifestSha256: signed.manifestSha256,
    chainRoot,
    signatureHex: signed.signatureHex,
    publicKeyJwk: signed.publicKeyJwk,
  }, margin);

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

async function getDesktopMediaStream(streamId) {
  const id = String(streamId);
  const attempts = [
    {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: id,
          maxWidth: 3840,
          maxHeight: 2160,
        },
      },
    },
    {
      audio: false,
      video: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: id,
        maxWidth: 3840,
        maxHeight: 2160,
      },
    },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not open desktop media stream.');
}

async function waitForVideoDimensions(maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (screenVideoEl && screenVideoEl.videoWidth > 0 && screenVideoEl.videoHeight > 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Screen video has no dimensions yet.');
}

async function startScreenStream(streamId) {
  if (screenStream) stopScreenStream();
  if (!streamId) throw new Error('No stream ID provided.');

  const stream = await getDesktopMediaStream(streamId);
  screenStream = stream;

  screenVideoEl = document.createElement('video');
  screenVideoEl.autoplay = true;
  screenVideoEl.muted = true;
  screenVideoEl.playsInline = true;
  screenVideoEl.srcObject = stream;
  document.body.appendChild(screenVideoEl);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Video stream did not start (timeout).')), 10000);
    screenVideoEl.onloadedmetadata = () => {
      clearTimeout(t);
      screenVideoEl.play().then(resolve).catch(reject);
    };
  });
  await waitForVideoDimensions();

  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      chrome.runtime.sendMessage({ type: 'SCREEN_STREAM_ENDED' }).catch(() => {});
    });
  }
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
  await waitForVideoDimensions();
  const w = screenVideoEl.videoWidth;
  const h = screenVideoEl.videoHeight;

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

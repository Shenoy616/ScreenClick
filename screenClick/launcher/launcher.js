// Launcher: chrome.desktopCapture picker + frame grabs for Screen or Window mode.

const statusEl = document.getElementById('status');

let launcherPort = null;
let reconnectTimer = null;

function connectLauncherPort() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (launcherPort) {
    try { launcherPort.disconnect(); } catch { /* ignore */ }
    launcherPort = null;
  }
  try {
    launcherPort = chrome.runtime.connect({ name: 'screenclick-launcher' });
  } catch {
    launcherPort = null;
    schedulePortReconnect();
    return;
  }
  launcherPort.onDisconnect.addListener(() => {
    launcherPort = null;
    schedulePortReconnect();
  });
  launcherPort.onMessage.addListener(onLauncherPortMessage);
}

function schedulePortReconnect() {
  if (reconnectTimer) return;
  if (!screenStream || screenStream.getVideoTracks()[0]?.readyState !== 'live') return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectLauncherPort();
    if (streamReady && launcherPort) {
      try {
        launcherPort.postMessage({ type: 'LAUNCHER_STREAM_READY' });
      } catch { /* ignore */ }
    }
  }, 350);
}

connectLauncherPort();

// Full 4K frames + JPEG encode are slow; cap long edge for speed.
const SCREEN_CAPTURE_MAX_EDGE = 1920;

let screenStream = null;
let screenVideoEl = null;
let streamReady = false;

function setStatus(msg, error = false) {
  statusEl.textContent = msg;
  statusEl.className = error ? 'err status' : 'status';
}

function setLauncherReady() {
  document.body.classList.add('ready');
}

function friendlyCaptureError(err) {
  const msg = err?.message || String(err);
  if (/permission dismissed/i.test(msg)) {
    return (
      'Screen access was blocked. On Mac: System Settings → Privacy & Security → ' +
      'Screen Recording → enable Google Chrome, then try again.'
    );
  }
  if (/not allowed|denied/i.test(msg)) {
    return 'Screen capture was denied. Allow Screen Recording for Chrome, then try again.';
  }
  return msg;
}

function isPersonalVideoTrack(track) {
  if (!track || track.kind !== 'video') return false;
  const s = track.getSettings?.() || {};
  return !!s.facingMode;
}

function sanitizeScreenshotStream(stream) {
  stream.getAudioTracks().forEach((t) => t.stop());
  const videos = stream.getVideoTracks();
  if (videos.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No video track from desktop capture.');
  }
  const keep =
    videos.find((t) => !isPersonalVideoTrack(t)) ||
    videos[0];
  videos.forEach((t) => {
    if (t !== keep) t.stop();
  });
  return new MediaStream([keep]);
}

function hasVideoDimensions() {
  return !!(screenVideoEl && screenVideoEl.videoWidth > 0 && screenVideoEl.videoHeight > 0);
}

async function waitForVideoDimensions(maxMs = 2000) {
  if (hasVideoDimensions()) return;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (hasVideoDimensions()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Screen preview has no size yet.');
}

function stopScreenStream() {
  streamReady = false;
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

async function attachScreenStream(stream) {
  stopScreenStream();
  screenStream = stream;

  screenVideoEl = document.createElement('video');
  screenVideoEl.autoplay = true;
  screenVideoEl.muted = true;
  screenVideoEl.playsInline = true;
  screenVideoEl.style.cssText =
    'position:fixed;left:-99999px;top:0;width:640px;height:360px;opacity:0;pointer-events:none;';
  screenVideoEl.srcObject = stream;
  document.body.appendChild(screenVideoEl);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Screen preview did not start (timeout).')), 15000);
    const done = () => {
      clearTimeout(t);
      screenVideoEl.play().then(resolve).catch(reject);
    };
    screenVideoEl.onloadedmetadata = done;
    screenVideoEl.onloadeddata = () => {
      if (screenVideoEl.readyState >= 2) done();
    };
  });
  await waitForVideoDimensions(8000);
  streamReady = true;

  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      streamReady = false;
      chrome.runtime.sendMessage({ type: 'SCREEN_STREAM_ENDED' }).catch(() => {});
    });
  }
}

function scaledCaptureSize(srcW, srcH) {
  const maxEdge = Math.max(srcW, srcH);
  if (maxEdge <= SCREEN_CAPTURE_MAX_EDGE) {
    return { w: srcW, h: srcH, sw: srcW, sh: srcH };
  }
  const scale = SCREEN_CAPTURE_MAX_EDGE / maxEdge;
  return {
    w: Math.round(srcW * scale),
    h: Math.round(srcH * scale),
    sw: srcW,
    sh: srcH,
  };
}

async function captureScreenFrame(quality) {
  if (!screenVideoEl || !screenStream) throw new Error('Screen preview not ready.');
  const track = screenStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new Error('Screen sharing ended. Start Screen or Window mode again.');
  }
  if (isPersonalVideoTrack(track)) {
    throw new Error('Pick a monitor or app window, not a camera.');
  }
  if (!streamReady && !hasVideoDimensions()) {
    await waitForVideoDimensions(1500);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const srcW = screenVideoEl.videoWidth;
  const srcH = screenVideoEl.videoHeight;
  if (!srcW || !srcH) throw new Error('Screen preview has no size yet.');

  const { w, h, sw, sh } = scaledCaptureSize(srcW, srcH);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(screenVideoEl, 0, 0, sw, sh, 0, 0, w, h);

  const q = Math.max(0.3, Math.min(1.0, quality));
  const dataUrl = canvas.toDataURL('image/jpeg', q);
  if (!dataUrl || dataUrl.length < 32) {
    throw new Error('Could not encode screenshot.');
  }
  return dataUrl;
}

function notifySessionStarted() {
  setStatus('Starting…');
  chrome.runtime.sendMessage({ type: 'SCREEN_PICKER_RESULT' }, (response) => {
    if (chrome.runtime.lastError) {
      stopScreenStream();
      setStatus('Error: ' + chrome.runtime.lastError.message, true);
      setTimeout(() => window.close(), 2500);
      return;
    }
    if (response && response.ok) {
      setLauncherReady();
      setStatus('Ready — use Capture in the side panel. Keep this window open.');
      if (launcherPort) {
        try {
          launcherPort.postMessage({ type: 'LAUNCHER_STREAM_READY' });
        } catch {
          connectLauncherPort();
        }
      }
    } else {
      stopScreenStream();
      setStatus('Could not start: ' + ((response && response.error) || 'unknown'), true);
      setTimeout(() => window.close(), 4000);
    }
  });
}

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
  throw lastErr || new Error('Could not open desktop stream.');
}

function onDesktopCapturePicked(streamId) {
  if (chrome.runtime.lastError) {
    setStatus('Picker error: ' + chrome.runtime.lastError.message, true);
    chrome.runtime.sendMessage({ type: 'SCREEN_PICKER_CANCELLED' }).catch(() => {});
    setTimeout(() => window.close(), 2500);
    return;
  }
  if (!streamId) {
    setStatus('Cancelled.', true);
    chrome.runtime.sendMessage({ type: 'SCREEN_PICKER_CANCELLED' }).catch(() => {});
    setTimeout(() => window.close(), 600);
    return;
  }
  (async () => {
    setStatus('Connecting…');
    try {
      const raw = await getDesktopMediaStream(streamId);
      const stream = sanitizeScreenshotStream(raw);
      await attachScreenStream(stream);
      notifySessionStarted();
    } catch (e) {
      setStatus(friendlyCaptureError(e), true);
      chrome.runtime.sendMessage({ type: 'SCREEN_PICKER_CANCELLED' }).catch(() => {});
      setTimeout(() => window.close(), 4000);
    }
  })();
}

function openDesktopCapturePicker() {
  setStatus('Select a screen or window in Chrome’s picker…');
  const sources = ['screen', 'window'];

  // Classic picker: no target tab → avoids Chrome Tab + facecam share UI.
  try {
    chrome.desktopCapture.chooseDesktopMedia(sources, onDesktopCapturePicked);
    return;
  } catch {
    /* fall through */
  }

  resolvePickerTab((tab) => {
    if (!tab) {
      setStatus('Open a website tab in Chrome first, then try again.', true);
      setTimeout(() => window.close(), 4000);
      return;
    }
    try {
      chrome.desktopCapture.chooseDesktopMedia(
        sources,
        tab,
        { systemAudio: 'exclude', windowAudio: 'exclude' },
        onDesktopCapturePicked
      );
    } catch {
      chrome.desktopCapture.chooseDesktopMedia(sources, tab, onDesktopCapturePicked);
    }
  });
}

function isPickerTabUrl(url) {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

function resolvePickerTab(callback) {
  const tabId = pickerTabIdFromUrl();
  if (tabId != null) {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && isPickerTabUrl(tab.url)) {
        callback(tab);
        return;
      }
      findAnyHttpTab(callback);
    });
    return;
  }
  findAnyHttpTab(callback);
}

function findAnyHttpTab(callback) {
  chrome.tabs.query({ lastFocusedWindow: true }, (tabs) => {
    const ok = tabs && tabs.find((t) => isPickerTabUrl(t.url));
    if (ok) {
      callback(ok);
      return;
    }
    chrome.tabs.query({}, (all) => {
      const any = all && all.find((t) => isPickerTabUrl(t.url));
      callback(any || null);
    });
  });
}

function pickerTabIdFromUrl() {
  const raw = new URLSearchParams(location.search).get('tabId');
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

async function handleLauncherRequest(msg) {
  switch (msg.type) {
    case 'CAPTURE_SCREEN_FRAME':
      return { ok: true, dataUrl: await captureScreenFrame(msg.quality || 0.8) };
    case 'STOP_SCREEN_STREAM':
      stopScreenStream();
      return { ok: true };
    case 'PING_LAUNCHER':
      return {
        ok: true,
        hasStream: !!(screenStream && screenStream.getVideoTracks()[0]?.readyState === 'live'),
      };
    default:
      return { ok: false, error: 'Unknown launcher message: ' + msg.type };
  }
}

function postLauncherReply(reply, requestId) {
  if (!launcherPort) {
    connectLauncherPort();
  }
  if (!launcherPort) return;
  try {
    launcherPort.postMessage({ ...reply, requestId });
  } catch {
    schedulePortReconnect();
  }
}

function onLauncherPortMessage(msg) {
  if (!msg) return;
  if (msg.type === 'CAPTURE_UI') {
    if (msg.phase === 'start') setStatus('Capturing…');
    else if (msg.phase === 'done') {
      setLauncherReady();
      setStatus('Saved — use Capture in the side panel for the next shot. Keep this window open.');
    } else if (msg.phase === 'err') {
      setStatus(msg.error || 'Capture failed', true);
    }
    return;
  }
  if (!msg.requestId) return;
  (async () => {
    let result;
    try {
      result = await handleLauncherRequest(msg);
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    }
    postLauncherReply(result, msg.requestId);
  })();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'launcher') return false;
  (async () => {
    try {
      sendResponse(await handleLauncherRequest(msg));
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

openDesktopCapturePicker();

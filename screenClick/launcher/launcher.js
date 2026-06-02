// Launcher window. Opens the desktopCapture picker, ferries the streamId to
// the service worker, then closes itself. Runs in a tab-context (window), so
// chrome.desktopCapture.chooseDesktopMedia works reliably.

const statusEl = document.getElementById('status');

function setStatus(msg, error = false) {
  statusEl.textContent = msg;
  statusEl.className = error ? 'err' : 'status';
}

async function go() {
  try {
    const streamId = await new Promise((resolve) => {
      chrome.desktopCapture.chooseDesktopMedia(
        ['screen', 'window'],
        (id) => resolve(id || null)
      );
    });

    if (!streamId) {
      setStatus('Cancelled.', true);
      // Notify SW so it can clean up its pending state, if any.
      chrome.runtime.sendMessage({ type: 'SCREEN_PICKER_CANCELLED' }).catch(() => {});
      setTimeout(() => window.close(), 600);
      return;
    }

    setStatus('Starting recording...');
    const response = await chrome.runtime.sendMessage({
      type: 'SCREEN_PICKER_RESULT',
      streamId,
    });

    if (response && response.ok) {
      setStatus('Recording started. Closing window...');
      setTimeout(() => window.close(), 400);
    } else {
      setStatus('Could not start: ' + ((response && response.error) || 'unknown'), true);
      setTimeout(() => window.close(), 2500);
    }
  } catch (e) {
    setStatus('Error: ' + (e.message || e), true);
    setTimeout(() => window.close(), 2500);
  }
}

go();

// Apply and sync ScreenClick theme (light / dark) from chrome.storage.local.
(function (root) {
  function setTheme(mode) {
    if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  async function applyStoredTheme() {
    try {
      const { theme } = await chrome.storage.local.get('theme');
      setTheme(theme === 'light' ? 'light' : 'dark');
    } catch {
      setTheme('dark');
    }
  }

  async function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { await chrome.storage.local.set({ theme: next }); } catch { /* ignore */ }
    return next;
  }

  function bindThemeToggle(button) {
    if (!button) return;
    const refreshLabel = () => {
      const isDark = getTheme() === 'dark';
      const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
      button.setAttribute('title', label);
      button.setAttribute('aria-label', label);
    };
    refreshLabel();
    button.addEventListener('click', async () => {
      await toggleTheme();
      refreshLabel();
    });
  }

  function listenThemeChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.theme) return;
      setTheme(changes.theme.newValue === 'dark' ? 'dark' : 'light');
    });
  }

  root.ScreenClickTheme = {
    setTheme,
    getTheme,
    applyStoredTheme,
    toggleTheme,
    bindThemeToggle,
    listenThemeChanges,
  };

  applyStoredTheme();
})(typeof globalThis !== 'undefined' ? globalThis : window);

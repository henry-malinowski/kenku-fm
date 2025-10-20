(function () {
  try {
    console.log('[GoodTube][Preload] starting injector bootstrap');
    const { ipcRenderer } = require('electron');
    try { ipcRenderer.send('GOODTUBE_PRELOAD_BOOTSTRAP', { href: location.href }); } catch {}
  } catch {}
  try {
    const protocol = String(location.protocol || "");
    if (!protocol.startsWith("http")) return;

    const hostname = String(location.hostname || "");
    const isYouTubeHost =
      hostname === "youtube.com" ||
      hostname === "www.youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname.endsWith(".youtube.com");
    const isWikipediaHost =
      hostname === "wikipedia.org" ||
      hostname.endsWith(".wikipedia.org");
    try { console.log('[GoodTube][Preload] host:', hostname); } catch {}
    if (!(isYouTubeHost || isWikipediaHost)) return;
  } catch (_) {
    return;
  }

  try {
    // No DOM injection from preload (avoids CSP/TT violations). All execution happens via main.
    try { const { ipcRenderer } = require('electron'); ipcRenderer.send('GOODTUBE_PRELOAD_APPEND', 'skipped'); } catch {}
  } catch (e) {
    try { console.error('[GoodTube] Preload injection failed:', e); } catch {}
  }
})();



// Shared by the worker, injected collector, and deterministic accounting tests.
(() => {
  function siteOf(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:') return null;
      return ({ 'www.youtube.com': 'youtube', 'www.bilibili.com': 'bilibili' })[u.hostname] || null;
    } catch { return null; }
  }
  function isLauncher(value) {
    return !!siteOf(value) && new URL(value).searchParams.get('bht_launch') === '1';
  }
  function videoOf(value) {
    if (!siteOf(value)) return null;
    const u = new URL(value);
    if (siteOf(value) === 'youtube' && u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return id ? { id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` } : null;
    }
    const match = u.pathname.match(/^\/video\/(BV[\w]+|av\d+)(?:\/|$)/);
    if (siteOf(value) === 'bilibili' && match) {
      const part = Math.max(1, Number.parseInt(u.searchParams.get('p') || '1', 10) || 1);
      return { id: `${match[1]}:p${part}`, url: `https://www.bilibili.com/video/${match[1]}/?p=${part}` };
    }
    return null;
  }
  function playbackDelta({ elapsed, before, after, rate, playing, seeking }) {
    if (!playing || seeking || elapsed <= 0 || elapsed > 5000 || after <= before || rate <= 0) return 0;
    const progress = (after - before) * 1000 / rate;
    if (progress > elapsed + 1500) return 0;
    return Math.min(elapsed, progress);
  }
  globalThis.VideoLedgerMetrics = Object.freeze({ siteOf, isLauncher, videoOf, playbackDelta });
})();

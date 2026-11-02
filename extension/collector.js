// Injected only into a tab belonging to a launcher session. No all-site content script.
(() => {
  if (globalThis.__videoLedger) return;
  globalThis.__videoLedger = true;
  void (async () => {
    const hello = await chrome.runtime.sendMessage({ type: 'hello' }).catch(() => null);
    if (!hello?.ok) { globalThis.__videoLedger = false; return; }
    const site = location.hostname === 'www.youtube.com' ? 'youtube' : 'bilibili';
    const { videoOf, playbackDelta } = globalThis.VideoLedgerMetrics;
    const launch = new URL(location.href);
    if (launch.searchParams.has('bht_launch')) {
      launch.searchParams.delete('bht_launch');
      history.replaceState(history.state, '', launch.href);
    }
    const docId = crypto.randomUUID();
    let seq = 0, pending = [], sending = false, stopped = false;
    let activityAt = Date.now(), previous = null, chunk = null;
    const clean = value => String(value || '').trim().slice(0, 1000);
    const text = selector => clean(document.querySelector(selector)?.textContent);
    function metadata() {
      const identity = videoOf(location.href);
      if (!identity) return null;
      if (site === 'youtube') {
        if (document.querySelector('#movie_player.ytp-live')) return null;
        return { video_id: identity.id, url: identity.url,
          title: text('ytd-watch-metadata h1 yt-formatted-string') || text('h1.title') || clean(document.title.replace(/ - YouTube$/, '')),
          creator: text('ytd-watch-metadata #channel-name a') || text('#owner #channel-name a') };
      }
      if (site === 'bilibili') {
        return { video_id: identity.id, url: identity.url,
          title: text('h1.video-title') || text('h1') || clean(document.title.replace(/_哔哩哔哩_bilibili$/, '')),
          creator: text('.up-name') || text('.up-info-container .up-name') };
      }
      return null;
    }
    function snapshot() {
      const meta = metadata();
      const video = document.querySelector(site === 'youtube' ? '#movie_player video' : '.bpx-player-video-wrap video') || document.querySelector('video');
      const ad = site === 'youtube' && !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
      const playing = !!(meta && video && !ad && Number.isFinite(video.duration) && video.duration > 0 && !video.paused && !video.ended && video.readyState >= 2);
      const now = Date.now();
      const visible = document.visibilityState === 'visible' && document.hasFocus();
      return { now, mono: performance.now(), meta, video,
        foreground: visible && (playing || now - activityAt < 300000),
        playing, seeking: !!video?.seeking, position: video?.currentTime || 0, rate: video?.playbackRate || 1,
        duration: meta && video && !ad && Number.isFinite(video.duration) ? video.duration : null };
    }
    function finish() {
      if (chunk && (chunk.foreground_ms > 0 || chunk.playback_ms > 0)) {
        for (const key of ['foreground_ms', 'playback_ms', 'background_ms']) chunk[key] = Math.round(chunk[key]);
        pending.push({ ...chunk, id: `${docId}:${seq++}` });
      }
      chunk = null;
    }
    async function send() {
      if (sending || !pending.length || stopped) return;
      sending = true;
      const batch = pending.slice(0, 100);
      try {
        const result = await chrome.runtime.sendMessage({ type: 'samples', events: batch });
        if (result?.ok) pending.splice(0, batch.length);
        else if (result && !result.error) stop();
      } catch { /* Retry from the next checkpoint while the document is alive. */ }
      finally { sending = false; }
    }
    function sample(force = false) {
      if (stopped) return;
      const current = snapshot();
      if (!previous) { previous = current; return; }
      const elapsed = current.mono - previous.mono;
      const same = current.meta?.video_id === previous.meta?.video_id && current.video === previous.video;
      if (!same || (chunk && current.now - chunk.start_ms >= 10000)) finish();
      // Discard sleep / heavily throttled gaps instead of inventing watch time.
      if (same && elapsed > 0 && elapsed <= 5000 && current.now >= previous.now && current.now - previous.now <= 5000) {
        if (!chunk) chunk = { kind: 'sample', session_id: hello.session, site,
          start_ms: previous.now, end_ms: current.now, foreground_ms: 0, playback_ms: 0, background_ms: 0,
          video_id: current.meta?.video_id || null, url: current.meta?.url || null,
          title: current.meta?.title || '', creator: current.meta?.creator || '', duration_sec: current.duration };
        chunk.end_ms = current.now;
        if (current.meta) {
          chunk.title = current.meta.title; chunk.creator = current.meta.creator; chunk.duration_sec = current.duration;
        }
        // Requiring foreground at both endpoints avoids attributing a tab-switch gap.
        if (previous.foreground && current.foreground) chunk.foreground_ms += elapsed;
        const played = playbackDelta({ elapsed, before: previous.position, after: current.position, rate: previous.rate,
          playing: previous.playing && previous.rate === current.rate, seeking: previous.seeking || current.seeking });
        if (played > 0) {
          chunk.playback_ms += played;
          if (!previous.foreground || !current.foreground) chunk.background_ms += played;
        }
      }
      previous = current;
      if (force) finish();
      void send();
    }
    function activity() { activityAt = Date.now(); }
    function checkpoint() { sample(true); }
    function mediaEvent(event) { if (event.target instanceof HTMLMediaElement) sample(['pause', 'ended', 'seeking', 'ratechange'].includes(event.type)); }
    const activityEvents = ['pointerdown', 'keydown', 'mousemove', 'wheel'];
    const mediaEvents = ['timeupdate', 'play', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'loadedmetadata'];
    activityEvents.forEach(name => document.addEventListener(name, activity, { passive: true }));
    mediaEvents.forEach(name => document.addEventListener(name, mediaEvent, true));
    document.addEventListener('visibilitychange', checkpoint);
    window.addEventListener('blur', checkpoint);
    window.addEventListener('focus', checkpoint);
    window.addEventListener('pagehide', checkpoint);
    const timer = setInterval(sample, 1000);
    function stop() {
      stopped = true;
      clearInterval(timer);
      activityEvents.forEach(name => document.removeEventListener(name, activity));
      mediaEvents.forEach(name => document.removeEventListener(name, mediaEvent, true));
      document.removeEventListener('visibilitychange', checkpoint);
      window.removeEventListener('blur', checkpoint);
      window.removeEventListener('focus', checkpoint);
      window.removeEventListener('pagehide', checkpoint);
    }
    sample();
  })().catch(() => { globalThis.__videoLedger = false; });
})();

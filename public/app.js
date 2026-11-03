'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    app: document.querySelector('.app'),
    banner: $('banner'),
    title: $('title'),
    seekbar: $('seekbar'),
    pos: $('pos'),
    dur: $('dur'),
    play: $('play'),
    mute: $('mute'),
    fs: $('fs'),
    volbar: $('volbar'),
    volval: $('volval'),
    tokenform: $('tokenform'),
    tokeninput: $('tokeninput'),
    sleep: $('sleep'),
    sleepinfo: $('sleepinfo'),
    sleepend: $('sleepend'),
    sleepcancel: $('sleepcancel'),
  };

  // ---------- Token ----------
  // ?token=... in the URL → remember it. If it is only in storage, write it back into
  // the URL so that "Add to Home Screen" picks it up (on iOS the home screen app gets
  // separate storage, so the token has to be in the URL).
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let token = new URLSearchParams(location.search).get('token') || storage.get('iina-token') || '';
  function rememberToken(t) {
    token = t;
    storage.set('iina-token', t);
    const u = new URL(location.href);
    if (t) u.searchParams.set('token', t); else u.searchParams.delete('token');
    history.replaceState(null, '', u);
  }
  if (token) rememberToken(token);

  function apiUrl(path) {
    const u = new URL('api/' + path, location.href);
    if (token) u.searchParams.set('token', token);
    return u.toString();
  }

  // ---------- State ----------
  const state = { connected: false };
  let serverReachable = false;
  let needToken = false;
  let seekDragging = false;
  let seekHoldUntil = 0;
  let volDragging = false;
  let volHoldUntil = 0;

  function fmt(sec) {
    if (sec == null || !Number.isFinite(sec)) return '0:00';
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function setFill(input) {
    const min = Number(input.min), max = Number(input.max), v = Number(input.value);
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', pct + '%');
  }

  function renderBanner() {
    let msg = '', cls = '';
    if (needToken) msg = 'Missing or invalid token';
    else if (!serverReachable) msg = 'Cannot reach the server…';
    else if (!state.connected) msg = 'IINA is not running';
    else if (state.title == null && state.duration == null) { msg = 'No file open'; cls = 'warn'; }
    els.banner.textContent = msg;
    els.banner.className = 'banner ' + cls;
    els.banner.hidden = !msg;
    els.app.classList.toggle('offline', !(serverReachable && state.connected) || needToken);
    els.app.classList.toggle('noserver', !serverReachable || needToken);
    els.tokenform.hidden = !needToken;
  }

  function render() {
    renderBanner();

    els.title.textContent = state.title || (state.connected ? '—' : 'IINA Remote');
    document.title = state.title ? `${state.pause ? '⏸' : '▶'} ${state.title}` : 'IINA Remote';

    const playIcon = els.play.querySelector('use');
    playIcon.setAttribute('href', state.pause === false ? '#i-pause' : '#i-play');
    els.play.setAttribute('aria-label', state.pause === false ? 'Pause' : 'Play');

    const dur = Number.isFinite(state.duration) ? state.duration : 0;
    els.dur.textContent = fmt(dur);
    els.seekbar.disabled = !(dur > 0);
    if (!seekDragging && Date.now() > seekHoldUntil) {
      els.seekbar.max = String(dur || 1);
      els.seekbar.value = String(state.timePos ?? 0);
      els.pos.textContent = fmt(state.timePos);
      setFill(els.seekbar);
    }

    const muted = !!state.mute;
    els.mute.querySelector('use').setAttribute('href', muted ? '#i-mute' : '#i-vol');
    els.mute.classList.toggle('on', muted);
    els.fs.classList.toggle('on', !!state.fullscreen);

    els.volbar.disabled = state.volume == null;
    if (state.volumeMax) els.volbar.max = String(state.volumeMax);
    if (!volDragging && Date.now() > volHoldUntil && state.volume != null) {
      els.volbar.value = String(state.volume);
      setFill(els.volbar);
    }
    els.volval.textContent = state.volume == null ? '—' : (muted ? 'muted' : Math.round(state.volume) + '%');

    renderSleep();
  }

  // ---------- Sleep timer ----------
  function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderSleep() {
    const sl = state.sleep;
    els.sleep.classList.toggle('active', !!sl);
    els.sleepcancel.hidden = !sl;
    els.sleepend.classList.toggle('on', sl?.mode === 'end');
    if (!sl) {
      els.sleepinfo.textContent = 'off';
    } else if (sl.mode === 'timer') {
      const left = (sl.endsAt - Date.now()) / 1000;
      els.sleepinfo.textContent = `in ${fmt(Math.max(0, Math.ceil(left)))} (at ${clock(sl.endsAt)})`;
    } else {
      // Estimate the remaining time if position and duration are known.
      const left = Number.isFinite(state.duration) && Number.isFinite(state.timePos)
        ? state.duration - state.timePos : null;
      els.sleepinfo.textContent = left != null && left > 0
        ? `end of media (in ~${fmt(left)})`
        : 'end of media';
    }
  }
  setInterval(() => { if (state.sleep?.mode === 'timer') renderSleep(); }, 1000);

  function applyState(patch) {
    Object.assign(state, patch);
    render();
  }

  // ---------- API calls ----------
  async function call(path, button) {
    try {
      const res = await fetch(apiUrl(path), { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { needToken = true; renderBanner(); return; }
      serverReachable = true;
      if (!res.ok) {
        if (res.status === 503) applyState({ connected: false });
        flashError(button);
        return;
      }
      if (body.state) applyState(body.state);
      if ('sleep' in body) applyState({ sleep: body.sleep });
    } catch {
      serverReachable = false;
      renderBanner();
      flashError(button);
    }
  }

  function flashError(button) {
    if (!button) return;
    button.classList.add('flash-err');
    setTimeout(() => button.classList.remove('flash-err'), 400);
  }

  // Buttons: plain click; with data-repeat, holding the button repeats (fine volume steps).
  for (const btn of document.querySelectorAll('[data-api]')) {
    const path = btn.dataset.api;
    if (!btn.hasAttribute('data-repeat')) {
      btn.addEventListener('click', () => call(path, btn));
      continue;
    }
    let delayTimer = null, repeatTimer = null;
    const stop = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = repeatTimer = null;
      btn.classList.remove('pressed');
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      btn.classList.add('pressed');
      call(path, btn);
      delayTimer = setTimeout(() => {
        repeatTimer = setInterval(() => call(path, btn), 120);
      }, 400);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keyboard support
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); call(path, btn); }
    });
  }

  // Seek bar: preview while dragging, absolute seek on release.
  els.seekbar.addEventListener('input', () => {
    seekDragging = true;
    els.pos.textContent = fmt(Number(els.seekbar.value));
    setFill(els.seekbar);
  });
  els.seekbar.addEventListener('change', () => {
    seekDragging = false;
    seekHoldUntil = Date.now() + 600; // don't jump back until the seek has landed
    call('seek?to=' + Number(els.seekbar.value).toFixed(2));
  });

  // Volume slider: applies while dragging (throttled), in steps of 1.
  let volSendTimer = null;
  function sendVolume() {
    volSendTimer = null;
    call('volume?set=' + els.volbar.value);
  }
  els.volbar.addEventListener('input', () => {
    volDragging = true;
    els.volval.textContent = els.volbar.value + '%';
    setFill(els.volbar);
    if (!volSendTimer) volSendTimer = setTimeout(sendVolume, 100);
  });
  els.volbar.addEventListener('change', () => {
    volDragging = false;
    volHoldUntil = Date.now() + 500;
    clearTimeout(volSendTimer);
    sendVolume();
  });

  // Token form
  els.tokenform.addEventListener('submit', (e) => {
    e.preventDefault();
    rememberToken(els.tokeninput.value.trim());
    els.tokeninput.value = '';
    needToken = false;
    connect();
  });

  // ---------- Live updates (SSE) ----------
  let es = null;
  let retryTimer = null;

  function connect() {
    clearTimeout(retryTimer);
    if (es) es.close();
    es = new EventSource(apiUrl('events'));
    es.addEventListener('open', () => {
      serverReachable = true;
      needToken = false;
      renderBanner();
    });
    es.addEventListener('state', (e) => {
      for (const k of Object.keys(state)) delete state[k];
      applyState(JSON.parse(e.data));
    });
    es.addEventListener('change', (e) => applyState(JSON.parse(e.data)));
    es.addEventListener('error', async () => {
      serverReachable = false;
      renderBanner();
      if (es.readyState === EventSource.CLOSED) {
        // Non-200 response (e.g. 401) – find out why, then retry.
        try {
          const res = await fetch(apiUrl('status'), { cache: 'no-store' });
          if (res.status === 401) { needToken = true; renderBanner(); return; }
        } catch {}
        retryTimer = setTimeout(connect, 3000);
      }
    });
  }

  // iOS often drops the connection in the background – reopen it when visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !needToken) {
      if (!es || es.readyState !== EventSource.OPEN) connect();
    }
  });

  render();
  connect();
})();

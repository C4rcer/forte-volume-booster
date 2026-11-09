// Forte content script: runs in every frame, finds <video>/<audio> (shadow DOM
// too) and, only once the user asks for a boost or an EQ, routes them through
// a Web Audio chain: EQ -> boost -> (leveller) -> limiter -> soft clip.
//
// Firefox has no tabCapture, so the only way in is createMediaElementSource,
// which is one-way: once an element is routed, its sound only reaches the
// speakers through our graph. Three rules keep that from ever silencing a video:
//   1. Never route into an AudioContext that isn't running (it would mute).
//   2. Never route media Firefox would feed us as silence: cross-origin media
//      without CORS (checked by URL), including same-origin URLs that redirect
//      elsewhere (checked by a mozCaptureStream probe that doesn't affect
//      playback). Such players are left alone and play normally.
//   3. If routing fails or another add-on already handles the element
//      (InvalidStateError, or YouTube/Twitch Enhancer's marker), skip it.
(() => {
  "use strict";
  if (window.__forteLoaded) return;
  window.__forteLoaded = true;

  const api = globalThis.browser;
  const INSTANCE = Math.random().toString(36).slice(2);
  const WIRED_ATTR = "data-forte-wired";
  // YouTube/Twitch Enhancer sets this on the <video> it routes through its own
  // AudioContext (volume boost / compressor).
  const YTE_ATTR = "data-ytb-boost-wired";
  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const TICK_MS = 250;
  const PROBE_GIVE_UP_MS = 6000; // playing + audible + only zeros => blocked source
  const LOST_AFTER_MS = 4000; // routed, playing, only zeros => its new source is blocked
  const SILENT = 1e-5;

  // Limiter: hard knee at -3 dBFS, 20:1. The compressor node adds automatic
  // makeup gain ((1/curve(0 dB))^0.6); undo it so 300% means 300%.
  const LIM_T = -3;
  const LIM_RATIO = 20;
  const LIM_COMP = Math.pow(10, (0.6 * LIM_T * (1 - 1 / LIM_RATIO)) / 20);

  let settings = null;
  let site = "";
  let off = "";
  let audio = null;
  let active = false;
  let observer = null;
  let reportTimer = null;
  let tickTimer = null;
  const media = new Set();
  const state = new WeakMap();

  let ctx = null;
  let chain = null;
  let gestureArmed = false;

  const send = (msg) => api.runtime.sendMessage(msg).catch(() => {});
  const wantsProcessing = () =>
    !!audio && !off && (Math.abs(audio.gain - 1) > 0.001 || audio.bands.some((b) => b !== 0) ||
      audio.compressor || audio.mono || audio.balance !== 0);

  // ------------------------------------------------------------ discovery

  function shadowOf(el) {
    // openOrClosedShadowRoot is a Firefox extension-only API that also sees closed roots.
    return el.openOrClosedShadowRoot || el.shadowRoot || null;
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root instanceof HTMLMediaElement) attach(root);
    for (const el of root.querySelectorAll("video, audio")) attach(el);
    for (const el of root.querySelectorAll("*")) {
      const sr = shadowOf(el);
      if (sr && !sr.__forteObserved) {
        sr.__forteObserved = true;
        if (observer) observer.observe(sr, { childList: true, subtree: true });
        scan(sr);
      }
    }
  }

  let queued = [];
  let flushTimer = null;
  function onMutations(records) {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) queued.push(n);
    if (!flushTimer) flushTimer = setTimeout(flushQueued, 80);
  }
  function flushQueued() {
    flushTimer = null;
    const nodes = queued;
    queued = [];
    for (const n of nodes) if (n.isConnected) scan(n);
    for (const el of media) if (!el.isConnected && !state.get(el).src) detach(el);
  }

  // ------------------------------------------------------------ per element

  function attach(el) {
    if (!active || state.has(el)) return;
    const ctl = new AbortController();
    const st = { ctl, status: "idle", why: "", src: null, meter: null, probe: null, zeroMs: 0, lastT: -1, yteObs: null };
    state.set(el, st);
    media.add(el);
    const on = (t, fn) => el.addEventListener(t, fn, { signal: ctl.signal });
    for (const t of ["loadstart", "emptied"]) on(t, () => onNewSource(el, st));
    for (const t of ["playing", "volumechange", "loadeddata"]) on(t, () => consider(el));
    consider(el);
    reportSoon();
  }

  function detach(el) {
    const st = state.get(el);
    if (!st) return;
    st.ctl.abort();
    stopProbe(st);
    state.delete(el);
    media.delete(el);
    reportSoon();
  }

  function setStatus(st, status, why = "") {
    if (st.status === status && st.why === why) return;
    st.status = status;
    st.why = why;
    reportSoon();
  }

  function onNewSource(el, st) {
    stopProbe(st);
    st.zeroMs = 0;
    st.probeFails = 0;
    if (st.src) {
      // Already routed: we can't hand it back. If the new source is one Firefox
      // will feed us as silence, say so (the popup suggests a reload).
      if (corsVerdict(el) === "tainted") setStatus(st, "lost", "cors");
      return;
    }
    if (["cors", "noaudio", "error"].includes(st.status)) setStatus(st, "idle");
    consider(el);
  }

  function selfOrigin() {
    try {
      return self.origin;
    } catch {
      return location.origin;
    }
  }

  // "ok": Firefox will hand the samples to our AudioContext.
  // "tainted": cross-origin without CORS, would play as silence once routed.
  // "unknown": no source yet.
  function corsVerdict(el) {
    if (el.srcObject) return "ok"; // MediaStream (calls, screen shares)
    const url = el.currentSrc || el.src;
    if (!url) return "unknown";
    let u;
    try {
      u = new URL(url, document.baseURI);
    } catch {
      return "unknown";
    }
    if (u.protocol === "data:") return "ok";
    if (u.origin !== "null" && u.origin === selfOrigin()) return "ok"; // blob: URLs carry their origin
    if (el.crossOrigin != null) return el.readyState > 0 && !el.error ? "ok" : "unknown"; // CORS-approved load
    return "tainted";
  }

  // Decide what to do with one element. Cheap and idempotent: called on media
  // events, setting changes and every tick while something is pending.
  function consider(el) {
    const st = state.get(el);
    if (!st || st.src) return;
    if (!wantsProcessing()) {
      stopProbe(st);
      if (["probing", "waiting", "gesture"].includes(st.status)) setStatus(st, "idle");
      return;
    }
    if (["claimed", "error"].includes(st.status)) return;
    if (el.hasAttribute(YTE_ATTR)) return setStatus(st, "other");
    const mark = el.getAttribute(WIRED_ATTR);
    if (mark && mark !== INSTANCE) return setStatus(st, "stale"); // routed by a previous Forte (reload)
    const verdict = corsVerdict(el);
    if (verdict === "tainted") return setStatus(st, "cors", "url");
    if (st.status === "cors" && st.why === "probe") return; // re-probed only on a new source or user change
    if (el.readyState >= 1 && el.mozHasAudio === false) return setStatus(st, "noaudio");
    if (el.paused || el.readyState < 2 || el.muted || el.volume === 0) {
      // Nothing to hear yet (paused, loading, or a muted autoplay preview):
      // probe once it plays audibly ("playing" / "volumechange"). No
      // AudioContext is created before that.
      stopProbe(st);
      return setStatus(st, "waiting");
    }
    if (!ensureContext()) return setStatus(st, "gesture");
    startProbe(el, st);
  }

  // ------------------------------------------------------------ probe

  // mozCaptureStream() taps the element without taking its sound away. Through
  // a MediaStreamAudioSourceNode Firefox applies the same cross-origin rule as
  // createMediaElementSource, so hearing a single non-zero sample proves that
  // routing is safe; only zeros while it plays audibly means a blocked source.
  function startProbe(el, st) {
    if (st.probe) return;
    let stream = null;
    let node = null;
    try {
      stream = el.mozCaptureStream ? el.mozCaptureStream() : el.captureStream();
      if (!stream.getAudioTracks().length) throw new Error("no audio track yet");
      node = ctx.createMediaStreamSource(stream);
    } catch {
      if (stream) for (const t of stream.getTracks()) t.stop();
      // DRM-protected players can't be captured. Their sound is decoded by the
      // page itself (MediaSource), so the same-origin URL is good evidence.
      if (el.mediaKeys || (el.currentSrc || "").startsWith("blob:")) return route(el, st);
      st.probeFails = (st.probeFails || 0) + 1;
      return setStatus(st, st.probeFails >= 5 ? "error" : "waiting", "probe");
    }
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    node.connect(an);
    an.connect(chain.sink);
    st.probe = { stream, node, an, buf: new Float32Array(an.fftSize), zeroMs: 0 };
    st.lastT = el.currentTime;
    setStatus(st, "probing");
    startTicking();
  }

  function stopProbe(st) {
    const p = st.probe;
    if (!p) return;
    st.probe = null;
    try { p.node.disconnect(); p.an.disconnect(); } catch { /* ignore */ }
    for (const t of p.stream.getTracks()) t.stop();
  }

  function audible(el) {
    return !el.paused && !el.muted && el.volume > 0 && !el.seeking && el.readyState >= 3;
  }

  function hasSignal(an, buf) {
    an.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) if (buf[i] > SILENT || buf[i] < -SILENT) return true;
    return false;
  }

  let lastTick = 0;
  function tick() {
    // Background tabs get their timers throttled: count real time, capped so a
    // long stall (suspended tab) doesn't count as a long silence.
    const now = performance.now();
    const dt = Math.min(1500, lastTick ? now - lastTick : TICK_MS);
    lastTick = now;
    let busy = false;
    for (const el of media) {
      const st = state.get(el);
      if (st.probe) {
        busy = true;
        if (hasSignal(st.probe.an, st.probe.buf)) {
          stopProbe(st);
          route(el, st);
          continue;
        }
        const moved = el.currentTime !== st.lastT;
        st.lastT = el.currentTime;
        if (audible(el) && moved) {
          st.probe.zeroMs += dt;
          if (st.probe.zeroMs >= PROBE_GIVE_UP_MS) {
            stopProbe(st);
            setStatus(st, "cors", "probe");
          }
        } else if (el.paused || el.muted || el.volume === 0) {
          stopProbe(st);
          setStatus(st, "waiting");
        }
      } else if (st.src && st.meter && (st.status === "routed" || st.status === "lost")) {
        busy = true;
        if (!audible(el)) continue;
        if (hasSignal(st.meter, st.buf)) {
          st.zeroMs = 0;
          if (st.status === "lost") setStatus(st, "routed");
        } else {
          st.zeroMs += dt;
          if (st.zeroMs >= LOST_AFTER_MS) setStatus(st, "lost", "silent");
        }
      }
    }
    if (!busy) stopTicking();
  }

  function startTicking() {
    if (!tickTimer) tickTimer = setInterval(tick, TICK_MS);
  }
  function stopTicking() {
    clearInterval(tickTimer);
    tickTimer = null;
    lastTick = 0;
  }

  // ------------------------------------------------------------ routing

  function route(el, st) {
    if (st.src || !chain) return;
    if (el.hasAttribute(YTE_ATTR)) return setStatus(st, "other");
    let src;
    try {
      src = ctx.createMediaElementSource(el);
    } catch (e) {
      // InvalidStateError: the element already has a source node (another
      // add-on or the site itself got there first). Leave it to them.
      setStatus(st, e && e.name === "InvalidStateError" ? "claimed" : "error", e && e.name);
      return;
    }
    st.src = src;
    st.meter = ctx.createAnalyser();
    st.meter.fftSize = 512;
    st.buf = new Float32Array(st.meter.fftSize);
    // Firefox keeps applying the element's own volume and mute to routed file
    // and MediaSource playback, but not to a routed MediaStream (srcObject, e.g.
    // a participant in a web call): mirror them, or muting someone would stop working.
    st.vol = ctx.createGain();
    const isStream = !!(el.srcObject && typeof el.srcObject.getAudioTracks === "function");
    const mirror = () => {
      st.vol.gain.value = isStream ? (el.muted ? 0 : el.volume) : 1;
    };
    mirror();
    if (isStream) el.addEventListener("volumechange", mirror, { signal: st.ctl.signal });
    src.connect(st.vol);
    st.vol.connect(chain.input);
    src.connect(st.meter);
    el.setAttribute(WIRED_ATTR, INSTANCE);
    setStatus(st, "routed");
    // If YouTube/Twitch Enhancer routes this video later (the user opted Forte
    // in on its site), step back so the sound isn't processed twice.
    st.yteObs = new MutationObserver(() => {
      if (!el.hasAttribute(YTE_ATTR)) return;
      try { st.vol.disconnect(); } catch { /* ignore */ }
      setStatus(st, "other", "later");
    });
    st.yteObs.observe(el, { attributes: true, attributeFilter: [YTE_ATTR] });
    startTicking();
  }

  // ------------------------------------------------------------ audio graph

  function ensureContext() {
    if (!ctx) {
      try {
        ctx = new AudioContext();
      } catch {
        return false;
      }
      buildChain();
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "running") {
          for (const el of media) consider(el);
        } else if (ctx.state !== "closed") {
          ctx.resume().catch(() => {});
          armGesture();
        }
        reportSoon();
      });
    }
    if (ctx.state === "running") return true;
    ctx.resume().catch(() => {});
    armGesture();
    return false;
  }

  // Firefox only starts an AudioContext after the user has interacted with the
  // page. Until then nothing is routed (routing into a suspended context would
  // mute the player); the first click or key press on the page resumes it.
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const onGesture = () => {
      if (!ctx) return;
      ctx.resume().then(() => {
        if (ctx.state !== "running") return;
        gestureArmed = false;
        for (const t of ["pointerdown", "keydown", "touchend"]) window.removeEventListener(t, onGesture, true);
        for (const el of media) consider(el);
      }).catch(() => {});
    };
    for (const t of ["pointerdown", "keydown", "touchend"]) window.addEventListener(t, onGesture, true);
  }

  function softClipCurve() {
    // Linear up to 0.95, then a smooth knee that never exceeds ~0.985.
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const a = Math.abs(x);
      const y = a <= 0.95 ? a : 0.95 + 0.04 * Math.tanh((a - 0.95) / 0.04);
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  }

  function buildChain() {
    const c = {};
    c.input = ctx.createGain();
    c.mono = ctx.createGain();
    c.mono.channelCount = 1;
    c.mono.channelCountMode = "explicit";
    c.mono.channelInterpretation = "speakers";
    c.eq = BANDS.map((f) => {
      const b = ctx.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = 1.41;
      b.gain.value = 0;
      return b;
    });
    c.boost = ctx.createGain();
    // "Even out loud and quiet parts": a slow, gentle leveller (night mode).
    c.comp = ctx.createDynamicsCompressor();
    c.comp.threshold.value = -40;
    c.comp.knee.value = 30;
    c.comp.ratio.value = 6;
    c.comp.attack.value = 0.003;
    c.comp.release.value = 0.25;
    c.limiter = ctx.createDynamicsCompressor();
    c.limiter.threshold.value = LIM_T;
    c.limiter.knee.value = 0;
    c.limiter.ratio.value = LIM_RATIO;
    c.limiter.attack.value = 0.001;
    c.limiter.release.value = 0.08;
    c.limComp = ctx.createGain();
    c.limComp.gain.value = LIM_COMP;
    c.clip = ctx.createWaveShaper();
    c.clip.curve = softClipCurve();
    c.clip.oversample = "2x";
    c.pan = ctx.createStereoPanner();
    c.output = ctx.createGain();
    c.inMeter = ctx.createAnalyser();
    c.outMeter = ctx.createAnalyser();
    c.inMeter.fftSize = c.outMeter.fftSize = 2048;
    c.sink = ctx.createGain(); // silent tap so probes and meters keep running
    c.sink.gain.value = 0;
    c.sink.connect(ctx.destination);
    c.wired = "";
    chain = c;
    applyParams();
  }

  function limiterNeeded() {
    return !!settings.limiter && (audio.gain > 1.001 || audio.bands.some((b) => b > 0) || audio.compressor);
  }

  // Wire only the stages in use, so 100% with a flat EQ is bit-transparent.
  function wire() {
    const c = chain;
    const processing = !off && audio;
    const path = [c.input];
    if (processing) {
      if (audio.mono) path.push(c.mono);
      if (audio.bands.some((b) => b !== 0)) path.push(...c.eq);
      path.push(c.boost);
      if (audio.compressor) path.push(c.comp);
      if (limiterNeeded()) path.push(c.limiter, c.limComp, c.clip);
      if (audio.balance !== 0) path.push(c.pan);
    }
    path.push(c.output);
    const key = path.map((n) => [c.input, c.mono, ...c.eq, c.boost, c.comp, c.limiter, c.limComp, c.clip, c.pan, c.output].indexOf(n)).join(",");
    if (key === c.wired) return;
    c.wired = key;
    for (const n of [c.input, c.mono, ...c.eq, c.boost, c.comp, c.limiter, c.limComp, c.clip, c.pan, c.output]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    for (let i = 0; i < path.length - 1; i++) path[i].connect(path[i + 1]);
    c.input.connect(c.inMeter);
    c.output.connect(c.outMeter);
    c.inMeter.connect(c.sink);
    c.outMeter.connect(c.sink);
    c.output.connect(ctx.destination);
  }

  function applyParams() {
    if (!chain || !audio) return;
    const t = ctx.currentTime;
    const ramp = (param, v) => {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(v, t, 0.03);
    };
    ramp(chain.boost.gain, audio.gain);
    chain.eq.forEach((b, i) => ramp(b.gain, audio.bands[i] || 0));
    ramp(chain.pan.pan, audio.balance || 0);
    wire();
  }

  // ------------------------------------------------------------ levels + status

  function read(an) {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sum / buf.length), peak };
  }

  function levels() {
    if (!chain) return null;
    const routed = Array.from(media).some((el) => state.get(el).status === "routed");
    if (!routed) return null;
    const limiting = !off && limiterNeeded();
    return {
      input: read(chain.inMeter),
      output: read(chain.outMeter),
      reduction: limiting ? chain.limiter.reduction : 0,
      state: ctx.state,
    };
  }

  function summary() {
    const counts = {};
    const items = [];
    for (const el of media) {
      const st = state.get(el);
      counts[st.status] = (counts[st.status] || 0) + 1;
      if (items.length < 25) {
        items.push({ id: el.id || "", tag: el.tagName.toLowerCase(), status: st.status, why: st.why });
      }
    }
    return {
      media: media.size, counts, items, off, site,
      gain: audio ? audio.gain : 1,
      processing: wantsProcessing(),
      ctx: ctx ? ctx.state : "none",
      frame: window.top === window ? "top" : "sub",
    };
  }

  function reportSoon() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => send({ type: "forte:report", summary: summary() }), 150);
  }

  // ------------------------------------------------------------ lifecycle

  function setAudio(a) {
    audio = a;
    applyParams();
    for (const el of media) {
      const st = state.get(el);
      // A user change is a good moment to retry a player that only sounded
      // silent (not one whose URL rules it out).
      if (st.status === "cors" && st.why === "probe") setStatus(st, "idle");
      consider(el);
    }
    reportSoon();
  }

  function start() {
    if (active) return;
    active = true;
    observer = new MutationObserver(onMutations);
    observer.observe(document, { childList: true, subtree: true });
    const kick = () => scan(document);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", kick, { once: true });
    kick();
    // Media events don't bubble but do pass the capture phase: catch players
    // the observer missed (e.g. created before we started).
    for (const t of ["play", "loadedmetadata"]) {
      document.addEventListener(t, (e) => {
        if (e.target instanceof HTMLMediaElement) attach(e.target);
      }, true);
    }
  }

  async function hello() {
    let res = null;
    try {
      res = await api.runtime.sendMessage({ type: "forte:hello", host: location.hostname });
    } catch {
      return;
    }
    if (!res) return;
    settings = res.settings;
    site = res.site;
    off = res.off;
    audio = res.audio;
    if (chain) applyParams();
    if (!off) start();
    for (const el of media) consider(el);
    reportSoon();
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !settings) return undefined;
    switch (msg.type) {
      case "forte:apply":
        setAudio(msg.audio);
        return undefined;
      case "forte:levels": {
        const l = levels();
        return l ? Promise.resolve(l) : undefined;
      }
      case "forte:status":
        return Promise.resolve(summary());
      default:
        return undefined;
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) hello();
  });

  window.addEventListener("pagehide", () => send({ type: "forte:report", summary: { ...summary(), media: 0, counts: {} } }));
  window.addEventListener("pageshow", (e) => { if (e.persisted) reportSoon(); });

  hello();
})();

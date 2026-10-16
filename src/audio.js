// Emberwood sound: the weather you can hear. Rain on open ground and on the canopy, wind that
// rises with the simulated wind and comes in gusts, leaves rustling, surf near the sea, and thunder
// that arrives after the flash, later the farther away the strike was (sound covers about 343
// blocks a second, one block being a metre).
// Every sound plays from a sample file when the build has one (sfx/<name>.mp3, inlined by
// build.mjs as SFX_DATA); until then a stand-in is made on the spot from filtered noise, so the
// mix already works and each file just replaces its stand-in.
const SFX_DATA = /*SFX*/{};
// Loops play all the time with their volume following the weather; one-shots have numbered
// variants (thunder-near-1, -2, ...) picked at random.
const SFX_LOOPS = ['rain-light', 'rain-heavy', 'rain-leaves', 'wind-light', 'wind-strong', 'trees', 'surf'];
const SFX_SHOTS = { 'thunder-near': 3, 'thunder-far': 3, 'gust': 3 };

function createAudio() {
  let ctx = null, master = null, muffle = null, ready = false;
  const loops = {}, shots = {};
  let lastStrike = 0, gustT = 0, volume = 0.7, duck = 1;
  const rnd = Math.random;

  // ---- stand-in sounds ----
  const noiseBuf = (sec, kind) => {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0, p0 = 0, p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else if (kind === 'pink') { p0 = 0.997 * p0 + 0.029 * w; p1 = 0.985 * p1 + 0.032 * w; p2 = 0.95 * p2 + 0.048 * w; d[i] = (p0 + p1 + p2 + w * 0.05) * 2.2; }
        else d[i] = w * 0.5;
      }
      // cross-fade the ends so the loop has no click
      const f = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < f; i++) { const a = i / f; d[i] = d[i] * a + d[n - f + i] * (1 - a); }
    }
    return b;
  };
  // rain: a hiss of fine noise with scattered louder drops
  const rainBuf = (heavy, leaves) => {
    const sec = 6, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * (heavy ? 0.32 : 0.16);
      const drops = (leaves ? 900 : heavy ? 2200 : 500) * sec;
      for (let k = 0; k < drops; k++) {
        const at = Math.floor(rnd() * (n - 400)), a = (leaves ? 0.5 : 0.35) * (0.3 + rnd()), len = leaves ? 160 + rnd() * 240 : 40 + rnd() * 80, fr = leaves ? 0.05 + rnd() * 0.08 : 0.2 + rnd() * 0.3;
        for (let i = 0; i < len; i++) d[at + i] += Math.sin(i * fr * Math.PI) * a * Math.exp(-i / (len * 0.25));
      }
      const f = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < f; i++) { const a = i / f; d[i] = d[i] * a + d[n - f + i] * (1 - a); }
    }
    return b;
  };
  // thunder: a crack (near) and a long rolling rumble made of a few overlapping bursts
  const thunderBuf = near => {
    const sec = near ? 7 : 9, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate), sr = ctx.sampleRate;
    const bumps = []; for (let k = 0; k < 5 + Math.floor(rnd() * 4); k++) bumps.push([rnd() * sec * 0.55, 0.3 + rnd() * 0.7, 0.6 + rnd() * 1.6]);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, w = rnd() * 2 - 1;
        last = (last + 0.035 * w) / 1.035;
        let env = 0;
        for (const [t0, a, len] of bumps) if (t > t0) env += a * (1 - Math.exp(-(t - t0) * 6)) * Math.exp(-(t - t0) / len);
        env *= Math.exp(-t / (sec * 0.45));
        d[i] = last * 4 * env;
        if (near && t < 0.35) d[i] += w * Math.exp(-t * 14) * 0.9 * (t > 0.01 ? 1 : t / 0.01);
      }
    }
    return b;
  };
  const gustBuf = () => {
    const sec = 3.5, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) { const t = i / n; last = (last + 0.05 * (rnd() * 2 - 1)) / 1.05; d[i] = last * 3 * Math.sin(Math.PI * t) ** 2; }
    }
    return b;
  };
  // a loop: a buffer playing forever through an optional filter into its own gain
  const loop = (buf, filt) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0;
    let node = src;
    if (filt) for (const [type, f, q] of filt) { const bq = ctx.createBiquadFilter(); bq.type = type; bq.frequency.value = f; bq.Q.value = q || 0.7; node.connect(bq); node = bq; }
    node.connect(g); g.connect(muffle);
    src.start(0, rnd() * buf.duration);
    return { src, g, filt: node instanceof BiquadFilterNode ? node : null };
  };
  const decode = name => {
    const url = SFX_DATA[name];
    if (!url) return Promise.resolve(null);
    // inlined as base64 (a data: fetch can be blocked by the page's content policy)
    try {
      const bin = atob(url.slice(url.indexOf(',') + 1)), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return ctx.decodeAudioData(a.buffer).catch(() => null);
    } catch (e) { return Promise.resolve(null); }
  };
  const STAND_IN = {
    'rain-light': () => [rainBuf(false, false), [['highpass', 900], ['lowpass', 9000]]],
    'rain-heavy': () => [rainBuf(true, false), [['highpass', 400], ['lowpass', 7000]]],
    'rain-leaves': () => [rainBuf(false, true), [['bandpass', 2200, 0.5]]],
    'wind-light': () => [noiseBuf(8, 'brown'), [['lowpass', 500]]],
    'wind-strong': () => [noiseBuf(8, 'pink'), [['bandpass', 700, 0.6]]],
    'trees': () => [noiseBuf(6, 'white'), [['highpass', 2500], ['lowpass', 7000]]],
    'surf': () => [noiseBuf(8, 'brown'), [['lowpass', 900]]],
  };

  async function build() {
    master = ctx.createGain(); master.gain.value = 0;
    muffle = ctx.createBiquadFilter(); muffle.type = 'lowpass'; muffle.frequency.value = 20000;
    muffle.connect(master); master.connect(ctx.destination);
    for (const name of SFX_LOOPS) {
      const file = await decode(name);
      if (file) loops[name] = loop(file, null);
      else { const [b, f] = STAND_IN[name](); loops[name] = loop(b, f); }
    }
    for (const [name, count] of Object.entries(SFX_SHOTS)) {
      shots[name] = [];
      for (let i = 1; i <= count; i++) { const f = await decode(`${name}-${i}`); if (f) shots[name].push(f); }
      if (!shots[name].length) {
        if (name === 'gust') shots[name].push(gustBuf(), gustBuf());
        else for (let i = 0; i < 2; i++) shots[name].push(thunderBuf(name === 'thunder-near'));
      }
    }
    ready = true;
  }
  // a one-shot at time t through a low-pass that dulls it with distance
  function shot(name, t, gain, cutoff, pan) {
    const list = shots[name]; if (!list || !list.length) return;
    const src = ctx.createBufferSource(); src.buffer = list[Math.floor(rnd() * list.length)];
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff;
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(lp); lp.connect(g);
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(muffle); } else g.connect(muffle);
    src.playbackRate.value = 0.92 + rnd() * 0.16;
    src.start(t);
  }
  const set = (name, v, k = 0.4) => { const l = loops[name]; if (l) l.g.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, k); };

  return {
    // browsers only start sound after a click or key press
    unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        build().catch(e => console.warn('audio', e));
      }
      if (ctx.state === 'suspended') ctx.resume();
    },
    pause(p) { if (ctx) p ? ctx.suspend() : ctx.resume(); },
    get ready() { return ready; },
    get files() { return Object.keys(SFX_DATA); },
    // w: what the weather is doing at the player (see main.js)
    update(dt, w) {
      if (!ready) return;
      const now = ctx.currentTime;
      volume = w.volume; duck += ((w.playing ? 1 : 0.35) - duck) * Math.min(1, dt * 2);
      master.gain.setTargetAtTime(volume * volume * duck, now, 0.15);
      // under water everything is dull; under a roof the rain and wind are muffled
      muffle.frequency.setTargetAtTime(w.underwater ? 450 : w.roof ? 1800 : 20000, now, 0.1);
      const r = w.rain, open = 1 - w.canopy * 0.65;
      set('rain-light', Math.min(1, r * 2.5) * (1 - aSmooth((r - 0.35) / 0.4)) * 0.55 * open);
      set('rain-heavy', aSmooth((r - 0.25) / 0.5) * 0.8 * open);
      set('rain-leaves', Math.min(1, r * 2) * w.canopy * 0.7);
      // wind, louder up high; snow storms are all wind
      const s = w.wind * (1 + Math.max(0, w.height - 70) / 120);
      set('wind-light', aSmooth(s / 1.2) * 0.35 * (1 - 0.5 * aSmooth((s - 1.6) / 1)), 0.25);
      set('wind-strong', aSmooth((s - 1.1) / 1.4) * 0.6, 0.25);
      const ws = loops['wind-light']; if (ws && ws.filt) ws.filt.frequency.setTargetAtTime(300 + s * 350, now, 0.3);
      set('trees', Math.min(1, w.trees) * aSmooth((w.wind - 0.2) / 1.5) * 0.35 * (0.6 + 0.4 * Math.min(2, w.gust - 0.6)), 0.2);
      set('surf', w.sea * (0.25 + 0.45 * Math.min(1, w.seaState / 1.6)), 1);
      // gusts: an extra rush when the wind picks up sharply
      gustT -= dt;
      if (w.gust > 1.5 && w.wind > 0.9 && gustT <= 0) { shot('gust', now, Math.min(0.6, (w.gust - 1.3) * 0.5), 6000, rnd() * 1.4 - 0.7); gustT = 4 + rnd() * 5; }
      // thunder, after the flash
      const f = w.flash;
      if (f && f.seed !== lastStrike) {
        lastStrike = f.seed;
        const dx = f.x - w.x, dz = f.z - w.z, d = Math.hypot(dx, dz);
        if (d < 9000) {
          const near = d < 900;
          const pan = (dx * w.right[0] + dz * w.right[2]) / (d || 1);
          shot(near ? 'thunder-near' : 'thunder-far', now + d / 343, Math.min(1, 1.3 / (1 + d / 700)), near ? 12000 : 9000 / (1 + d / 900), pan * 0.8);
        }
      }
    },
  };
}
const aSmooth = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

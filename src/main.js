// Emberwood main thread: rendering, chunk streaming, player, UI.
(() => {
const BUILD = '/*BUILD*/';
const CS = 32, CH = 124, P = CS + 2, WL = 30;
const B = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5, OAK_LOG: 6, BIRCH_LOG: 7, SPRUCE_LOG: 8,
  LEAF_RED: 9, LEAF_ORANGE: 10, LEAF_YELLOW: 11, LEAF_BROWN: 12, LEAF_GREEN: 13, LITTER: 14, MOSSY: 15, PLANKS: 16, REED: 27, TUFT: 28, TWIG: 29, SALT: 30 };
const isPlant = b => b === B.REED || b === B.TUFT;
const FLOW1 = 17, FALL = 24;
const isW = b => b === B.WATER || (b >= FLOW1 && b <= FALL);
const lvlOf = b => (b === B.WATER || b === FALL) ? 8 : (b >= FLOW1 && b < FALL) ? b - 16 : 0;
const HOTBAR = [
  { b: B.OAK_LOG, name: 'Oak log', col: '#5c3f27' },
  { b: B.BIRCH_LOG, name: 'Birch log', col: '#e3ddd0' },
  { b: B.PLANKS, name: 'Planks', col: '#a87b4b' },
  { b: B.LEAF_RED, name: 'Maple leaves', col: '#b51f10' },
  { b: B.LEAF_ORANGE, name: 'Orange leaves', col: '#e3681a' },
  { b: B.LEAF_YELLOW, name: 'Birch leaves', col: '#ecb526' },
  { b: B.STONE, name: 'Stone', col: '#807d78' },
  { b: B.MOSSY, name: 'Mossy stone', col: '#5f6a3c' },
  { b: B.WATER, name: 'Water', col: '#2f6f86' },
];

// ---------- settings ----------
const FX_DEFAULTS = { bloom: true, rays: true, ssao: true, dof: true, motion: true, flare: true, ssr: true,
  caustics: true, ocean: true, mist: true, clouds: true, cloudSim: true,
  // volumetric cloud render scale (of the screen); phones default to lower
  cloudQ: matchMedia('(pointer: coarse)').matches ? 1 : 2, ca: true, fxaa: true, look: 0, exposure: 0.95 };
const LOOKS = ['Cinematic', 'Painted', 'Ink', 'Retro'];
const ENV_DEFAULTS = { envTemp: 0, envHumid: 1, envClouds: 1, envStorms: 1, envRain: 1, envFog: 1 };
const settings = { rd: 8, leaves: 8000, shadows: true, tod: 15.5, daylen: 20, wind: 1, seed: 1337, season: 2, volume: 0.7, ...ENV_DEFAULTS, fx: { ...FX_DEFAULTS } };
try {
  const saved = JSON.parse(localStorage.getItem('emberwood.settings') || '{}');
  Object.assign(settings, saved);
  settings.fx = { ...FX_DEFAULTS, ...(saved.fx || {}) };
  // phone GPUs read the depth buffer too coarsely for screen-space reflections (striped water);
  // switch them off once on touch devices, players can turn them back on
  if (matchMedia('(pointer: coarse)').matches && !saved.ssrPhoneOff) { settings.fx.ssr = false; settings.ssrPhoneOff = true; }
} catch (e) {}
// seasons: 0 spring, 1 summer, 2 autumn, 3 winter. Colours blend smoothly through seasonVis;
// winter also regrows the chunks with bare deciduous trees.
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const MONTHS = ['Early May', 'Midsummer', 'Late October', 'Deep January'];
const SUBS = [
  'A whole planet of drifting plates, rain-cut valleys and rivers, and you in its forests. Maples in blossom, fresh leaves on the birches, reeds greening along the water.',
  'A whole planet of drifting plates, rain-cut valleys and rivers, and you in its forests. Deep green canopies, tall grass and reeds, long warm light.',
  'A whole planet of drifting plates, rain-cut valleys and rivers, and you in its autumn forests. Maples gone scarlet, birches in gold, leaves drifting down through low afternoon light.',
  'A whole planet of drifting plates, rain-cut valleys and rivers, and you in its forests. Bare branches, snow on the spruces, flakes drifting through the cold low sun.'];
let seasonVis = 2;
const seasonW = i => { const d = Math.abs(((seasonVis - i) % 4 + 6) % 4 - 2); return Math.max(0, 1 - d); };
const saveSettings = () => { try { localStorage.setItem('emberwood.settings', JSON.stringify(settings)); } catch (e) {} };

// ---------- GL setup ----------
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
if (!gl) {
  document.getElementById('menu-sub').textContent = 'This browser has no WebGL2, which Emberwood needs to draw the forest.';
  return;
}
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const locs = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); locs[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name); }
  return { p, u: locs };
}
const progs = {
  terrain: program(VS_TERRAIN, FS_TERRAIN),
  water: program(VS_TERRAIN, FS_WATER),
  shadow: program(VS_SHADOW, FS_SHADOW),
  sky: program(VS_SKY, FS_SKY),
  leaf: program(VS_LEAF, FS_LEAF),
  line: program(VS_LINE, FS_LINE),
  bolt: program(VS_BOLT, FS_BOLT),
};
const post = createPost(gl, program, setU, setI);
const ocean = createOcean(gl, program, setU, setI, post.hasFloat);
const boat = createBoat(gl, program, setU);
function setU(prog, name, v) {
  const l = prog.u[name];
  if (l === undefined || l === null) return;
  if (typeof v === 'number') gl.uniform1f(l, v);
  else if (v.length === 2) gl.uniform2fv(l, v);
  else if (v.length === 3) gl.uniform3fv(l, v);
  else if (v.length === 4) gl.uniform4fv(l, v);
  else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
}
function setI(prog, name, v) { const l = prog.u[name]; if (l) gl.uniform1i(l, v); }

// shared quad index buffer
const ibo = gl.createBuffer();
let iboQuads = 0;
function ensureIbo(quads) {
  if (quads <= iboQuads) return;
  iboQuads = Math.max(quads, iboQuads * 2, 32768);
  const idx = new Uint32Array(iboQuads * 6);
  for (let q = 0, v = 0, i = 0; q < iboQuads; q++, v += 4) {
    idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2; idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
}
ensureIbo(32768);
function makeMesh(data) {
  if (!data.length) return null;
  ensureIbo(data.length / 4);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bindVertexArray(null);
  return { vao, buf, count: (data.length / 4) * 6 };
}
function freeMesh(m) { if (m) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.buf); } }

// shadow map
const SHADOW_SIZE = 2048, SHADOW_R = 72;
const shadowTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, shadowTex);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
const shadowFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);

// toroidal ground-height map used to stop falling leaves at the ground
const HM = 512;
const heightCPU = new Uint8Array(HM * HM);
const heightTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, heightTex);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, HM, HM);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
function uploadHeights(cx, cz, hts) {
  const x0 = ((cx * CS) % HM + HM) % HM, z0 = ((cz * CS) % HM + HM) % HM;
  for (let z = 0; z < CS; z++) heightCPU.set(hts.subarray(z * CS, z * CS + CS), (z0 + z) * HM + x0);
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, z0, CS, CS, gl.RED, gl.UNSIGNED_BYTE, hts);
}

// leaf emitters: undersides of nearby leaf blocks, read by the falling-leaf shader
const EMIT_W = 512, EMIT_H = 64, EMIT_R = 2;
const emitTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, emitTex);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, EMIT_W, EMIT_H);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
const emitData = new Float32Array(EMIT_W * EMIT_H * 4);
// Emitters: leaf blocks over open air (types 9..12) first, then spray sources after them
// (60 waterfall feet, 61 surf on the shore), from foamBase to foamBase + foamCount.
let emitCount = 0, emitDirty = true, emitCenter = '', emitT = 0, foamBase = 0, foamCount = 0;
function rebuildEmitters() {
  const pcx = Math.floor(state.pos[0] / CS), pcz = Math.floor(state.pos[2] / CS);
  const list = [];
  let total = 0;
  for (let dz = -EMIT_R; dz <= EMIT_R; dz++) for (let dx = -EMIT_R; dx <= EMIT_R; dx++) {
    const ch = chunks.get(ckey(pcx + dx, pcz + dz));
    if (ch && ch.emit && ch.emit.length) { list.push(ch); total += ch.emit.length; }
  }
  const FOAM_CAP = 4096, cap = EMIT_W * EMIT_H - FOAM_CAP, stride = Math.max(1, total / cap);
  let n = 0, acc = 0;
  const foam = [];
  for (const ch of list) for (const v of ch.emit) {
    if ((v >> 20) >= 60) { if (foam.length < FOAM_CAP) foam.push(ch, v); continue; }
    acc += 1;
    if (acc < stride) continue;
    acc -= stride;
    if (n >= cap) break;
    emitData[n * 4] = ch.cx * CS + (v & 63);
    emitData[n * 4 + 1] = (v >> 6) & 127;
    emitData[n * 4 + 2] = ch.cz * CS + ((v >> 13) & 63);
    emitData[n * 4 + 3] = (v >> 20) & 255;
    n++;
  }
  emitCount = n; foamBase = n; foamCount = foam.length / 2;
  for (let i = 0; i < foam.length; i += 2) {
    const ch = foam[i], v = foam[i + 1];
    emitData[n * 4] = ch.cx * CS + (v & 63);
    emitData[n * 4 + 1] = (v >> 6) & 127;
    emitData[n * 4 + 2] = ch.cz * CS + ((v >> 13) & 63);
    emitData[n * 4 + 3] = (v >> 20) & 255;
    n++;
  }
  if (n) {
    const rows = Math.ceil(n / EMIT_W);
    gl.bindTexture(gl.TEXTURE_2D, emitTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, EMIT_W, rows, gl.RGBA, gl.FLOAT, emitData.subarray(0, rows * EMIT_W * 4));
  }
}

// selection box lines
const lineVao = gl.createVertexArray();
gl.bindVertexArray(lineVao);
{
  const e = [];
  const c = [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,1,0],[1,1,0],[1,1,1],[0,1,1]];
  const pairs = [0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7];
  for (const i of pairs) e.push(...c[i]);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(e), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
}
const emptyVao = gl.createVertexArray();
// ---------- weather ----------
const weather = createWeather(gl);
// The global atmosphere: the whole planet's weather in layers, simulated on the GPU. It needs
// float render targets; without them (or if it fails to start) the local sim's own scripted
// large-scale weather is used instead.
let atmos = null;
try { if (post.hasFloat && !/cpuwx/.test(location.hash)) { const nx = +((location.hash.match(/wxnx=(\d+)/) || [])[1] || 512); atmos = createAtmosphere(gl, { nx, ny: nx / 2 }); } } catch (e) { console.warn('global weather off:', e); atmos = null; }
const atm = { spun: 0, acc: 0, winT: 0, globT: 0, SPIN: +((location.hash.match(/wxspin=(\d+)/) || [])[1] || 1600) };
// step the global atmosphere in time with the game (one step per quarter second of game time),
// spin it up from rest over the first frames after the planet arrives, and keep its packed views
// of the player's surroundings and of the globe fresh. The local sim switches over once spun up.
function atmosStep(dt) {
  if (!atmos || !weather.ready) return;
  atmos.tod = settings.tod; atmos.playerX = state.pos[0]; atmos.playerZ = state.pos[2];
  atmos.season = [0, 1, 0, -1][settings.season] || 0; atmos.temp = settings.envTemp; atmos.humid = settings.envHumid; atmos.stormMul = settings.envStorms;
  if (atm.spun < atm.SPIN) {
    const n = Math.min(atm.SPIN - atm.spun, 10);
    atmos.run(n); atm.spun += n;
  } else {
    atm.acc += dt;
    const n = Math.min(4, Math.floor(atm.acc / 0.25));
    if (n > 0) { atmos.run(n); atm.acc -= n * 0.25; }
    if (atm.acc > 1) atm.acc = 0;
  }
  atmos.collect(false);
  atm.winT -= dt; atm.globT -= dt;
  if (atm.spun >= atm.SPIN && atm.winT <= 0) {
    const want = atm.globT <= 0;
    atmos.request(Math.floor(state.pos[0] / 16) - (atmos.win.w >> 1), Math.floor(state.pos[2] / 16) - (atmos.win.h >> 1), want);
    atm.winT = 0.25; if (want) atm.globT = 1;
  }
  weather.atmos = atmos.win.ready ? atmos : null;
}
const localWind = [0.7, 0.2], cloudWind = [0, 0];
let cloudMean = 0.3;
const cloudsOn = () => settings.fx.clouds && weather.ready;
// ---------- sound ----------
const audio = createAudio();
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, () => { if (settings.volume > 0) audio.unlock(); }, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => audio.pause(document.hidden));
// what is overhead (leaves, a roof) and how many trees are about, checked a few times a second
const hear = { canopy: 0, roof: 0, trees: 0, t: 0 };
function listenAround() {
  const [x, y, z] = state.pos;
  let leaf = 0, roof = 0;
  for (let k = 2; k < 24; k++) {
    const b = getBlock(Math.floor(x), Math.floor(y + k), Math.floor(z));
    if (b >= 9 && b <= 13 || b === 29) { leaf = 1; continue; }
    if (b && !isW(b) && b !== 27 && b !== 28) { roof = 1; break; }
  }
  hear.canopy += (leaf - hear.canopy) * 0.3; hear.roof = roof;
  hear.trees = Math.min(1, emitCount / 600 + leaf * 0.4);
}
// a few words on the weather for the corner readout
const baro = { t: 0, hist: [] };
function weatherWords() {
  if (!weather.ready) return '';
  const [x, , z] = state.pos, ty = weather.typeAt(x, z);
  const T = Math.round(env.temp), ms = Math.round(env.windSpeed * 6);
  let sky = !ty ? '' : ty.cover < 0.2 ? 'clear' : ty.cover < 0.45 ? 'fair' : ty.cover < 0.75 ? 'cloudy' : 'overcast';
  const p = env.precip;
  if (p > 0.04) {
    const kind = env.snowFrac > 0.75 ? 'snow' : env.snowFrac > 0.25 ? 'sleet' : 'rain';
    sky = (p < 0.2 ? (kind === 'rain' ? 'drizzle' : 'light ' + kind) : p > 0.6 ? 'heavy ' + kind : kind);
  }
  if (ty && ty.tops > 0.66 && ty.conv > 0.45 && ty.cover > 0.7) sky += ', thunder';
  if (env.fog2[0] > 0.008 || env.hill > 0.4) sky += ', fog';
  if (env.bow > 0.3) sky += ', rainbow';
  const wind = ms < 2 ? 'calm' : ms < 6 ? `light wind ${ms} m/s` : ms < 12 ? `breezy ${ms} m/s` : ms < 18 ? `strong wind ${ms} m/s` : `gale ${ms} m/s`;
  // the barometer: pressure and which way it has gone over the last game hour or so
  const hpa = weather.pressureAt(x, z), now = performance.now();
  if (!baro.t || now - baro.t > 2500) { baro.hist.push(hpa); if (baro.hist.length > 24) baro.hist.shift(); baro.t = now; }
  const dp = hpa - baro.hist[0], tr = baro.hist.length < 6 ? '' : dp < -1.2 ? ' falling' : dp > 1.2 ? ' rising' : ' steady';
  return `${T} °C · ${sky} · ${wind} · ${Math.round(hpa)} hPa${tr}`;
}
gl.bindVertexArray(null);

// ---------- math ----------
const M = {
  persp(fovy, a, n, f) { const t = 1 / Math.tan(fovy / 2); return new Float32Array([t / a,0,0,0, 0,t,0,0, 0,0,(f + n) / (n - f),-1, 0,0,2 * f * n / (n - f),0]); },
  ortho(l, r, b, t, n, f) { return new Float32Array([2 / (r - l),0,0,0, 0,2 / (t - b),0,0, 0,0,-2 / (f - n),0, -(r + l) / (r - l),-(t + b) / (t - b),-(f + n) / (f - n),1]); },
  lookAt(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  },
  planes(m) {
    const pl = [];
    for (const [i, sgn] of [[0,1],[0,-1],[1,1],[1,-1],[2,1],[2,-1]]) {
      const a = m[3] + sgn * m[i], b = m[7] + sgn * m[4 + i], c = m[11] + sgn * m[8 + i], d = m[15] + sgn * m[12 + i];
      pl.push([a, b, c, d]);
    }
    return pl;
  },
  boxVisible(pl, x0, y0, z0, x1, y1, z1) {
    for (const p of pl) {
      const x = p[0] > 0 ? x1 : x0, y = p[1] > 0 ? y1 : y0, z = p[2] > 0 ? z1 : z0;
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
  },
};

// ---------- world / chunks ----------
const chunks = new Map();
const ckey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
let worldGen = 0;
const workerSrc = document.getElementById('worker-src').textContent;
const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
const NW = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
const workers = [];
const results = [];
for (let i = 0; i < NW; i++) {
  const w = new Worker(workerUrl);
  w.jobs = 0;
  w.onmessage = e => {
    const d = e.data;
    if (d.type === 'error') { onWorkerError(w, d); return; }
    if (d.type) { onPlanetMessage(d); return; }
    w.jobs--; results.push(d);
  };
  workers.push(w);
}
// Errors are shown in a corner (so they can be reported) and the game keeps running.
const errRetries = new Map();
let errBox = null;
function reportError(text) {
  console.error(text);
  if (!errBox) {
    errBox = document.createElement('div');
    errBox.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:min(560px,calc(100vw - 24px));z-index:50;font:11px/1.45 var(--mono);color:#f2e4cf;background:rgba(60,14,8,.88);border:1px solid #b8461c;border-radius:4px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;cursor:pointer';
    errBox.title = 'Click to hide';
    errBox.addEventListener('click', () => { errBox.hidden = true; });
    document.body.appendChild(errBox);
  }
  errBox.hidden = false;
  let where = '';
  try { where = ` · x ${state.pos[0].toFixed(0)} z ${state.pos[2].toFixed(0)}`; } catch (e) {}
  errBox.textContent = `Emberwood hit an error (it kept running). A screenshot of this helps fix it.\n${BUILD} · seed ${settings.seed}${where}\n${String(text).slice(0, 500)}`;
}
function onWorkerError(w, d) {
  if (d.job === 'chunk') w.jobs--;
  reportError('worker: ' + d.msg);
  if (d.job !== 'chunk' || d.gen !== worldGen) return;
  // let the chunk be asked for again, twice at most
  const k = ckey(d.cx, d.cz), ch = chunks.get(k), n = (errRetries.get(k) || 0) + 1;
  errRetries.set(k, n);
  if (ch) { ch.busy = false; if (ch.state === 'pending' && n <= 2) chunks.delete(k); }
}
window.addEventListener('error', e => reportError(e.message + (e.filename ? ' @' + e.lineno + ':' + e.colno : '')));
window.addEventListener('unhandledrejection', e => reportError('promise: ' + (e.reason && e.reason.stack || e.reason)));
const inflight = () => workers.reduce((s, w) => s + w.jobs, 0);

// ---------- planet ----------
// Every worker simulates the planet from the seed; the first one reports progress and sends
// the summary maps used to pick a spawn point and draw the globe and the map.
let planet = null, planetText = 'Forming the planet…';
function requestPlanet() {
  planet = null; weather.reset(null);
  workers.forEach((w, i) => w.postMessage({ type: 'planet', seed: settings.seed, gen: worldGen, report: i === 0 }));
}
function onPlanetMessage(d) {
  if (d.type === 'progress') { planetText = d.text + '…'; return; }
  if (d.type !== 'planet' || d.gen !== worldGen) return;
  planet = d;
  buildPlanetMap();
  if (!state.restoring) {
    const sp = pickSpawn();
    state.pos = [sp[0], 72, sp[1]];
  }
}
const PLANET_W = 512 * 16, PLANET_H = 256 * 16;
// ---- planet map and globe ----
const BIOME_COL = [[38, 74, 120], [232, 238, 244], [150, 146, 118], [58, 96, 66], [196, 112, 44], [164, 160, 88], [214, 190, 132], [70, 140, 58], [186, 168, 70], [128, 138, 84]];
let mapPx = null;
function buildPlanetMap() {
  const { ys, riv, lk, tmp, biome, PW, PH } = planet;
  mapPx = new Uint8ClampedArray(PW * PH * 4);
  for (let j = 0; j < PH; j++)
    for (let i = 0; i < PW; i++) {
      const k = j * PW + i, y = ys[k];
      let c;
      if (lk[k]) c = [58, 112, 170];
      else if (y < 30) {
        const d = Math.max(0, Math.min(1, (30 - y) / 20));
        c = tmp[k] < -3 ? [214, 226, 236] : [46 - d * 26, 98 - d * 52, 150 - d * 58];
      } else if (riv[k] > 8) c = [52, 104, 176];
      else {
        const ke = j * PW + (i + 1) % PW, ks = Math.min(PH - 1, j + 1) * PW + i;
        const sh = Math.max(0.55, Math.min(1.35, 1 + (y - ys[ke] + y - ys[ks]) * 0.09));
        const b = tmp[k] - (y - 31) * 0.25 < -3 ? [236, 240, 244] : BIOME_COL[biome[k]];
        const lift = Math.min(1, (y - 30) / 30);
        c = [0, 1, 2].map(q => (b[q] * (1 - lift * 0.35) + 150 * lift * 0.35) * sh);
      }
      const o = k * 4; mapPx[o] = c[0]; mapPx[o + 1] = c[1]; mapPx[o + 2] = c[2]; mapPx[o + 3] = 255;
    }
  const mc = $('map'); mc.width = PW * MAP_S; mc.height = PH * MAP_S;
  globeT = 0;
  mapModes = [mapPx];
  for (const k in overlayCache) delete overlayCache[k];
  mapBase = null; trail.length = 0;
}
// Map views: the playable terrain map plus the planet simulation's own fields
const MAP_MODES = [
  ['Terrain', 'Biomes, snow, lakes and rivers as you will find them on the ground'],
  ['Plates', 'Elevation, with the tectonic plate boundaries in red'],
  ['Rain', 'Rainfall from the prevailing winds: dry tan, wet blue; rain shadows sit behind ranges'],
  ['Temperature', 'Cold blue to hot red, falling with latitude and height'],
  ['Drainage', 'How much rain each cell gathers from upstream: the river network'],
  ['Rivers', 'Rivers by size, lakes and deltas over the biomes'],
  ['Currents', 'Sea temperature against the average for its latitude: warm currents red, cold blue', ['linear-gradient(90deg,#2850d2,#ebebe6,#d23228)', '−6°C', '+6°C']],
  ['Rain season', 'When the rain falls: green all year, orange mostly in summer, purple mostly in winter; white salt pans', ['linear-gradient(90deg,#8c50be,#3c9646,#e68c28)', 'winter rain', 'summer rain']],
  ['Moisture', 'Rain against what the warmth could evaporate: parched brown, balanced yellow, wet green to blue', ['linear-gradient(90deg,#a05a28,#e6d278,#50aa50,#2850c8)', 'parched', 'wet']],
  ['July', 'Temperature in July (northern summer, southern winter)', ['linear-gradient(90deg,#3c5ac8,#ebebdc,#d24628)', '−20°C', '+30°C']],
  ['January', 'Temperature in January (northern winter, southern summer)', ['linear-gradient(90deg,#3c5ac8,#ebebdc,#d24628)', '−20°C', '+30°C']],
  ['Sediment', 'Where eroded rock settled: fans at mountain fronts, river plains, filled lakes and deltas', ['linear-gradient(90deg,#1e2024,#a07838,#ffe6a0)', 'none', 'thick']],
];
// keys for the views: 1-9, then 0, - and =
const MAP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const MAP_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];
let mapModes = [], mapMode = 0;
// temperature in July (hs 1) or January (hs -1): the year's mean plus the swing, which runs the
// other way south of the equator
function seasonT(k, hs) { const j = Math.floor(k / planet.PW); return planet.L.temp[k] + planet.L.tAmp[k] * hs * (j < planet.PH / 2 ? 1 : -1); }
function buildMapMode(m) {
  const { PW, PH, L, biome } = planet, PN = PW * PH, px = new Uint8ClampedArray(PN * 4);
  const lerp = (a, b, t) => { t = Math.max(0, Math.min(1, t)); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
  const E = L.elev;
  const shade = k => { const i = k % PW, j = (k - i) / PW, ke = j * PW + (i + 1) % PW, ks = Math.min(PH - 1, j + 1) * PW + i; return Math.max(0.5, Math.min(1.4, 1 + (E[k] - E[ke] + E[k] - E[ks]) * 5)); };
  const sea = k => lerp([60, 110, 165], [18, 38, 78], -E[k] / 1.2);
  const isRiv = k => planet.riv[k] > 8; // (1..8 are headwater brooks)
  let hi = 1;
  if (m === 2) { const rs = Float32Array.from(L.rain).sort(); hi = rs[Math.floor(PN * 0.98)] || 1; }
  for (let k = 0; k < PN; k++) {
    const i = k % PW, j = (k - i) / PW;
    let c;
    if (m === 1) {
      c = E[k] <= 0 ? sea(k) : lerp([96, 140, 76], [235, 225, 205], E[k] / 1.6).map(v => v * shade(k));
      if (L.plate[k] !== L.plate[j * PW + (i + 1) % PW] || (j + 1 < PH && L.plate[k] !== L.plate[k + PW])) c = [230, 60, 40];
    } else if (m === 2) {
      const t = L.rain[k] / hi;
      c = t < 0.5 ? lerp([196, 160, 92], [120, 170, 90], t * 2) : lerp([120, 170, 90], [40, 90, 200], (t - 0.5) * 2);
      c = E[k] <= 0 ? lerp(c, [20, 30, 50], 0.6) : c.map(v => v * shade(k));
    } else if (m === 3) {
      const t = (L.temp[k] + 20) / 50;
      c = t < 0.5 ? lerp([60, 90, 200], [235, 235, 220], t * 2) : lerp([235, 235, 220], [210, 70, 40], (t - 0.5) * 2);
      if (E[k] <= 0) c = lerp(c, [20, 30, 50], 0.55);
    } else if (m === 4) {
      c = E[k] <= 0 ? [14, 22, 36] : lerp([28, 30, 34], [120, 220, 255], Math.pow(Math.log(1 + L.acc[k]) / Math.log(201), 0.8));
      if (L.lake[k]) c = [70, 120, 220];
    } else if (m === 6) {
      // the sea's warmth beside the plain latitude curve (planetTemp): the currents' doing
      const s = Math.abs(Math.sin(Math.PI / 2 - (j + 0.5) / PH * Math.PI)), a = (L.sst[k] - Math.max(-1.8, 28 - 40 * Math.pow(s, 2.5))) / 6;
      c = E[k] > 0 ? [70, 70, 70].map(v => v * shade(k)) : a > 0 ? lerp([235, 235, 230], [210, 50, 40], a) : lerp([235, 235, 230], [40, 80, 210], -a);
    } else if (m === 7) {
      const north = j < PH / 2, rs = north ? L.rJul[k] : L.rJan[k], rw = north ? L.rJan[k] : L.rJul[k], tot = rs + rw;
      const t = Math.min(1, Math.sqrt(tot / 1.2)), d = tot > 1e-6 ? (rs - rw) / tot : 0;
      c = lerp([200, 190, 160], d > 0 ? lerp([60, 150, 70], [230, 140, 40], d * 1.6) : lerp([60, 150, 70], [140, 80, 190], -d * 1.6), t);
      c = E[k] <= 0 ? lerp(c, [20, 30, 50], 0.7) : L.salt[k] ? [250, 250, 245] : c.map(v => v * shade(k));
    } else if (m === 8) {
      const t = L.moist[k];
      c = t < 0.35 ? lerp([160, 90, 40], [230, 210, 120], t / 0.35) : t < 0.6 ? lerp([230, 210, 120], [80, 170, 80], (t - 0.35) / 0.25) : lerp([80, 170, 80], [40, 80, 200], (t - 0.6) / 0.3);
      c = E[k] <= 0 ? [20, 30, 50] : L.salt[k] ? [250, 250, 245] : c.map(v => v * shade(k));
    } else if (m === 9 || m === 10) {
      const t = (seasonT(k, m === 9 ? 1 : -1) + 20) / 50;
      c = t < 0.5 ? lerp([60, 90, 200], [235, 235, 220], t * 2) : lerp([235, 235, 220], [210, 70, 40], (t - 0.5) * 2);
      if (E[k] <= 0) c = lerp(c, [20, 30, 50], 0.55);
    } else if (m === 11) {
      const t = Math.min(1, Math.sqrt(L.dep[k] / 0.12));
      c = E[k] <= 0 ? lerp([14, 22, 36], [90, 110, 120], t) : lerp([30, 32, 36], [160, 120, 56], Math.min(1, t * 2)).map((v, q) => t > 0.5 ? v + ([255, 230, 160][q] - v) * (t - 0.5) * 2 : v).map(v => v * shade(k));
    } else {
      c = E[k] <= 0 ? sea(k) : lerp(BIOME_COL[biome[k]], [255, 255, 255], 0.35).map(v => v * shade(k));
      if (L.lake[k]) c = [60, 120, 210];
      else if (isRiv(k)) c = lerp([110, 170, 240], [20, 60, 200], Math.log(L.acc[k] / 2.2) / Math.log(60));
    }
    const o = k * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  return px;
}
function setMapMode(m) {
  mapMode = m;
  if (planet && planet.L && !mapModes[m]) mapModes[m] = buildMapMode(m);
  [...document.querySelectorAll('#mapmodes button')].forEach((b, i) => b.setAttribute('aria-pressed', String(i === m)));
  const lg = MAP_MODES[m][2];
  $('mapdesc').textContent = MAP_MODES[m][1];
  if (lg) $('mapdesc').insertAdjacentHTML('beforeend', ` <span class="maplg"><i>${lg[1]}</i><b style="background:${lg[0]}"></b><i>${lg[2]}</i></span>`);
  drawMap();
}
let globeT = 0, globeSpin = 0;
function drawGlobe(now, dt) {
  if (!mapPx || now - globeT < 60) return;
  globeT = now; globeSpin += 0.0015 * 60;
  const cv = $('globe'), g = cv.getContext('2d'), N = cv.width, img = g.createImageData(N, N), d = img.data;
  const { PW, PH } = planet;
  const lon0 = state.pos[0] / PLANET_W * Math.PI * 2 + globeSpin * 0.02, lat0 = latOf(state.pos[2]) * Math.PI / 180 * 0.6;
  const cl = Math.cos(lat0), sl = Math.sin(lat0), R = N / 2 - 1;
  const plon = state.pos[0] / PLANET_W * Math.PI * 2, plat = latOf(state.pos[2]) * Math.PI / 180;
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5 - N / 2) / R, y = (N / 2 - py - 0.5) / R, r2 = x * x + y * y;
      if (r2 > 1) continue;
      const z = Math.sqrt(1 - r2);
      // rotate view: tilt by lat0 around x, then spin by lon0 around y
      const yy = y * cl + z * sl, zz = -y * sl + z * cl;
      const lat = Math.asin(Math.max(-1, Math.min(1, yy)));
      let lon = Math.atan2(x, zz) + lon0;
      lon = ((lon % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const i = Math.min(PW - 1, Math.floor(lon / (Math.PI * 2) * PW)), j = Math.min(PH - 1, Math.floor((Math.PI / 2 - lat) / Math.PI * PH));
      const s = (j * PW + i) * 4, o = (py * N + px) * 4;
      const light = 0.35 + 0.75 * Math.max(0, x * -0.45 + y * 0.35 + z * 0.82), rim = Math.pow(1 - z, 3) * 0.6;
      d[o] = mapPx[s] * light + 90 * rim; d[o + 1] = mapPx[s + 1] * light + 120 * rim; d[o + 2] = mapPx[s + 2] * light + 170 * rim; d[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  // the player, when on the visible side
  const vx = Math.cos(plat) * Math.sin(plon - lon0), vy0 = Math.sin(plat), vz0 = Math.cos(plat) * Math.cos(plon - lon0);
  const vy = vy0 * cl - vz0 * sl, vz = vy0 * sl + vz0 * cl;
  if (vz > 0) {
    g.fillStyle = '#e8743b'; g.strokeStyle = '#1a110b'; g.lineWidth = 2;
    g.beginPath(); g.arc(N / 2 + vx * R, N / 2 - vy * R, 5, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}
// Map overlays: layers drawn over whichever view is showing. The map canvas is drawn at MAP_S x
// the planet grid so lines and arrows stay crisp. Static layers are cached; wind, clouds, storms,
// the trail and the player are redrawn live.
const MAP_S = 3;
const OVERLAYS = [
  ['rivers', 'R', 'Rivers'], ['contours', 'H', 'Contours'], ['plates', 'P', 'Plates'], ['wind', 'W', 'Wind & storms'],
  ['clouds', 'C', 'Clouds'], ['grid', 'G', 'Grid'], ['trail', 'T', 'Your trail'],
];
const BIOME_NAMES = ['Ocean', 'Ice', 'Tundra', 'Taiga', 'Autumn forest', 'Grassland', 'Desert', 'Warm forest', 'Savanna', 'Scrubland'];
settings.mapOverlays = Object.assign({ rivers: true, grid: true, trail: true, wind: false, clouds: false, contours: false, plates: false }, settings.mapOverlays || {});
const overlayCache = {}, trail = [];
let mapBase = null, mapBaseMode = -1;
function layerCanvas() { const c = document.createElement('canvas'); c.width = planet.PW * MAP_S; c.height = planet.PH * MAP_S; return c; }
function buildOverlay(name) {
  const { PW, PH, L, ys, riv, lk } = planet, S = MAP_S, cv = layerCanvas(), g = cv.getContext('2d');
  const cx = i => (i + 0.5) * S, cy = j => (j + 0.5) * S;
  if (name === 'rivers') {
    // each river cell joins the neighbour that gathers the most water (its downstream)
    g.lineCap = 'round';
    for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) {
      const k = j * PW + i;
      if (lk[k]) { g.fillStyle = 'rgba(90,150,230,.85)'; g.fillRect(i * S, j * S, S, S); continue; }
      if (!riv[k] || ys[k] < 30) continue; // (riv 1..8 are headwater brooks, drawn as hairlines)
      let best = -1, ba = L.acc[k];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj; if ((!di && !dj) || jj < 0 || jj >= PH) continue;
        const kk = jj * PW + (i + di + PW) % PW;
        if (L.acc[kk] > ba || ys[kk] < 30 && L.acc[kk] >= 0) { if (ys[kk] < 30) { best = kk; break; } ba = L.acc[kk]; best = kk; }
      }
      if (best < 0) continue;
      const bi = best % PW, bj = (best - bi) / PW;
      if (Math.abs(bi - i) > 1) continue;
      const brook = riv[k] <= 8;
      g.strokeStyle = brook ? 'rgba(110,175,255,.55)' : 'rgba(110,175,255,.95)';
      g.lineWidth = brook ? 0.5 : Math.min(3.2, 0.7 + Math.log(L.acc[k] / 2) * 0.55);
      g.beginPath(); g.moveTo(cx(i), cy(j)); g.lineTo(cx(bi), cy(bj)); g.stroke();
    }
  } else if (name === 'plates') {
    g.strokeStyle = 'rgba(240,70,50,.9)'; g.lineWidth = 1.5; g.beginPath();
    for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) {
      const k = j * PW + i;
      if (L.plate[k] !== L.plate[j * PW + (i + 1) % PW]) { g.moveTo((i + 1) * S, j * S); g.lineTo((i + 1) * S, (j + 1) * S); }
      if (j + 1 < PH && L.plate[k] !== L.plate[k + PW]) { g.moveTo(i * S, (j + 1) * S); g.lineTo((i + 1) * S, (j + 1) * S); }
    }
    g.stroke();
  } else if (name === 'contours') {
    // marching squares on block height: thin lines every 10 blocks, stronger every 30
    for (let lv = 40; lv <= 120; lv += 10) {
      g.strokeStyle = lv % 30 === 0 ? 'rgba(40,24,12,.7)' : 'rgba(40,24,12,.38)';
      g.lineWidth = lv % 30 === 0 ? 1.4 : 0.9; g.beginPath();
      for (let j = 0; j < PH - 1; j++) for (let i = 0; i < PW - 1; i++) {
        const a = ys[j * PW + i], b = ys[j * PW + i + 1], c = ys[(j + 1) * PW + i + 1], d = ys[(j + 1) * PW + i];
        const pts = [];
        const edge = (h0, h1, x0, y0, x1, y1) => { if ((h0 < lv) !== (h1 < lv)) { const t = (lv - h0) / (h1 - h0); pts.push([(x0 + (x1 - x0) * t + 0.5) * S, (y0 + (y1 - y0) * t + 0.5) * S]); } };
        edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(d, c, i, j + 1, i + 1, j + 1); edge(a, d, i, j, i, j + 1);
        for (let q = 0; q + 1 < pts.length; q += 2) { g.moveTo(pts[q][0], pts[q][1]); g.lineTo(pts[q + 1][0], pts[q + 1][1]); }
      }
      g.stroke();
    }
  } else if (name === 'grid') {
    g.strokeStyle = 'rgba(242,228,207,.22)'; g.lineWidth = 1; g.fillStyle = 'rgba(242,228,207,.6)'; g.font = '600 11px ui-monospace, monospace';
    for (let l = -60; l <= 60; l += 30) { const y = (90 - l) / 180 * PH * S; g.beginPath(); g.moveTo(0, y); g.lineTo(PW * S, y); g.stroke(); g.fillText(`${Math.abs(l)}°${l > 0 ? 'N' : l < 0 ? 'S' : ''}`, 4, y - 3); }
    for (let lo = 0; lo < 360; lo += 30) { const x = lo / 360 * PW * S; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PH * S); g.stroke(); if (lo) g.fillText(`${lo}°`, x + 3, 12); }
  }
  return cv;
}
function drawMap() {
  if (!mapPx) return;
  const { PW, PH } = planet, S = MAP_S, mc = $('map'), g = mc.getContext('2d');
  if (mc.width !== PW * S) { mc.width = PW * S; mc.height = PH * S; }
  if (mapBaseMode !== mapMode || !mapBase) {
    mapBase = document.createElement('canvas'); mapBase.width = PW; mapBase.height = PH;
    mapBase.getContext('2d').putImageData(new ImageData(mapModes[mapMode] || mapPx, PW, PH), 0, 0);
    mapBaseMode = mapMode;
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(mapBase, 0, 0, PW * S, PH * S);
  g.imageSmoothingEnabled = true;
  const on = settings.mapOverlays;
  for (const k of ['contours', 'rivers', 'plates', 'grid']) if (on[k]) g.drawImage(overlayCache[k] || (overlayCache[k] = buildOverlay(k)), 0, 0);
  if (on.clouds && weather.atmos && weather.atmos.glob.ready) {
    // the whole planet's clouds from the global atmosphere: white where the cloud is thick,
    // tinted blue where it rains
    const G = weather.atmos.glob, W = G.w, H = G.h, B = G.data[1], C = G.data[2];
    const cc = document.createElement('canvas'); cc.width = W; cc.height = H;
    const im = cc.getContext('2d').createImageData(W, H);
    for (let n = 0; n < W * H; n++) {
      const c = Math.min(1, Math.max(0, (B[n * 4 + 1] - 0.06) / 0.5)), r = Math.min(1, C[n * 4] * 12);
      im.data[n * 4] = 245 - r * 120; im.data[n * 4 + 1] = 248 - r * 70; im.data[n * 4 + 2] = 255;
      im.data[n * 4 + 3] = Math.max(c * c * (3 - 2 * c) * 200, r * 160);
    }
    cc.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(cc, 0, 0, PW * S, PH * S);
  }
  if (on.clouds && weather.ready && !weather.atmos) {
    // the live cloud field around you, as white veils
    const { ox, oz, N, px } = weather.cloudField();
    const cc = document.createElement('canvas'); cc.width = N; cc.height = N;
    const im = cc.getContext('2d').createImageData(N, N);
    for (let n = 0; n < N * N; n++) { const c = px[n * 4] / 255; im.data[n * 4] = im.data[n * 4 + 1] = im.data[n * 4 + 2] = 250 - px[n * 4 + 2] * 0.35; const a = Math.min(1, Math.max(0, (c - 0.55) / 0.35)); im.data[n * 4 + 3] = a * a * (3 - 2 * a) * 225; }
    cc.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(cc, ox * S, oz * S, N * S, N * S);
    g.strokeStyle = 'rgba(242,228,207,.35)'; g.setLineDash([4, 4]); g.strokeRect(ox * S, oz * S, N * S, N * S); g.setLineDash([]);
  }
  if (on.wind) {
    // prevailing winds and the storm systems spinning across them
    g.strokeStyle = 'rgba(235,240,255,.75)'; g.fillStyle = 'rgba(235,240,255,.75)'; g.lineWidth = 1.2;
    for (let j = 6; j < PH; j += 12) for (let i = 6; i < PW; i += 12) {
      const w = weather.windAt(i, j), sp = Math.hypot(w[0], w[1]);
      if (sp < 0.05) continue;
      const len = Math.min(16, 4 + sp * 9), ux = w[0] / sp, uz = w[1] / sp, x0 = i * S, y0 = j * S, x1 = x0 + ux * len, y1 = y0 + uz * len;
      g.beginPath(); g.moveTo(x0 - ux * len * 0.5, y0 - uz * len * 0.5); g.lineTo(x1 - ux * len * 0.5, y1 - uz * len * 0.5); g.stroke();
      const hx = x1 - ux * len * 0.5, hy = y1 - uz * len * 0.5;
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx - ux * 4 - uz * 2.5, hy - uz * 4 + ux * 2.5); g.lineTo(hx - ux * 4 + uz * 2.5, hy - uz * 4 - ux * 2.5); g.fill();
    }
    for (const s of weather.storms()) {
      if (s.str < 0.15) continue;
      const x = s.x * S, y = s.z * S, r = s.r * S * 0.9, dir = s.north ? -1 : 1;
      g.strokeStyle = `rgba(150,200,255,${0.35 + 0.5 * Math.min(1, s.str)})`; g.lineWidth = 2;
      for (let arm = 0; arm < 3; arm++) {
        g.beginPath();
        for (let t = 0; t <= 1; t += 0.05) { const a = arm * 2.094 + dir * t * 4.2, rr = r * (0.15 + t); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        g.stroke();
      }
    }
    // thunderstorm cells near the player, brighter while they rain hardest
    for (const c of weather.cells()) {
      g.fillStyle = `rgba(255,236,160,${0.25 + 0.6 * c.I})`;
      g.beginPath(); g.arc(c.x / 16 * S, c.z / 16 * S, Math.max(1.5, c.r / 16 * S * (0.6 + 0.6 * c.I)), 0, 6.283); g.fill();
    }
  }
  if (on.trail && trail.length > 1) {
    g.strokeStyle = 'rgba(232,116,59,.85)'; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    for (let n = 0; n < trail.length; n++) {
      const [x, z] = trail[n], px = x / 16 * S, pz = z / 16 * S;
      if (n && (Math.abs(x - trail[n - 1][0]) > 96 || Math.abs(z - trail[n - 1][1]) > 96)) g.moveTo(px, pz); else if (n) g.lineTo(px, pz); else g.moveTo(px, pz);
    }
    g.stroke();
  }
  const x = ((state.pos[0] % PLANET_W) + PLANET_W) % PLANET_W / 16 * S, y = Math.max(0, Math.min(PLANET_H, state.pos[2])) / 16 * S;
  // the player, with a tick showing which way you face
  const f = camDir();
  g.strokeStyle = '#1a110b'; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x + f[0] * 16, y + f[2] * 16); g.stroke();
  g.strokeStyle = '#f2e4cf'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + f[0] * 16, y + f[2] * 16); g.stroke();
  g.fillStyle = '#e8743b'; g.strokeStyle = '#1a110b'; g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); g.stroke();
}
function trackTrail() {
  const p = state.pos, l = trail[trail.length - 1];
  if (!state.spawned) return;
  if (!l || Math.hypot(p[0] - l[0], p[2] - l[1]) > 8) { trail.push([((p[0] % PLANET_W) + PLANET_W) % PLANET_W, p[2]]); if (trail.length > 4000) trail.splice(0, 1000); }
}
function toggleOverlay(k) {
  settings.mapOverlays[k] = !settings.mapOverlays[k]; saveSettings();
  syncOverlayBtns(); drawMap();
}
function syncOverlayBtns() { [...document.querySelectorAll('#mapoverlays button')].forEach(b => b.setAttribute('aria-pressed', String(!!settings.mapOverlays[b.dataset.k]))); }
// what's under the cursor
function mapHover(e) {
  if (!planet) return;
  const mc = $('map'), r = mc.getBoundingClientRect();
  const i = Math.floor((e.clientX - r.left) / r.width * planet.PW), j = Math.floor((e.clientY - r.top) / r.height * planet.PH);
  if (i < 0 || j < 0 || i >= planet.PW || j >= planet.PH) { $('mapinfo').textContent = ''; return; }
  const k = j * planet.PW + i, y = planet.ys[k], lat = 90 - (j + 0.5) / planet.PH * 180;
  const what = planet.lk[k] ? 'Lake' : y < 30 ? (planet.tmp[k] < -3 ? 'Sea ice' : 'Sea') : BIOME_NAMES[planet.biome[k]] + (planet.riv[k] > 8 ? ' · river' : planet.riv[k] ? ' · brook' : '');
  let more = '';
  const L = planet.L;
  if (L) {
    if (y < 30 && !planet.lk[k]) more = ` · sea ${L.sst[k].toFixed(1)}°C`;
    else {
      const jul = seasonT(k, 1), jan = seasonT(k, -1), rs = L.rJul[k] + L.rJan[k];
      more = ` · Jul ${jul.toFixed(0)}° Jan ${jan.toFixed(0)}° · rain ${L.rain[k].toFixed(2)} (${rs > 1e-6 ? Math.round(L.rJul[k] / rs * 100) : 50}% in Jul) · moisture ${Math.round(L.moist[k] * 100)}%`
        + (L.salt[k] ? ' · salt pan' : '') + (L.dep[k] > 0.01 ? ` · sediment ${L.dep[k].toFixed(2)}` : '');
    }
  }
  $('mapinfo').textContent = `x ${i * 16 + 8}  z ${j * 16 + 8} · ${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'} · ${what} · height ${y} · ${planet.tmp[k]}°C${more}`;
}
function toggleMap(on) {
  const mv = $('mapview'), was = mv.hidden;
  mv.hidden = on === undefined ? !mv.hidden : !on;
  if (!mv.hidden) {
    initMapModes(); setMapMode(mapMode);
    // free the mouse so the map can be pointed at and clicked
    if (locked()) document.exitPointerLock();
  } else if (!was && playing && !isTouch && !lockFailed && canvas.requestPointerLock) {
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
  }
}
// Ctrl (or Cmd) + click on the map: teleport there, landing on the ground or the water surface
function mapTeleport(e) {
  if (!planet || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); e.stopPropagation();
  const r = $('map').getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return;
  // of the planet's copies around the wrap, the one nearest to where you are
  let x = u * PLANET_W;
  x += Math.round((state.pos[0] - x) / PLANET_W) * PLANET_W;
  const z = Math.min(PLANET_H - 8, Math.max(8, v * PLANET_H));
  boat.state.aboard = false;
  restoreAt({ world: 2, pos: [x, CH - 4, z], yaw: state.yaw, pitch: state.pitch, fly: state.fly, ground: true });
  toggleMap(false);
  showToast(`Teleported to x ${Math.round(x)}  z ${Math.round(z)}`);
}
function initMapModes() {
  const bar = $('mapmodes');
  if (bar.childElementCount) return;
  const ob = $('mapoverlays');
  for (const [k, key, name] of OVERLAYS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.k = k; b.innerHTML = `<kbd>${key}</kbd> ${name}`;
    b.addEventListener('click', () => toggleOverlay(k));
    ob.appendChild(b);
  }
  syncOverlayBtns();
  $('map').addEventListener('pointermove', mapHover);
  $('map').addEventListener('pointerdown', mapTeleport);
  $('map').addEventListener('contextmenu', e => { if (e.ctrlKey || e.metaKey) e.preventDefault(); });
  $('map').addEventListener('pointerleave', () => { $('mapinfo').textContent = ''; });
  MAP_MODES.forEach(([name], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.innerHTML = `<kbd>${MAP_KEYS[i]}</kbd> ${name}`;
    b.addEventListener('click', () => setMapMode(i));
    bar.appendChild(b);
  });
}
const latOf = z => 90 - Math.min(PLANET_H, Math.max(0, z)) / PLANET_H * 180;
function pickSpawn() {
  // a temperate autumn forest beside a river, away from the poles
  const { ys, riv, biome, PW, PH } = planet, cands = [];
  for (let j = 2; j < PH - 2; j++) {
    const lat = Math.abs(90 - (j + 0.5) / PH * 180);
    if (lat < 25 || lat > 60) continue;
    for (let i = 0; i < PW; i++) {
      const k = j * PW + i;
      if (biome[k] !== 4 || ys[k] < 34 || ys[k] > 46) continue;
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) if (riv[(j + dj) * PW + (i + di + PW) % PW] > 8) { near = true; break; }
      if (near && riv[k] <= 8) cands.push(k);
    }
  }
  if (!cands.length) for (let k = 0; k < PW * PH; k++) if (ys[k] > 32 && biome[k] !== 1) cands.push(k);
  const k = cands[(Math.imul(settings.seed + 11, 2654435761) >>> 0) % cands.length];
  return [(k % PW) * 16 + 8.5, Math.floor(k / PW) * 16 + 8.5];
}
function dispatch(msg, transfer) {
  let best = workers[0];
  for (const w of workers) if (w.jobs < best.jobs) best = w;
  best.jobs++;
  msg.seed = settings.seed; msg.gen = worldGen; msg.bare = settings.season === 3; msg.season = settings.season;
  best.postMessage(msg, transfer || []);
}

function getBlock(x, y, z) {
  if (y < 0) return B.STONE;
  if (y >= CH) return B.AIR;
  const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  const ch = chunks.get(ckey(cx, cz));
  if (!ch || !ch.blocks) return -1;
  return ch.blocks[(y * CS + (z - cz * CS)) * CS + (x - cx * CS)];
}
function columnHeight(ch, lx, lz) {
  for (let y = CH - 1; y >= 0; y--) {
    const b = ch.blocks[(y * CS + lz) * CS + lx];
    if (b !== 0 && !(b >= B.OAK_LOG && b <= B.LEAF_GREEN) && b !== B.TWIG && !isPlant(b)) return y + 1;
  }
  return 0;
}
function buildPadded(cx, cz) {
  const nb = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = chunks.get(ckey(cx + dx, cz + dz));
    if (!c || !c.blocks) return null;
    nb.push(c.blocks);
  }
  const vol = new Uint8Array(P * P * CH);
  for (let y = 0; y < CH; y++)
    for (let z = 0; z < P; z++) {
      const wz = z - 1, nz = wz < 0 ? 0 : wz >= CS ? 2 : 1, lz = (wz + CS) % CS;
      for (let x = 0; x < P; x++) {
        const wx = x - 1, nx = wx < 0 ? 0 : wx >= CS ? 2 : 1, lx = (wx + CS) % CS;
        vol[(y * P + z) * P + x] = nb[nz * 3 + nx][(y * CS + lz) * CS + lx];
      }
    }
  return vol;
}
function remesh(ch) {
  // one job in flight per chunk; further edits coalesce into a single follow-up remesh
  if (ch.busy) { ch.again = true; return; }
  ch.busy = true; ch.again = false;
  remeshCount++;
  ch.version++;
  const vol = buildPadded(ch.cx, ch.cz);
  if (vol) dispatch({ cx: ch.cx, cz: ch.cz, version: ch.version, padded: vol }, [vol.buffer]);
  else dispatch({ cx: ch.cx, cz: ch.cz, version: ch.version, blocks: ch.blocks.slice() });
}
function setBlock(x, y, z, b) {
  if (y < 0 || y >= CH) return false;
  const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  const ch = chunks.get(ckey(cx, cz));
  if (!ch || !ch.blocks) return false;
  const lx = x - cx * CS, lz = z - cz * CS;
  ch.blocks[(y * CS + lz) * CS + lx] = b;
  ch.edited = true;
  const xs = lx === 0 ? [-1, 0] : lx === CS - 1 ? [0, 1] : [0];
  const zs = lz === 0 ? [-1, 0] : lz === CS - 1 ? [0, 1] : [0];
  for (const dx of xs) for (const dz of zs) {
    const c = chunks.get(ckey(cx + dx, cz + dz));
    if (c && c.blocks && c.state === 'ready') remesh(c);
  }
  updateColumn(ch, x, z);
  simAround(x, y, z);
  return true;
}
function updateColumn(ch, x, z) {
  const h = columnHeight(ch, x - ch.cx * CS, z - ch.cz * CS);
  const hx = ((x % HM) + HM) % HM, hz = ((z % HM) + HM) % HM;
  if (heightCPU[hz * HM + hx] === h) return;
  heightCPU[hz * HM + hx] = h;
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, hx, hz, 1, 1, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([h]));
}

// ---------- water simulation ----------
// A cellular automaton in the spirit of classic voxel games: sources feed flowing levels 7..1
// sideways over solid ground, and water with nothing beneath it becomes a falling column.
const simQ = new Set();
const dirtyChunks = new Set();
const simKey = (x, y, z) => ((x + 1048576) * 2097152 + (z + 1048576)) * 128 + y;
function simPush(x, y, z) { if (y >= 0 && y < CH) simQ.add(simKey(x, y, z)); }
function simAround(x, y, z) {
  simPush(x, y, z); simPush(x + 1, y, z); simPush(x - 1, y, z);
  simPush(x, y + 1, z); simPush(x, y - 1, z); simPush(x, y, z + 1); simPush(x, y, z - 1);
}
function rawSet(x, y, z, b) {
  const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  const ch = chunks.get(ckey(cx, cz));
  if (!ch || !ch.blocks) return;
  const lx = x - cx * CS, lz = z - cz * CS;
  ch.blocks[(y * CS + lz) * CS + lx] = b;
  // water-sim changes don't count as edits: the chunk regenerates and re-settles when revisited
  const xs = lx === 0 ? [-1, 0] : lx === CS - 1 ? [0, 1] : [0];
  const zs = lz === 0 ? [-1, 0] : lz === CS - 1 ? [0, 1] : [0];
  for (const dx of xs) for (const dz of zs) {
    const c = dx || dz ? chunks.get(ckey(cx + dx, cz + dz)) : ch;
    if (c) dirtyChunks.add(c);
  }
  updateColumn(ch, x, z);
}
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function simCell(x, y, z) {
  const b = getBlock(x, y, z);
  if (b < 0) return;
  if (b === B.WATER) {
    for (const [dx, dz] of D4) if (getBlock(x + dx, y, z + dz) === 0) simPush(x + dx, y, z + dz);
    if (getBlock(x, y - 1, z) === 0) simPush(x, y - 1, z);
    return;
  }
  if (b !== 0 && !isW(b)) return;
  let want = 0, falling = false;
  if (isW(getBlock(x, y + 1, z))) { want = 8; falling = true; }
  else for (const [dx, dz] of D4) {
    const n = getBlock(x + dx, y, z + dz);
    if (!isW(n)) continue;
    const bn = getBlock(x + dx, y - 1, z + dz);
    if (bn === 0 || (isW(bn) && bn !== B.WATER)) continue; // only water resting on something spreads
    want = Math.max(want, lvlOf(n) - 1);
  }
  const nb = want <= 0 ? 0 : falling ? FALL : 16 + want;
  if (nb !== b) {
    // a cell that keeps flipping (feedback between falls and spreading flows) is frozen
    // until the budget window resets, so the simulation always settles
    const k = simKey(x, y, z), c = simFlips.get(k) || 0;
    if (c >= 3) { simFrozen.add(k); return; }
    simFlips.set(k, c + 1);
    rawSet(x, y, z, nb); simAround(x, y, z);
  }
}
const SIM_HZ = 6;
let simAcc = 0, simFlipT = 0, remeshCount = 0;
const simFlips = new Map(), simFrozen = new Set();
function simStep(dt) {
  simFlipT += dt;
  if (simFlipT > 8) {
    // let frozen cells try again so a stalled waterfall front can finish
    simFlipT = 0; simFlips.clear();
    for (const k of simFrozen) simQ.add(k);
    simFrozen.clear();
  }
  simAcc += dt;
  if (simAcc < 1 / SIM_HZ) return;
  simAcc = 0;
  const batch = [];
  for (const k of simQ) { batch.push(k); if (batch.length >= 4000) break; }
  for (const k of batch) simQ.delete(k);
  for (const k of batch) {
    const y = k % 128, r = (k - y) / 128, zz = r % 2097152;
    simCell((r - zz) / 2097152 - 1048576, y, zz - 1048576);
  }
  for (const ch of dirtyChunks) if (ch.state === 'ready' && chunks.get(ckey(ch.cx, ch.cz)) === ch) remesh(ch);
  dirtyChunks.clear();
}

let offsets = [];
function buildOffsets() {
  offsets = [];
  const r = settings.rd;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const d2 = dx * dx + dz * dz;
    if (d2 <= r * r + r) offsets.push([dx, dz, d2]);
  }
  offsets.sort((a, b) => a[2] - b[2]);
}
buildOffsets();

function updateChunks() {
  if (!planet) return;
  const pcx = Math.floor(state.pos[0] / CS), pcz = Math.floor(state.pos[2] / CS);
  // finished chunks waiting to be uploaded count against the budget too, so a fast worker
  // pool can never run ahead of the main thread and pile results up in memory
  const maxInflight = NW * 3;
  for (const [dx, dz] of offsets) {
    if (inflight() + results.length >= maxInflight) break;
    const cx = pcx + dx, cz = pcz + dz, k = ckey(cx, cz);
    let ch = chunks.get(k);
    if (ch && ch.regrow && ch.state === 'ready') {
      ch.regrow = false; ch.regen = true; ch.version++;
      dispatch({ cx, cz, version: ch.version });
      continue;
    }
    if (!ch) {
      ch = { cx, cz, state: 'pending', version: 0, applied: -1, emit: null, blocks: null, opaque: null, water: null, edited: false, minY: 0, maxY: CH };
      chunks.set(k, ch);
      dispatch({ cx, cz, version: 0 });
    } else if (ch.state === 'parked') {
      ch.state = 'pending'; ch.version++; ch.applied = -1;
      dispatch({ cx, cz, version: ch.version, blocks: ch.blocks.slice() });
    }
  }
  const lim = settings.rd + 2;
  for (const [k, ch] of chunks) {
    const dx = ch.cx - pcx, dz = ch.cz - pcz;
    if (dx * dx + dz * dz <= lim * lim) continue;
    freeMesh(ch.opaque); freeMesh(ch.water); ch.opaque = ch.water = null;
    ch.busy = ch.again = false;
    if (ch.edited && ch.blocks) { ch.state = 'parked'; ch.version++; }
    else { ch.state = 'gone'; chunks.delete(k); }
  }
}

function processResults() {
  const t0 = performance.now();
  while (results.length && performance.now() - t0 < 6) {
    const r = results.shift();
    if (r.gen !== worldGen) continue;
    const ch = chunks.get(ckey(r.cx, r.cz));
    if (ch && r.version === ch.version && ch.busy) {
      ch.busy = false;
      if (ch.again && ch.state === 'ready') queueMicrotask(() => remesh(ch));
    }
    if (!ch || r.version < (ch.applied ?? -1) || ch.state === 'parked') continue;
    if (ch.state === 'pending' && r.version !== ch.version) continue;
    ch.applied = r.version;
    if (r.blocks && (ch.state === 'pending' || ch.regen)) ch.blocks = r.blocks;
    if (ch.regen && r.version === ch.version) ch.regen = false;
    ch.emit = r.emit;
    if (Math.abs(r.cx - Math.floor(state.pos[0] / CS)) <= EMIT_R && Math.abs(r.cz - Math.floor(state.pos[2] / CS)) <= EMIT_R) emitDirty = true;
    freeMesh(ch.opaque); freeMesh(ch.water);
    ch.opaque = makeMesh(r.o); ch.water = makeMesh(r.w);
    ch.minY = r.minY; ch.maxY = r.maxY;
    const first = ch.state !== 'ready';
    ch.state = 'ready';
    uploadHeights(r.cx, r.cz, r.heights);
    if (first) for (const v of r.unstable) simPush(r.cx * CS + (v & 63), (v >> 6) & 127, r.cz * CS + ((v >> 13) & 63));
    if (first && !state.spawned && !state.restoring) trySpawn();
  }
}

// leaves fall or grow back: regrow every untouched chunk, keeping the old mesh until the new one lands
function regrowChunks() {
  // (marked here, dispatched a few at a time by updateChunks: sending every chunk at once
  // piled hundreds of finished chunks up in memory at the same time)
  for (const ch of chunks.values()) {
    if (ch.edited || ch.state === 'parked' || ch.state === 'gone') continue;
    if (ch.state === 'ready') ch.regrow = true;
    else { ch.version++; ch.applied = -1; dispatch({ cx: ch.cx, cz: ch.cz, version: ch.version }); }
  }
  emitDirty = true;
}
function setSeason(i, toast) {
  const was = settings.season;
  settings.season = ((i % 4) + 4) % 4;
  saveSettings(); syncSeason();
  // (every season regrows: leaves, lying snow and frozen lakes all change with it)
  if (was !== settings.season) regrowChunks();
  if (toast) showToast(SEASONS[settings.season]);
  weather.setSeason(settings.season);
}
function resetWorld(keepSpot) {
  worldGen++;
  for (const ch of chunks.values()) { freeMesh(ch.opaque); freeMesh(ch.water); }
  chunks.clear();
  results.length = 0;
  simQ.clear(); dirtyChunks.clear(); emitDirty = true;
  heightCPU.fill(0);
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HM, HM, gl.RED, gl.UNSIGNED_BYTE, heightCPU);
  state.spawned = false;
  if (!keepSpot) { state.pos = [16, 72, 16]; state.restoring = false; }
  state.vel = [0, 0, 0];
  if (keepSpot) state.restoring = true;
  requestPlanet();
}

// ---------- player ----------
const state = { pos: [16, 72, 16], vel: [0, 0, 0], yaw: 0.7, pitch: -0.12, onGround: false, fly: false, spawned: false, slot: 0, time: 0 };
const HW = 0.3, PH = 1.8, EYE = 1.62;

function trySpawn() {
  const cx = Math.floor(state.pos[0] / CS), cz = Math.floor(state.pos[2] / CS);
  const ch = chunks.get(ckey(cx, cz));
  if (!ch || !ch.blocks) return;
  // prefer a clearing with open sky, then any dry spot
  for (const openSky of [true, false])
  for (let r = 0; r < 16; r++)
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const lx = 16 + dx, lz = 16 + dz;
      const h = columnHeight(ch, lx, lz);
      if (h <= WL + 1 || h >= CH - 3) continue;
      const at = y => ch.blocks[(y * CS + lz) * CS + lx];
      if (at(h) !== 0 || at(h + 1) !== 0) continue;
      if (openSky) {
        let clear = lx >= 2 && lz >= 2 && lx < CS - 2 && lz < CS - 2;
        for (let oz = -2; clear && oz <= 2; oz++) for (let ox = -2; clear && ox <= 2; ox++)
          for (let y = h + 2; y < CH; y++) if (ch.blocks[(y * CS + lz + oz) * CS + lx + ox] !== 0) { clear = false; break; }
        if (!clear) continue;
      }
      state.pos = [cx * CS + lx + 0.5, h, cz * CS + lz + 0.5];
      state.vel = [0, 0, 0];
      state.spawned = true;
      return;
    }
  state.pos[1] = CH - 2; state.fly = true; state.spawned = true;
}

const solidAt = (x, y, z) => { const b = getBlock(x, y, z); return b < 0 || (b !== 0 && !isW(b) && !isPlant(b)); };
function moveAxis(axis, amt) {
  const p = state.pos;
  p[axis] += amt;
  const x0 = Math.floor(p[0] - HW), x1 = Math.floor(p[0] + HW - 1e-9);
  const y0 = Math.floor(p[1]), y1 = Math.floor(p[1] + PH - 1e-9);
  const z0 = Math.floor(p[2] - HW), z1 = Math.floor(p[2] + HW - 1e-9);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (!solidAt(x, y, z)) continue;
    if (axis === 0) p[0] = amt > 0 ? x - HW - 1e-3 : x + 1 + HW + 1e-3;
    else if (axis === 2) p[2] = amt > 0 ? z - HW - 1e-3 : z + 1 + HW + 1e-3;
    else if (amt > 0) p[1] = y - PH - 1e-3;
    else { p[1] = y + 1e-3 + 1; state.onGround = true; }
    state.vel[axis] = 0;
    return true;
  }
  return false;
}

const keys = new Set();
const touch = { mx: 0, mz: 0, jump: false, down: false };
function physics(dt) {
  const s = state;
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
  let mx = 0, mz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  mx += touch.mx; mz += touch.mz;
  const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  const jump = keys.has('Space') || touch.jump;
  const feet = getBlock(Math.floor(s.pos[0]), Math.floor(s.pos[1] + 0.4), Math.floor(s.pos[2]));
  const inWater = isW(feet);
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = s.fly ? (sprint ? 40 : 18) : inWater ? 3 : sprint ? 8.5 : 5;
  const tx = (fx * mz + rx * mx) * speed, tz = (fz * mz + rz * mx) * speed;
  const acc = s.fly ? 8 : s.onGround ? 14 : 4;
  s.vel[0] += (tx - s.vel[0]) * Math.min(1, dt * acc);
  s.vel[2] += (tz - s.vel[2]) * Math.min(1, dt * acc);
  if (s.fly) {
    let ty = 0;
    if (jump) ty += speed;
    if (keys.has('KeyC') || keys.has('ControlLeft') || touch.down) ty -= speed;
    s.vel[1] += (ty - s.vel[1]) * Math.min(1, dt * 8);
  } else if (inWater) {
    s.vel[1] -= 9 * dt; s.vel[1] *= 0.92;
    if (jump) s.vel[1] = 3.2;
  } else {
    s.vel[1] = Math.max(s.vel[1] - 30 * dt, -50);
    if (jump && s.onGround) s.vel[1] = 9;
  }
  const wasGround = s.onGround;
  s.onGround = false;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(s.vel[0]), Math.abs(s.vel[1]), Math.abs(s.vel[2])) * dt / 0.4));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    const hx = moveAxis(0, s.vel[0] * sdt);
    const hz = moveAxis(2, s.vel[2] * sdt);
    moveAxis(1, s.vel[1] * sdt);
    // step up one block automatically when walking into a ledge
    if ((hx || hz) && wasGround && !s.fly && !inWater && (mx || mz)) {
      const ax = Math.floor(s.pos[0] + Math.sign(tx) * (HW + 0.1)), az = Math.floor(s.pos[2] + Math.sign(tz) * (HW + 0.1));
      const fy = Math.floor(s.pos[1]);
      if (!solidAt(ax, fy + 1, az) && !solidAt(ax, fy + 2, az) && !solidAt(Math.floor(s.pos[0]), fy + 2, Math.floor(s.pos[2]))) s.vel[1] = 8;
    }
  }
}

// voxel raycast (Amanatides & Woo)
function raycast(o, d, maxD) {
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const sx = Math.sign(d[0]), sy = Math.sign(d[1]), sz = Math.sign(d[2]);
  const tdx = Math.abs(1 / d[0]), tdy = Math.abs(1 / d[1]), tdz = Math.abs(1 / d[2]);
  let tmx = (sx > 0 ? x + 1 - o[0] : o[0] - x) * tdx;
  let tmy = (sy > 0 ? y + 1 - o[1] : o[1] - y) * tdy;
  let tmz = (sz > 0 ? z + 1 - o[2] : o[2] - z) * tdz;
  let px = x, py = y, pz = z, t = 0;
  while (t <= maxD) {
    const b = getBlock(x, y, z);
    if (b > 0 && !isW(b)) return { x, y, z, px, py, pz };
    px = x; py = y; pz = z;
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
    else { z += sz; t = tmz; tmz += tdz; }
  }
  return null;
}
let target = null;
function camDir() {
  const cp = Math.cos(state.pitch);
  return [-Math.sin(state.yaw) * cp, Math.sin(state.pitch), -Math.cos(state.yaw) * cp];
}
// aboard the boat the camera rides behind and above her, orbiting with the mouse
const BOAT_CAM = 13;
const eyePos = () => {
  if (boat.state.aboard) {
    const d = camDir(), p = boat.state.pos;
    const e = [p[0] - d[0] * BOAT_CAM, Math.max(p[1] + 1.6, p[1] + 3.4 - d[1] * BOAT_CAM), p[2] - d[2] * BOAT_CAM];
    // never under a passing crest
    e[1] = Math.max(e[1], boat.seaHeight(e[0], e[2], boat.state.t || 0, env.seaWind, getBlock, isW).h + 1.2);
    return e;
  }
  return [state.pos[0], state.pos[1] + EYE, state.pos[2]];
};
// B launches the boat on the nearest open water ahead, boards her when she is close, or steps off
function boatInput() {
  if (!playing) return { fwd: 0, turn: 0, boost: false };
  let fwd = touch.mz, turn = touch.mx;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) turn += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) turn -= 1;
  const c = v => Math.max(-1, Math.min(1, v));
  return { fwd: c(fwd), turn: c(turn), boost: keys.has('ShiftLeft') || keys.has('ShiftRight') };
}
function groundTop(x, z) {
  for (let y = 70; y > 26; y--) if (solidAt(x, y, z) && !solidAt(x, y + 1, z) && !solidAt(x, y + 2, z) && !isW(getBlock(x, y + 1, z))) return y + 1;
  return null;
}
function toggleBoat() {
  const b = boat.state;
  if (b.aboard) {
    // step off onto land close by, or into the water beside her
    b.aboard = false;
    let spot = null;
    for (let d = 3; d <= 12 && !spot; d++) for (let k = 0; k < 24 && !spot; k++) {
      const a = k / 24 * Math.PI * 2, x = Math.floor(b.pos[0] + Math.cos(a) * d), z = Math.floor(b.pos[2] + Math.sin(a) * d);
      const y = groundTop(x, z);
      if (y !== null && y < 60) spot = [x + 0.5, y, z + 0.5];
    }
    const { r } = boat.basis(b.yaw);
    state.pos = spot || [b.pos[0] + r[0] * 2.8, 30.4, b.pos[2] + r[1] * 2.8];
    state.vel = [0, 0, 0];
    showToast(spot ? 'Ashore' : 'In the water: B by the boat to climb aboard');
    return;
  }
  const board = () => { b.aboard = true; state.fly = false; state.vel = [0, 0, 0]; state.pitch = Math.min(state.pitch, -0.12); showToast('Aboard: W/S throttle, A/D helm, B to step off'); };
  if (b.active && Math.hypot(b.pos[0] - state.pos[0], b.pos[2] - state.pos[2]) < 15) { board(); return; }
  const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
  for (let d = 4; d <= 70; d += 2) for (const s of [0, 1, -1, 2, -2, 3, -3]) {
    const x = state.pos[0] + fx * d - fz * s * 3, z = state.pos[2] + fz * d + fx * s * 3;
    if (boat.fits(x, z, state.yaw, getBlock, isW)) { boat.place(x, z, state.yaw); board(); return; }
  }
  showToast('No open water ahead deep enough for the boat');
}
function breakBlock() {
  if (!target) return;
  setBlock(target.x, target.y, target.z, B.AIR);
}
function placeBlock() {
  if (!target) return;
  const { px, py, pz } = target;
  const p = state.pos;
  if (px + 1 > p[0] - HW && px < p[0] + HW && pz + 1 > p[2] - HW && pz < p[2] + HW && py + 1 > p[1] && py < p[1] + PH) return;
  const cur = getBlock(px, py, pz);
  if (cur !== 0 && !isW(cur)) return;
  setBlock(px, py, pz, HOTBAR[state.slot].b);
}

// ---------- sun & sky ----------
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const env = { foliage: 1, seaWind: [0.8, 0.6, 1], rain: 0, flash: null, flashI: 0,
  precip: 0, overcast: 0, flood: 0, swell: [1, 0, 0], snowFrac: 0, snowFall: 0, wet: 0, fog2: [0, 31, 0.07, 0], hill: 0, bow: 0, temp: 10, gust: 1, windSpeed: 1 };
let outflowT = 0, outflow = [0, 0, 0], snowAt = null, swellT = 0, swellTgt = [1, 0, 0];
const groundAt = (x, z) => heightCPU[(((Math.floor(z) % HM) + HM) % HM) * HM + (((Math.floor(x) % HM) + HM) % HM)];
// What the weather is doing where the player stands, and what it leaves on the ground.
// Precipitation falls as rain or snow by the air temperature at the player (sleet in between).
// Fresh snow builds up while it snows and melts in warm air and sun; the season's lasting snow lies
// above the height where the climate itself is below freezing. Rain wets the ground and it dries
// in sun and wind. Low fog is the sim's fog field; walking up into low cloud on high ground is fog
// too. A rainbow shows when the sun is low and behind you and rain is falling in front of you.
function updateWeatherEnv(dt) {
  const [x, y, z] = state.pos, on = weather.ready && cloudsOn();
  const gy = Math.max(groundAt(x, z) || 0, 31);
  const T = weather.ready ? weather.tempAt(x, z, gy) : 10;
  env.temp = T;
  const r = on ? Math.min(1, Math.max(0, weather.rainAt(x, z) - 0.08) / 0.6) * (1 - smooth(290, 320, y)) : 0;
  env.precip += (r - env.precip) * Math.min(1, dt / 3);
  // overcast: rain here or within a few hundred blocks, so the sky closes in as a storm arrives
  // and opens again slowly after it has passed
  let rn = 0;
  if (on) for (let k = 0; k < 9; k++) { const a = k * 0.785, d = k ? 350 : 0; rn = Math.max(rn, weather.rainAt(x + Math.cos(a) * d, z + Math.sin(a) * d) * (k ? 0.8 : 1)); }
  rn = Math.min(1, Math.max(0, rn - 0.1) / 0.5);
  env.overcast += (rn - env.overcast) * Math.min(1, dt / (rn > env.overcast ? 6 : 15));
  const sf = smooth(2.0, -0.5, T);
  env.snowFrac += (sf - env.snowFrac) * Math.min(1, dt / 4);
  env.rain = env.precip * (1 - env.snowFrac);
  env.snowFall = env.precip * env.snowFrac;
  // snow cover lives in the weather sim, per cell of land (weather.snowMap); here only whether
  // snow under the player is melting, which keeps the ground wet
  if (!snowAt || Math.hypot(x - snowAt[0], z - snowAt[1]) > 400) env.wet = 0;
  snowAt = [x, z];
  // wetness: soaks in over a minute of rain, dries over several in sun and wind; melting snow wets
  const melt = T > 0.3 && weather.ready && weather.snowAt(x, z, gy) > 0.02 ? 0.3 : 0;
  if (env.rain > 0.05) env.wet = Math.min(1, env.wet + env.rain * dt / 35);
  else env.wet = Math.max(melt * 0.6, env.wet - dt / 420 * (0.3 + (env.sunUp ? Math.max(0, env.sunEl) / 25 : 0) + 0.3 * Math.min(2, env.windSpeed)));
  // low fog: thickest in the sim's fog cells; sea fog sits on the sea, land fog in the valleys
  let fog = 0, base = 31;
  if (on) {
    fog = weather.fogAt(x, z);
    const seaShare = weather.seaNear(x, z, 2);
    let lo = gy;
    for (let a = 0; a < 8; a++) { const h = groundAt(x + Math.cos(a * 0.785) * 56, z + Math.sin(a * 0.785) * 56); if (h > 0) lo = Math.min(lo, h); }
    base = 31 + (Math.max(31, lo) + 5 - 31) * (1 - seaShare);
  }
  env.fog2[0] += (smooth(0.04, 0.45, fog) * 0.024 * settings.envFog ** 0.5 - env.fog2[0]) * Math.min(1, dt / 4);
  env.fog2[1] += (base - env.fog2[1]) * Math.min(1, dt / 2);
  // hill fog: up on high ground under a low, thick, wet sky the cloud sits on the hills
  let hill = 0;
  if (on) { const ty = weather.typeAt(x, z); if (ty) hill = smooth(72, 96, gy) * smooth(0.6, 0.9, ty.cover) * Math.max(smooth(0.1, 0.4, ty.rain), smooth(0.2, 0.6, ty.layered)); }
  env.hill += (hill - env.hill) * Math.min(1, dt / 5);
  // rainbow
  let bow = 0;
  if (on && env.sunUp && env.sunEl > 0 && env.sunEl < 42 && env.rain < 0.75) {
    const sd = env.sunDir, h = Math.hypot(sd[0], sd[2]) || 1, ax = -sd[0] / h, az = -sd[2] / h;
    let ahead = 0;
    for (const d of [250, 500, 800]) ahead = Math.max(ahead, weather.rainAt(x + ax * d, z + az * d));
    const sunSide = weather.coverAt(x - ax * 500, z - az * 500);
    bow = smooth(0.2, 0.55, ahead) * (1 - smooth(0.55, 0.85, sunSide)) * smooth(42, 32, env.sunEl) * smooth(0, 3, env.sunEl) * (1 - env.snowFrac);
  }
  env.bow += (bow - env.bow) * Math.min(1, dt / 3);
  // rivers and lakes: high and muddy for a while after the catchment has been soaked, low after a
  // dry spell; they follow the soil with a lag, as the water takes time to drain down to them
  const fl = on ? Math.max(-1, Math.min(1, weather.soilWet * 3.2)) : 0;
  env.flood += (fl - env.flood) * Math.min(1, dt / (fl > env.flood ? 45 : 120));
  // tests can pin any of these (window.__emberwood.wxForce = { wet: 1 })
  if (wxForce) Object.assign(env, wxForce);
}
let wxForce = null;
// The sun and moon follow real sky geometry: the hour angle comes from the time of day, the
// sun's declination from the season (+23° in northern summer) and the observer's latitude from
// where the player stands on the planet. Stars turn about the celestial pole once a day.
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function skyDir(H, dec, lat) {
  const cd = Math.cos(dec), sd = Math.sin(dec), cl = Math.cos(lat), sl = Math.sin(lat);
  const east = -cd * Math.sin(H), north = sd * cl - cd * sl * Math.cos(H), up = sd * sl + cd * cl * Math.cos(H);
  return [east, up, -north];
}
function updateEnv() {
  const lat = latOf(state.pos[2]) * Math.PI / 180;
  // summer is summer in whichever hemisphere the player is in
  const dec = 23.4 * (seasonW(1) - seasonW(3)) * (lat >= 0 ? 1 : -1) * Math.PI / 180;
  const H = (settings.tod - 12) / 24 * Math.PI * 2;
  const sun = skyDir(H, dec, lat), moon = skyDir(H + Math.PI * 0.94, -dec * 0.9, lat);
  const el = Math.asin(sun[1]) * 180 / Math.PI, mel = Math.asin(moon[1]) * 180 / Math.PI;
  env.sunEl = el;
  // night 1 well after dusk, 0 by day; day colours follow the sun's height
  const night = 1 - smooth(-12, -1, el), day = smooth(-10, 6, el);
  env.night = night;
  const t = Math.min(1, Math.max(0, (el - 4) / 50));
  const sunFade = smooth(-2.5, 8, el) * Math.min(1, Math.max(0.15, el / 12));
  const moonFade = smooth(-2, 10, mel) * night;
  env.sunUp = el > -2.5;
  if (env.sunUp) { env.sunDir = sun; env.sunCol = lerp3([2.6, 1.15, 0.45], [3.0, 2.55, 2.0], t).map(v => v * sunFade); }
  else { env.sunDir = moon; env.sunCol = [0.16, 0.2, 0.3].map(v => v * moonFade); }
  env.moonDir = moon;
  const NZ = [0.010, 0.016, 0.040], NH = [0.035, 0.045, 0.080];
  env.zenith = lerp3(NZ, lerp3([0.16, 0.22, 0.42], [0.22, 0.42, 0.85], t), day);
  env.horizon = lerp3(NH, lerp3([0.95, 0.48, 0.24], [0.78, 0.74, 0.70], t), day);
  env.ambSky = lerp3([0.06, 0.08, 0.15], lerp3([0.30, 0.26, 0.32], [0.36, 0.44, 0.60], t), day);
  env.ambGround = lerp3([0.02, 0.02, 0.03], lerp3([0.20, 0.11, 0.06], [0.22, 0.16, 0.10], t), day);
  // star frame: the celestial pole and two equator directions, turned by the hour angle
  const P = [0, Math.sin(lat), -Math.cos(lat)], M0 = [0, Math.cos(lat), Math.sin(lat)], E0 = [1, 0, 0];
  const c = Math.cos(H), s = Math.sin(H);
  env.starP = P;
  env.starM = M0.map((v, i) => c * v - s * E0[i]);
  env.starE = M0.map((v, i) => s * v + c * E0[i]);
}
updateEnv();

// ---------- lightning ----------
// The bolt is a jagged path with a few forks, rebuilt as camera-facing ribbons every frame it shows.
const boltBuf = gl.createBuffer(), boltVao = gl.createVertexArray();
gl.bindVertexArray(boltVao);
gl.bindBuffer(gl.ARRAY_BUFFER, boltBuf);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
gl.bindVertexArray(null);
let boltPath = null;
function boltPaths(f) {
  let s = f.seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const paths = [];
  const walk = (x, y, z, yEnd, w, depth) => {
    const pts = [[x, y, z, w]];
    while (y > yEnd) {
      const dy = 2 + rnd() * 5;
      y = Math.max(yEnd, y - dy); x += (rnd() - 0.5) * dy * 1.3; z += (rnd() - 0.5) * dy * 1.3;
      pts.push([x, y, z, w]);
      if (depth < 2 && rnd() < 0.09) walk(x, y, z, y - 12 - rnd() * 30, w * 0.45, depth + 1);
    }
    paths.push(pts);
  };
  walk(f.x, 320, f.z, Math.max(f.ground, 31), 1, 0);
  return paths;
}
function drawBolt(f, eye, vp) {
  if (!boltPath || boltPath.seed !== f.seed) boltPath = { seed: f.seed, paths: boltPaths(f) };
  const v = [];
  for (const pts of boltPath.paths) for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], c = [eye[0] - a[0], eye[1] - a[1], eye[2] - a[2]];
    let sx = d[1] * c[2] - d[2] * c[1], sy = d[2] * c[0] - d[0] * c[2], sz = d[0] * c[1] - d[1] * c[0];
    const dist = Math.hypot(c[0], c[1], c[2]), sl = Math.hypot(sx, sy, sz) || 1;
    // a bright core at least a couple of pixels wide however far away, inside a faint wide glow
    for (const [ws, br] of [[1, a[3]], [6, 0.08 * a[3]]]) {
      const w = Math.max(0.3, dist * 0.0035) * a[3] * ws, x = sx * w / sl, y = sy * w / sl, z = sz * w / sl;
      const q = [[a[0] - x, a[1] - y, a[2] - z, br], [a[0] + x, a[1] + y, a[2] + z, br], [b[0] - x, b[1] - y, b[2] - z, br], [b[0] + x, b[1] + y, b[2] + z, br]];
      v.push(...q[0], ...q[1], ...q[2], ...q[2], ...q[1], ...q[3]);
    }
  }
  const pr = progs.bolt;
  gl.useProgram(pr.p);
  setU(pr, 'uVP', vp); setU(pr, 'uI', f.I); setU(pr, 'uEnc', post.enc);
  gl.bindVertexArray(boltVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, boltBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
  gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
  gl.drawArrays(gl.TRIANGLES, 0, v.length / 4);
  gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
  stats.draws++;
}

// ---------- render ----------
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = Math.max(1, Math.floor(canvas.clientWidth * dpr)); H = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
}
const stats = { tris: 0, draws: 0, visible: 0 };
const NEAR = 0.08;
function setCommon(pr, eye, time) {
  setU(pr, 'uSunDir', env.sunDir); setU(pr, 'uSunCol', env.sunCol); setU(pr, 'uNight', env.night);
  setU(pr, 'uZenith', env.zenith); setU(pr, 'uHorizon', env.horizon);
  setU(pr, 'uCam', eye); setU(pr, 'uTime', time);
  setU(pr, 'uFogDen', 1.25 / (settings.rd * CS) * (1 + 0.7 * env.precip + 0.6 * env.snowFall + 5 * env.hill) * Math.sqrt(settings.envFog));
  setU(pr, 'uWet', env.wet); setI(pr, 'uSnowMap', 15); setU(pr, 'uSnowO', weather.snowOrigin); setU(pr, 'uFog2', env.fog2); setU(pr, 'uRainVeil', weather.ready && weather.maxRain > 0.25 ? 1 : 0);
  setU(pr, 'uAmbSky', env.ambSky); setU(pr, 'uAmbGround', env.ambGround);
  setU(pr, 'uWind', env.foliage); setU(pr, 'uSeaWind', env.seaWind); setU(pr, 'uSwell', env.swell); setU(pr, 'uFlood', env.flood);
  setU(pr, 'uEnc', post.enc);
  setU(pr, 'uMist', settings.fx.mist ? settings.envFog : 0);
  setU(pr, 'uCaustics', settings.fx.caustics ? 1 : 0);
  setU(pr, 'uSeason', seasonVis);
  setI(pr, 'uCloudMap', 6); setU(pr, 'uCloudO', weather.origin); setU(pr, 'uCloudOn', cloudsOn() ? 1 : 0); setU(pr, 'uCloudSim', settings.fx.cloudSim ? 1 : 0); setU(pr, 'uOvercast', env.overcast);
  setI(pr, 'uCloud2D', 12); setU(pr, 'uCloudWind', cloudWind); setU(pr, 'uCloudMean', cloudMean);
  setI(pr, 'uCloudMapP', 10); setU(pr, 'uCloudOP', weather.originPrev); setU(pr, 'uCloudF', weather.blend);
  setI(pr, 'uCloudBase', 13); setI(pr, 'uCloudDetail', 14); setI(pr, 'uCloudMap2', 8); setI(pr, 'uCloudMap2P', 11);
  setU(pr, 'uRain', env.rain);
}
function invert(m) {
  const a = m, o = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return o;
  const id = 1 / det;
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * id; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * id;
  o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * id; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * id;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * id; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * id;
  o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * id; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * id;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * id; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * id;
  o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * id; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * id;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * id; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * id;
  o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * id; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * id;
  return o;
}
let prevVP = null, focus = 12;
function render(time, dt) {
  resize();
  post.resize(W, H);
  const oceanOn = ocean.ok && settings.fx.ocean;
  if (oceanOn) { ocean.update(time, env.seaWind); gl.viewport(0, 0, W, H); }
  const eye = eyePos(), fwd = camDir();
  const fov = 70 * Math.PI / 180, aspect = W / H;
  const far = settings.rd * CS * 1.5 + 64;
  const proj = M.persp(fov, aspect, NEAR, far);
  const view = M.lookAt(eye, [eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]], [0, 1, 0]);
  const vp = M.mul(proj, view);
  const planes = M.planes(vp);

  // light matrix, snapped to shadow texels so shadows do not shimmer
  const sd = env.sunDir;
  const lview = M.lookAt(sd, [0, 0, 0], Math.abs(sd[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]);
  const c = state.pos;
  let lx = lview[0] * c[0] + lview[4] * c[1] + lview[8] * c[2] + lview[12];
  let ly = lview[1] * c[0] + lview[5] * c[1] + lview[9] * c[2] + lview[13];
  const lz = lview[2] * c[0] + lview[6] * c[1] + lview[10] * c[2] + lview[14];
  const texel = 2 * SHADOW_R / SHADOW_SIZE;
  lx = Math.round(lx / texel) * texel; ly = Math.round(ly / texel) * texel;
  const lproj = M.ortho(lx - SHADOW_R, lx + SHADOW_R, ly - SHADOW_R, ly + SHADOW_R, -lz - 220, -lz + 220);
  const lightVP = M.mul(lproj, lview);

  const pcx = state.pos[0], pcz = state.pos[2];
  const list = [];
  for (const ch of chunks.values()) {
    if (ch.state !== 'ready' || (!ch.opaque && !ch.water)) continue;
    const x0 = ch.cx * CS, z0 = ch.cz * CS;
    const dx = x0 + 16 - pcx, dz = z0 + 16 - pcz;
    ch.dist = dx * dx + dz * dz;
    list.push(ch);
  }
  list.sort((a, b) => a.dist - b.dist);
  stats.tris = 0; stats.draws = 0; stats.visible = 0;

  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);

  // shadow pass
  if (settings.shadows) {
    const lplanes = M.planes(lightVP);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 3);
    const pr = progs.shadow;
    gl.useProgram(pr.p);
    setU(pr, 'uLightVP', lightVP); setU(pr, 'uTime', time); setU(pr, 'uWind', env.foliage); setU(pr, 'uSeason', seasonVis);
    const lim = (SHADOW_R * 1.5 + 24) ** 2;
    for (const ch of list) {
      if (ch.dist > lim || !ch.opaque) continue;
      const x0 = ch.cx * CS, z0 = ch.cz * CS;
      if (!M.boxVisible(lplanes, x0, ch.minY, z0, x0 + CS, ch.maxY + 1, z0 + CS)) continue;
      setU(pr, 'uOrigin', [x0, 0, z0]);
      gl.bindVertexArray(ch.opaque.vao);
      gl.drawElements(gl.TRIANGLES, ch.opaque.count, gl.UNSIGNED_INT, 0);
    }
    boat.drawShadow(lightVP);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, weather.map);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_3D, weather.noise);
  gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, weather.map2);
  gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, weather.mapPrev);
  gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D, weather.map2Prev);
  gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, weather.tex2);
  gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_3D, weather.cloudBase);
  gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_3D, weather.cloudDetail);
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, weather.snowMap);
  post.beginScene();
  gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);

  // sky
  {
    const pr = progs.sky;
    gl.useProgram(pr.p);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    setCommon(pr, eye, time);
    const right = [Math.cos(state.yaw), 0, -Math.sin(state.yaw)];
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    setU(pr, 'uFwd', fwd); setU(pr, 'uRight', right); setU(pr, 'uUp', up);
    const ty = Math.tan(fov / 2);
    setU(pr, 'uTan', [ty * aspect, ty]);
    setU(pr, 'uStarP', env.starP); setU(pr, 'uStarM', env.starM); setU(pr, 'uStarE', env.starE);
    setU(pr, 'uMoonDir', env.moonDir); setU(pr, 'uSunTrue', env.sunUp ? 1 : 0);
    setU(pr, 'uPixAng', 2 * Math.tan(fov / 2) / H); setU(pr, 'uCloudQ', settings.fx.cloudQ ?? 2);
    setI(pr, 'uNoise3', 7); setI(pr, 'uCloudMap2', 8); setI(pr, 'uCloudMap2P', 11);
    const f = env.flash;
    setU(pr, 'uFlash', f && f.I > 0.01 ? [f.x, 0, f.z, f.I] : [0, 0, 0, 0]);
    setU(pr, 'uBow', env.bow);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }

  // opaque terrain, front to back
  const visible = [];
  {
    const pr = progs.terrain;
    gl.useProgram(pr.p);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp); setU(pr, 'uLightVP', lightVP);
    setU(pr, 'uShadowOn', settings.shadows ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex); setI(pr, 'uShadow', 0);
    for (const ch of list) {
      const x0 = ch.cx * CS, z0 = ch.cz * CS;
      if (!M.boxVisible(planes, x0, ch.minY - 1, z0, x0 + CS, ch.maxY + 1, z0 + CS)) continue;
      visible.push(ch);
      if (!ch.opaque) continue;
      setU(pr, 'uOrigin', [x0, 0, z0]);
      gl.bindVertexArray(ch.opaque.vao);
      gl.drawElements(gl.TRIANGLES, ch.opaque.count, gl.UNSIGNED_INT, 0);
      stats.tris += ch.opaque.count / 3; stats.draws++;
    }
    stats.visible = visible.length;
  }
  boat.draw(vp, lightVP, pr => setCommon(pr, eye, time), shadowTex, settings.shadows);

  // selection outline
  if (target && playing) {
    const pr = progs.line;
    gl.useProgram(pr.p);
    setU(pr, 'uVP', vp); setU(pr, 'uPos', [target.x, target.y, target.z]);
    gl.bindVertexArray(lineVao);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.disable(gl.BLEND);
  }

  // falling leaves
  // autumn leaves, spring petals, a few summer leaves; snow when the weather snows
  const leafN = Math.round(settings.leaves * (seasonW(3) > 0.5 ? 0 : seasonW(2) + seasonW(0) * 0.18 + seasonW(1) * 0.06));
  if (leafN > 0 && emitCount > 0) {
    const pr = progs.leaf;
    gl.useProgram(pr.p);
    gl.disable(gl.CULL_FACE);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, heightTex); setI(pr, 'uHeight', 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, emitTex); setI(pr, 'uEmit', 2);
    gl.uniform1i(pr.u.uEmitCount, emitCount); gl.uniform1i(pr.u.uEmitBase, 0);
    setU(pr, 'uSnowMode', 0); setU(pr, 'uFoam', 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, leafN);
    stats.tris += leafN * 2; stats.draws++;
    gl.enable(gl.CULL_FACE);
  }
  // snowfall, as heavy as the snow coming down overhead
  const snowN = env.snowFall > 0.02 ? Math.round(Math.min(1, 0.12 + env.snowFall * 1.3) * Math.min(14000, Math.max(2500, settings.leaves * 0.9))) : 0;
  if (snowN > 0) {
    const pr = progs.leaf;
    gl.useProgram(pr.p);
    gl.disable(gl.CULL_FACE);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, heightTex); setI(pr, 'uHeight', 1);
    setU(pr, 'uSnowMode', 1); setU(pr, 'uFoam', 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, snowN);
    setU(pr, 'uSnowMode', 0);
    stats.tris += snowN * 2; stats.draws++;
    gl.enable(gl.CULL_FACE);
  }
  // spray at waterfall feet and surf on the shore, drawn with the same particle program
  if (foamCount > 0) {
    const pr = progs.leaf;
    gl.useProgram(pr.p);
    gl.disable(gl.CULL_FACE);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, heightTex); setI(pr, 'uHeight', 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, emitTex); setI(pr, 'uEmit', 2);
    gl.uniform1i(pr.u.uEmitCount, foamCount); gl.uniform1i(pr.u.uEmitBase, foamBase);
    setU(pr, 'uSnowMode', 0); setU(pr, 'uFoam', 1);
    const fn = Math.min(12000, foamCount * 10);
    gl.bindVertexArray(emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fn);
    stats.tris += fn * 2; stats.draws++;
    gl.enable(gl.CULL_FACE);
  }

  // water reads a copy of the opaque scene for refraction and reflections
  post.copyScene();
  {
    const pr = progs.water;
    gl.useProgram(pr.p);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp); setU(pr, 'uLightVP', lightVP);
    setU(pr, 'uShadowOn', settings.shadows ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex); setI(pr, 'uShadow', 0);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, post.copy.color); setI(pr, 'uSceneColor', 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, post.copy.depth); setI(pr, 'uSceneDepth', 3);
    setU(pr, 'uRes', [W, H]); setU(pr, 'uNearFar', [NEAR, far]); setU(pr, 'uSSR', settings.fx.ssr ? 1 : 0);
    if (oceanOn) { gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, ocean.tex); setI(pr, 'uOcean', 9); }
    setI(pr, 'uNoise3', 7); setU(pr, 'uOceanOn', oceanOn ? 1 : 0); setU(pr, 'uOceanL', ocean.L || 96);
    {
      const wk = boat.wakeUniform(), bs = boat.state, bb = boat.basis(bs.yaw);
      if (pr.u.uWake) gl.uniform4fv(pr.u.uWake, wk.buf);
      if (pr.u.uWakeN) gl.uniform1i(pr.u.uWakeN, wk.n);
      setU(pr, 'uBoat', [bs.pos[0], bs.pos[2], bb.f[0], bb.f[1]]); setU(pr, 'uBoatS', bs.active ? Math.abs(bs.speed) : 0);
    }
    gl.disable(gl.CULL_FACE);
    for (let i = visible.length - 1; i >= 0; i--) {
      const ch = visible[i];
      if (!ch.water) continue;
      setU(pr, 'uOrigin', [ch.cx * CS, 0, ch.cz * CS]);
      gl.bindVertexArray(ch.water.vao);
      gl.drawElements(gl.TRIANGLES, ch.water.count, gl.UNSIGNED_INT, 0);
      stats.tris += ch.water.count / 3; stats.draws++;
    }
    gl.enable(gl.CULL_FACE);
  }

  // rain: streaks in a box that follows the camera, as heavy as the simulated rain overhead
  const rainN = Math.round(Math.min(1, env.rain * 1.4) * 9000 * Math.min(1, settings.leaves / 400 + 0.5));
  if (rainN > 30) {
    const pr = progs.leaf;
    gl.useProgram(pr.p);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    setCommon(pr, eye, time);
    setU(pr, 'uVP', vp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, heightTex); setI(pr, 'uHeight', 1);
    setU(pr, 'uSnowMode', 0); setU(pr, 'uFoam', 0); setU(pr, 'uRainMode', 1);
    gl.bindVertexArray(emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rainN);
    setU(pr, 'uRainMode', 0);
    stats.tris += rainN * 2; stats.draws++;
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  // a lightning bolt from the cloud base to the ground
  if (env.flash && !env.flash.cloud && env.flash.I > 0.02) drawBolt(env.flash, eye, vp);
  gl.bindVertexArray(null);

  // post-processing
  const sc = [eye[0] + env.sunDir[0] * 1000, eye[1] + env.sunDir[1] * 1000, eye[2] + env.sunDir[2] * 1000];
  const sx = vp[0] * sc[0] + vp[4] * sc[1] + vp[8] * sc[2] + vp[12];
  const sy = vp[1] * sc[0] + vp[5] * sc[1] + vp[9] * sc[2] + vp[13];
  const sw = vp[3] * sc[0] + vp[7] * sc[1] + vp[11] * sc[2] + vp[15];
  let sunUV = [0.5, 2], sunVis = 0;
  if (sw > 0) {
    sunUV = [sx / sw * 0.5 + 0.5, sy / sw * 0.5 + 0.5];
    const ex = Math.max(Math.abs(sunUV[0] - 0.5), Math.abs(sunUV[1] - 0.5));
    sunVis = Math.max(0, Math.min(1, (0.95 - ex) / 0.4)) * (env.sunUp ? Math.min(1, Math.max(0, env.sunEl / 8)) : 0);
  }
  const hit = raycast(eye, fwd, 96);
  const fd = hit ? Math.hypot(hit.x + 0.5 - eye[0], hit.y + 0.5 - eye[1], hit.z + 0.5 - eye[2]) : 96;
  focus += (fd - focus) * Math.min(1, dt * 5);
  const eb = getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
  post.run({
    fx: settings.fx, nearFar: [NEAR, far], sunUV, sunVis, sunCol: env.sunCol,
    invVP: invert(vp), prevVP: prevVP || vp, focus, aperture: 0.14, time, exposure: settings.fx.exposure * (1 + 1.1 * env.night),
    underwater: isW(eb) && eye[1] - Math.floor(eye[1]) < lvlOf(eb) / 8 * 0.9 + 0.02,
  });
  prevVP = vp;
}

// ---------- UI ----------
const $ = id => document.getElementById(id);
const menu = $('menu'), hud = $('hud-stats'), hotbarEl = $('hotbar'), toast = $('toast');
let playing = false;
const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

HOTBAR.forEach((h, i) => {
  const d = document.createElement('button');
  d.className = 'slot'; d.type = 'button';
  d.innerHTML = `<span class="sw" style="background:${h.col}"></span><span class="k">${i + 1}</span>`;
  d.title = h.name;
  d.addEventListener('click', e => { e.stopPropagation(); selectSlot(i); });
  hotbarEl.appendChild(d);
});
let toastTimer = 0;
function showToast(t) { toast.textContent = t; toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), 1200); }
function selectSlot(i) {
  state.slot = (i + HOTBAR.length) % HOTBAR.length;
  [...hotbarEl.children].forEach((c, j) => c.classList.toggle('sel', j === state.slot));
  showToast(HOTBAR[state.slot].name);
}
selectSlot(0); toast.classList.remove('on');

function bindRange(id, key, fmt, apply) {
  const el = $(id), out = $(id + '-v');
  el.value = settings[key];
  const show = () => { out.textContent = fmt(settings[key]); };
  show();
  el.addEventListener('input', () => { settings[key] = Number(el.value); show(); apply && apply(); saveSettings(); });
}
bindRange('rd', 'rd', v => `${v} chunks · ${v * CS} m`, buildOffsets);
bindRange('leaves', 'leaves', v => v === 0 ? 'off' : v.toLocaleString('en-US'));
const clock = h => { const m = Math.floor(((h % 24) + 24) % 24 * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
bindRange('tod', 'tod', clock, updateEnv);
bindRange('daylen', 'daylen', v => v === 0 ? 'time stands still' : `${v} min per day`);
bindRange('volume', 'volume', v => v === 0 ? 'off' : `${Math.round(v * 100)}%`, () => { if (settings.volume > 0) audio.unlock(); });
bindRange('wind', 'wind', v => v === 0 ? 'dead calm' : `${v.toFixed(1)}× the simulated wind`);
// environment: live knobs on the weather simulation (the terrain itself stays as the planet made it)
const times = (v, lo, hi) => Math.abs(v - 1) < 0.001 ? 'as simulated' : `${v.toFixed(v < 1 ? 2 : 1)}× ${v < 1 ? lo : hi}`;
bindRange('envTemp', 'envTemp', v => v === 0 ? 'as simulated' : `${v > 0 ? '+' : ''}${v} °C`);
bindRange('envHumid', 'envHumid', v => times(v, 'drier', 'more humid'));
bindRange('envClouds', 'envClouds', v => times(v, 'clearer', 'cloudier'));
bindRange('envStorms', 'envStorms', v => v === 0 ? 'no storms' : times(v, 'calmer', 'stormier'));
bindRange('envRain', 'envRain', v => v === 0 ? 'no rain' : times(v, 'less', 'more'));
bindRange('envFog', 'envFog', v => v === 0 ? 'crystal clear' : times(v, 'clearer', 'hazier'));
const ENV_IDS = ['envTemp', 'envHumid', 'envClouds', 'envStorms', 'envRain', 'envFog', 'wind'];
function syncEnvUI() { for (const id of ENV_IDS) { const el = $(id); el.value = settings[id]; el.dispatchEvent(new Event('input')); } }
$('env-reset').addEventListener('click', () => { Object.assign(settings, ENV_DEFAULTS, { wind: 1 }); syncEnvUI(); });
const shadowsEl = $('shadows');
shadowsEl.checked = settings.shadows;
shadowsEl.addEventListener('change', () => { settings.shadows = shadowsEl.checked; saveSettings(); });
const seedEl = $('seed');
seedEl.value = settings.seed;
$('regen').addEventListener('click', () => {
  const s = parseInt(seedEl.value, 10);
  settings.seed = Number.isFinite(s) ? s : Math.floor(Math.random() * 1e6);
  seedEl.value = settings.seed; saveSettings(); resetWorld();
});
// ---- sharing a spot: seed, position, view, time of day and season in one short code ----
// The code is also the URL hash, so on a normal page (GitHub Pages) a shared link opens right there.
// Inside an embedded artifact the link can't carry a hash, so the code can be pasted into the menu.
function spotCode() {
  const p = state.pos, r = v => Math.round(v * 10) / 10;
  const ev = ENV_IDS.map(k => +settings[k].toFixed(2)), dv = ENV_IDS.map(k => k === 'wind' ? 1 : ENV_DEFAULTS[k]);
  const e = ev.some((v, i) => v !== dv[i]) ? `&e=${ev.join(',')}` : '';
  return `s=${settings.seed}&p=${r(p[0])},${r(p[1])},${r(p[2])}&v=${state.yaw.toFixed(2)},${state.pitch.toFixed(2)}&t=${settings.tod.toFixed(1)}&se=${settings.season}${e}`;
}
function parseSpot(text) {
  if (!text) return null;
  const h = String(text).trim(), q = h.includes('#') ? h.slice(h.indexOf('#') + 1) : h;
  const m = {};
  for (const kv of q.split('&')) { const i = kv.indexOf('='); if (i > 0) m[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  const seed = parseInt(m.s, 10), pos = (m.p || '').split(',').map(Number);
  if (!Number.isFinite(seed) || pos.length !== 3 || !pos.every(Number.isFinite)) return null;
  const v = (m.v || '').split(',').map(Number), t = parseFloat(m.t), se = parseInt(m.se, 10);
  return {
    seed, pos: [((pos[0] % PLANET_W) + PLANET_W) % PLANET_W, Math.min(CH + 60, Math.max(1, pos[1])), Math.min(PLANET_H - 1, Math.max(0, pos[2]))],
    yaw: Number.isFinite(v[0]) ? v[0] : state.yaw, pitch: Number.isFinite(v[1]) ? Math.max(-1.5, Math.min(1.5, v[1])) : 0,
    tod: Number.isFinite(t) ? ((t % 24) + 24) % 24 : null, season: Number.isFinite(se) ? ((se % 4) + 4) % 4 : null,
    env: m.e ? m.e.split(',').map(Number) : null,
  };
}
function shareLink() {
  const code = spotCode();
  return /^https?:$/.test(location.protocol) && !/claude|anthropic|usercontent/.test(location.hostname)
    ? location.href.split('#')[0] + '#' + code : code;
}
// arrive at a spot: same seed keeps the loaded world, another seed grows that planet first
function applySpotEnv(sp) {
  if (!sp.env) return;
  ENV_IDS.forEach((k, i) => { const el = $(k), v = sp.env[i]; if (Number.isFinite(v)) settings[k] = Math.min(+el.max, Math.max(+el.min, v)); });
  syncEnvUI();
}
function goToSpot(sp) {
  applySpotEnv(sp);
  if (sp.tod !== null) settings.tod = sp.tod;
  if (sp.season !== null && sp.season !== settings.season) setSeason(sp.season);
  const data = { world: 2, pos: sp.pos, yaw: sp.yaw, pitch: sp.pitch, fly: true };
  if (sp.seed !== settings.seed) {
    settings.seed = sp.seed; seedEl.value = sp.seed; saveSettings();
    resetWorld(true);
  }
  restoreAt(data);
}
$('spot-share').addEventListener('click', async () => {
  const link = shareLink(), el = $('spot');
  el.value = link;
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (err) {}
  if (!ok) { el.focus(); el.select(); try { ok = document.execCommand('copy'); } catch (err) {} }
  $('spot-v').textContent = ok ? 'copied' : 'select and copy';
  setTimeout(() => { $('spot-v').textContent = ''; }, 2500);
});
$('spot-go').addEventListener('click', () => {
  const sp = parseSpot($('spot').value);
  if (!sp) { $('spot-v').textContent = 'not a spot code'; setTimeout(() => { $('spot-v').textContent = ''; }, 2500); return; }
  goToSpot(sp);
  setPlaying(true);
});
$('spot').addEventListener('keydown', e => { if (e.key === 'Enter') $('spot-go').click(); e.stopPropagation(); });
window.addEventListener('hashchange', () => { const sp = parseSpot(location.hash); if (sp) goToSpot(sp); });
$('reseed').addEventListener('click', () => {
  settings.seed = Math.floor(Math.random() * 1e6);
  seedEl.value = settings.seed; saveSettings(); resetWorld();
});

const seasonBtns = [...document.querySelectorAll('#seasons button')];
function syncSeason() {
  seasonBtns.forEach((b, i) => b.setAttribute('aria-checked', String(i === settings.season)));
  $('month').textContent = MONTHS[settings.season];
  $('menu-sub').textContent = SUBS[settings.season];
}
seasonBtns.forEach((b, i) => b.addEventListener('click', () => setSeason(i)));
syncSeason();
seasonVis = settings.season;

const FX_LABELS = [['bloom', 'Bloom'], ['rays', 'God rays'], ['ssao', 'Ambient occlusion'], ['dof', 'Depth of field'],
  ['motion', 'Motion blur'], ['flare', 'Lens flare'], ['ssr', 'Water reflections'], ['caustics', 'Caustics'], ['ocean', 'Ocean ripples (FFT)'],
  ['mist', 'Valley mist'], ['clouds', 'Clouds'], ['cloudSim', 'Weather-driven clouds'], ['ca', 'Chromatic aberration'], ['fxaa', 'FXAA']];
const fxGrid = $('fx-grid');
for (const [k, label] of FX_LABELS) {
  const l = document.createElement('label');
  l.className = 'check'; l.htmlFor = 'fx-' + k;
  l.innerHTML = `<input id="fx-${k}" type="checkbox"> ${label}`;
  fxGrid.appendChild(l);
  l.firstChild.addEventListener('change', e => { settings.fx[k] = e.target.checked; saveSettings(); });
}
const lookEl = $('look'), expoEl = $('exposure'), cqEl = $('cloudq');
const CLOUD_Q = ['Low', 'Medium', 'High', 'Ultra'];
LOOKS.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; lookEl.appendChild(o); });
function syncFx() {
  for (const [k] of FX_LABELS) $('fx-' + k).checked = !!settings.fx[k];
  lookEl.value = settings.fx.look; expoEl.value = settings.fx.exposure;
  $('exposure-v').textContent = settings.fx.exposure.toFixed(2) + '×';
  cqEl.value = settings.fx.cloudQ ?? 2; $('cloudq-v').textContent = CLOUD_Q[settings.fx.cloudQ ?? 2];
}
syncFx();
lookEl.addEventListener('change', () => { settings.fx.look = Number(lookEl.value); saveSettings(); });
cqEl.addEventListener('input', () => { settings.fx.cloudQ = Number(cqEl.value); syncFx(); saveSettings(); });
expoEl.addEventListener('input', () => { settings.fx.exposure = Number(expoEl.value); syncFx(); saveSettings(); });
$('fx-all').addEventListener('click', () => { for (const [k] of FX_LABELS) settings.fx[k] = true; syncFx(); saveSettings(); });
$('fx-none').addEventListener('click', () => { for (const [k] of FX_LABELS) settings.fx[k] = false; syncFx(); saveSettings(); });

// menu tabs: Play, Guide, Controls, Graphics, Weather, World; the last one opened comes back next time
const TABS = ['play', 'guide', 'controls', 'graphics', 'weather', 'world'];
function setTab(name, focus) {
  if (!TABS.includes(name)) name = 'play';
  for (const k of TABS) {
    const on = k === name, b = $('tab-' + k);
    b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    $('pane-' + k).hidden = !on;
  }
  $('panes').scrollTop = 0;
  if (focus) $('tab-' + name).focus();
  settings.menuTab = name; saveSettings();
}
TABS.forEach(k => $('tab-' + k).addEventListener('click', () => setTab(k)));
$('tabs').addEventListener('keydown', e => {
  const i = TABS.indexOf(settings.menuTab), n = TABS.length;
  const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
  if (j >= 0) { setTab(TABS[j], true); e.preventDefault(); }
});
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.goto, true)));
setTab(settings.menuTab);
$('map-open').addEventListener('click', () => toggleMap(true));
$('map-close').addEventListener('click', () => toggleMap(false));
if (isTouch) $('maphelp').textContent = 'Double-tap to teleport · tap outside the map to close';
// touch screens have no Ctrl: a double tap on the map teleports
let lastTap = null;
$('map').addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  const now = performance.now();
  if (lastTap && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    mapTeleport({ clientX: e.clientX, clientY: e.clientY, ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

function setPlaying(on) {
  playing = on;
  menu.hidden = on;
  document.body.classList.toggle('playing', on);
  if (!on) { keys.clear(); $('enter').textContent = 'Back to the forest'; }
}
let lockFailed = false;
$('globe-btn').addEventListener('click', () => toggleMap(true));
$('mapview').addEventListener('click', e => { if (e.target === e.currentTarget) toggleMap(false); });
$('enter').addEventListener('click', () => {
  setPlaying(true);
  if (!isTouch && canvas.requestPointerLock) {
    try {
      const r = canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => { lockFailed = true; });
    } catch (e) { lockFailed = true; }
  }
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && playing && !isTouch && !lockFailed && $('mapview').hidden) setPlaying(false);
});
document.addEventListener('pointerlockerror', () => { lockFailed = true; });

const locked = () => document.pointerLockElement === canvas;
let drag = null;
canvas.addEventListener('mousedown', e => {
  if (!playing || isTouch) return;
  if (locked()) {
    if (e.button === 0) breakBlock(); else if (e.button === 2) placeBlock();
  } else drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
});
window.addEventListener('mouseup', () => {
  if (drag && drag.moved < 4) { if (drag.button === 0) breakBlock(); else if (drag.button === 2) placeBlock(); }
  drag = null;
});
window.addEventListener('mousemove', e => {
  if (!playing) return;
  let dx = 0, dy = 0;
  if (locked()) { dx = e.movementX; dy = e.movementY; }
  else if (drag) { dx = e.clientX - drag.x; dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy); }
  look(dx * 0.0024, dy * 0.0024);
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
let lookT = 0;
function look(dx, dy) {
  if (dx || dy) lookT = performance.now();
  state.yaw -= dx;
  state.pitch = Math.max(-1.55, Math.min(1.55, state.pitch - dy));
}
window.addEventListener('wheel', e => { if (playing) selectSlot(state.slot + (e.deltaY > 0 ? 1 : -1)); }, { passive: true });
window.addEventListener('keydown', e => {
  if (!$('mapview').hidden && (e.code === 'Escape' || e.code === 'KeyM')) { toggleMap(false); e.preventDefault(); return; }
  if (!$('mapview').hidden && MAP_CODES.indexOf(e.code) >= 0 && MAP_CODES.indexOf(e.code) < MAP_MODES.length) { setMapMode(MAP_CODES.indexOf(e.code)); e.preventDefault(); return; }
  if (!$('mapview').hidden) { const o = OVERLAYS.find(o => 'Key' + o[1] === e.code); if (o) { toggleOverlay(o[0]); e.preventDefault(); return; } }
  if (e.code === 'KeyM' && document.activeElement?.tagName !== 'INPUT') { toggleMap(true); return; }
  if (!playing) {
    if (e.code === 'Enter' && !menu.hidden && !/^(INPUT|BUTTON|SELECT)$/.test(document.activeElement?.tagName)) $('enter').click();
    return;
  }
  if (e.code === 'Escape' && !locked()) { setPlaying(false); return; }
  keys.add(e.code);
  if (e.code === 'KeyG') { settings.fx.look = (settings.fx.look + 1) % LOOKS.length; syncFx(); saveSettings(); showToast(LOOKS[settings.fx.look]); }
  if (e.code === 'KeyN') setSeason(settings.season + 1, true);
  if (e.code === 'KeyT') { settings.tod = (settings.tod + (e.shiftKey ? 23 : 1)) % 24; saveSettings(); showToast(clock(settings.tod)); }
  if (e.code === 'KeyB') toggleBoat();
  if (e.code === 'KeyF' && !boat.state.aboard) { state.fly = !state.fly; state.vel[1] = 0; showToast(state.fly ? 'Flying' : 'Walking'); }
  if (/^Digit[1-9]$/.test(e.code)) selectSlot(Number(e.code.slice(5)) - 1);
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// touch controls: left half moves, right half looks
if (isTouch) {
  const stick = $('stick'), knob = $('knob');
  let moveId = null, lookId = null, mo = null, lo = null;
  canvas.addEventListener('touchstart', e => {
    if (!playing) return;
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && moveId === null) {
        moveId = t.identifier; mo = { x: t.clientX, y: t.clientY };
        stick.style.left = (t.clientX - 56) + 'px'; stick.style.top = (t.clientY - 56) + 'px'; stick.hidden = false;
      } else if (lookId === null) { lookId = t.identifier; lo = { x: t.clientX, y: t.clientY }; }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = (t.clientX - mo.x) / 48, dy = (t.clientY - mo.y) / 48;
        const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
        touch.mx = dx; touch.mz = -dy;
        knob.style.transform = `translate(${dx * 36}px, ${dy * 36}px)`;
      } else if (t.identifier === lookId) {
        look((t.clientX - lo.x) * 0.005, (t.clientY - lo.y) * 0.005);
        lo = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  const end = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; touch.mx = touch.mz = 0; stick.hidden = true; knob.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
    }
  };
  canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  const hold = (id, on, off) => {
    const el = $(id);
    el.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive: false });
    el.addEventListener('touchend', e => { e.preventDefault(); off && off(); }, { passive: false });
  };
  hold('t-jump', () => { touch.jump = true; }, () => { touch.jump = false; });
  hold('t-break', breakBlock);
  hold('t-place', placeBlock);
  hold('t-boat', toggleBoat);
  hold('t-fly', () => { state.fly = !state.fly; showToast(state.fly ? 'Flying' : 'Walking'); });
  hold('t-menu', () => setPlaying(false));
  hold('t-map', () => toggleMap(true));
  hold('t-down', () => { touch.down = true; }, () => { touch.down = false; });
}

// ---------- loop ----------
let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, hudT = 0, todSaveT = 0;
const clockStart = performance.now();
// the next frame is booked first, so one bad frame can never stop the game
let frameErrs = 0;
function frame(now) {
  requestAnimationFrame(frame);
  try { frameBody(now); }
  catch (e) { if (frameErrs++ < 20) reportError((e && e.stack) || e); }
}
function frameBody(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  {
    const d = ((settings.season - seasonVis) % 4 + 6) % 4 - 2;
    seasonVis = (((seasonVis + Math.sign(d) * Math.min(Math.abs(d), dt * 0.8)) % 4) + 4) % 4;
  }
  if (settings.daylen > 0) settings.tod = (settings.tod + dt * 24 / (settings.daylen * 60)) % 24;
  updateEnv();
  processResults();
  updateChunks();
  simStep(dt);
  if (planet && !weather.ready && state.spawned) {
    weather.reset(planet, settings.seed, state.pos[0], state.pos[2], settings.season);
    if (atmos) { try { atmos.reset(planet); atm.spun = 0; } catch (e) { console.warn('global weather off:', e); atmos = null; } }
    weather.atmos = null;
  }
  atmosStep(dt);
  weather.windMul = settings.wind; weather.tod = settings.tod; weather.dayLen = (settings.daylen || 20) * 60;
  weather.humid = settings.envHumid; weather.cloudy = settings.envClouds; weather.stormMul = settings.envStorms; weather.rainMul = settings.envRain;
  if (weather.temp !== settings.envTemp) { weather.temp = settings.envTemp; weather.envChanged(); }
  weather.update(dt, state.pos[0], state.pos[2]);
  // the sky clouds drift with the mean wind, like the cloud map they are shaped by
  cloudWind[0] -= weather.mean[0] * CLOUD_ADV * 16 * dt; cloudWind[1] -= weather.mean[1] * CLOUD_ADV * 16 * dt;
  if (weather.ready) cloudMean += (weather.meanCover * weather.meanCover - cloudMean) * Math.min(1, dt / 4);
  // the local wind (prevailing flow plus passing storms, scaled by the wind slider) drives the
  // foliage sway, the falling leaves and the sea state; smoothed over a few seconds
  {
    const w = weather.ready ? weather.windAt(state.pos[0] / 16, state.pos[2] / 16) : [0.7, 0.2];
    // a thunderstorm's gust front (rain-cooled air pouring out ahead of the storm) is part of the
    // simulated wind; its strength here makes the wind gustier
    if (weather.ready && now - outflowT > 250) { outflowT = now; outflow = weather.outflowAt(state.pos[0], state.pos[2]); }
    const k = Math.min(1, dt / 1.5);
    localWind[0] += (w[0] * settings.wind - localWind[0]) * k; localWind[1] += (w[1] * settings.wind - localWind[1]) * k;
    const sp0 = Math.hypot(localWind[0], localWind[1]);
    // gusts: the wind comes in bursts, more so when it is strong and in stormy air
    const t = now / 1000, g = 0.5 * Math.sin(t * 0.37) + 0.3 * Math.sin(t * 1.13 + 1.7) + 0.2 * Math.sin(t * 2.71 + 4.1);
    const gusty = 0.25 + 0.35 * Math.min(1, sp0 / 2) + 0.4 * Math.min(1, env.precip * 1.5 + Math.hypot(outflow[0], outflow[1]));
    env.gust = 1 + gusty * Math.max(0, g) ** 2 * 1.8;
    const sp = sp0 * env.gust;
    env.windSpeed = sp;
    env.foliage = Math.min(3, sp * 1.1);
    env.seaWind = [localWind[0] / (sp0 || 1), localWind[1] / (sp0 || 1), Math.min(2.2, 0.15 + sp0 * 0.95)];
    // swell from storms out at sea: it builds and dies away slowly, as the waves take hours to
    // arrive; the boat reads it from the wind array so it rides the same waves the sea draws
    if (weather.ready && now - swellT > 500) { swellT = now; swellTgt = weather.swellAt(state.pos[0], state.pos[2]); }
    const ks = Math.min(1, dt / 40);
    env.swell = [env.swell[0] + (swellTgt[0] - env.swell[0]) * ks, env.swell[1] + (swellTgt[1] - env.swell[1]) * ks, env.swell[2] + (swellTgt[2] - env.swell[2]) * ks];
    env.seaWind.swell = env.swell;
  }
  updateWeatherEnv(dt);
  // rain overhead greys and dims the light and thickens the haze; lightning lights everything up
  {
    const k = Math.max(env.precip, env.overcast * 0.85);
    const grey = c => { const l = (c[0] + c[1] + c[2]) / 3 * 0.8; return c.map(x => (x + (l - x) * k * 0.8) * (1 - 0.62 * k)); };
    env.zenith = grey(env.zenith); env.horizon = grey(env.horizon);
    env.sunCol = env.sunCol.map(x => x * (1 - 0.6 * k)); env.ambSky = env.ambSky.map(x => x * (1 - 0.4 * k));
    env.flash = cloudsOn() ? weather.flash() : null;
    env.flashI = 0;
    if (env.flash) {
      const d = Math.hypot(env.flash.x - state.pos[0], env.flash.z - state.pos[2]);
      const fi = env.flash.I * 1.6 / (1 + (d / 450) ** 2);
      env.flashI = fi;
      const add = (c, m) => c.map((x, i) => x + fi * m * [0.75, 0.8, 1.0][i]);
      env.ambSky = add(env.ambSky, 0.9); env.ambGround = add(env.ambGround, 0.35);
      env.zenith = add(env.zenith, 0.5); env.horizon = add(env.horizon, 0.7);
    }
  }
  const ec = Math.floor(state.pos[0] / CS) + ',' + Math.floor(state.pos[2] / CS);
  if (ec !== emitCenter) { emitCenter = ec; emitDirty = true; }
  if (emitDirty && now - emitT > 400) { emitDirty = false; emitT = now; rebuildEmitters(); }
  // the boat moves on the same clock the sea shader uses; aboard, you go where she goes and the
  // camera swings round behind her when you leave the mouse alone
  if (boat.state.active && state.spawned) boat.update(dt, (now - clockStart) / 1000, boatInput(), env.seaWind, getBlock, isW);
  if (boat.state.aboard) {
    const p = boat.state.pos;
    state.pos = [p[0], p[1] + 1.2, p[2]]; state.vel = [0, 0, 0];
    if (playing && now - lookT > 1500 && Math.abs(boat.state.speed) > 1) {
      let d = boat.state.yaw - state.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      state.yaw += d * Math.min(1, dt * 0.9);
    }
  }
  if (state.spawned && playing && !boat.state.aboard) physics(dt);
  else if (!state.spawned) state.pos[1] = 72;
  else if (!playing) state.yaw += dt * 0.03; // slow pan behind the menu
  target = playing && !boat.state.aboard ? raycast(eyePos(), camDir(), 7) : null;
  const time = (now - clockStart) / 1000;
  render(time, dt);
  if (now - hear.t > 250) { hear.t = now; if (state.spawned) listenAround(); }
  {
    const ey = eyePos(), eb = getBlock(Math.floor(ey[0]), Math.floor(ey[1]), Math.floor(ey[2]));
    audio.update(dt, {
      volume: settings.volume, playing, x: state.pos[0], z: state.pos[2], height: state.pos[1],
      right: [Math.cos(state.yaw), 0, -Math.sin(state.yaw)],
      rain: env.rain, wind: env.windSpeed, gust: env.gust, canopy: hear.canopy, roof: hear.roof, trees: hear.trees,
      sea: weather.ready && state.pos[1] < 70 ? Math.min(1, weather.seaNear(state.pos[0], state.pos[2], 2) * 2.2) : 0, seaState: env.seaWind[2],
      underwater: isW(eb) && ey[1] - Math.floor(ey[1]) < lvlOf(eb) / 8 * 0.9 + 0.02,
      flash: env.flash,
    });
  }
  if (!playing) drawGlobe(now, dt);
  if (now - hudT > 250) {
    trackTrail();
    if (!$('mapview').hidden) drawMap();
    hudT = now;
    document.body.classList.toggle('flying', state.fly && !boat.state.aboard);
    const p = state.pos;
    let ready = 0; for (const ch of chunks.values()) if (ch.state === 'ready') ready++;
    hud.textContent =
      `${fps.toFixed(0).padStart(3)} fps   ${(stats.tris / 1000).toFixed(0)}k tris   ${stats.draws} draws\n` +
      `${ready} chunks · ${stats.visible} in view · ${inflight()} growing\n` +
      `${clock(settings.tod)}   x ${p[0].toFixed(1)}  y ${p[1].toFixed(1)}  z ${p[2].toFixed(1)}${boat.state.aboard ? `   sailing ${(Math.abs(boat.state.speed) * 1.944).toFixed(1)} kn` : state.fly ? '   flying' : ''}   seed ${settings.seed} · ${BUILD}`;
    const loading = $('loading');
    loading.hidden = state.spawned;
    if (!state.spawned) loading.textContent = planet ? 'Growing the forest…' : planetText;
    $('hud-wx').textContent = weatherWords();
    const lat = latOf(p[2]);
    $('lat').textContent = `${Math.abs(lat).toFixed(0)}° ${lat >= 0 ? 'N' : 'S'}`;
    $('tod').value = settings.tod; $('tod-v').textContent = clock(settings.tod);
    if (now - todSaveT > 10000) { todSaveT = now; saveSettings(); }
  }
}

// keep the walk going across live page updates
const hot = window.claude && window.claude.hot;
if (hot && hot.snapshot) {
  try { hot.snapshot(() => ({ world: 2, pos: state.pos, yaw: state.yaw, pitch: state.pitch, fly: state.fly })); } catch (e) {}
}
// If the GPU driver resets the context (a frame took too long), come back where the player was
// with screen-space reflections off instead of leaving a dead canvas.
canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  try { sessionStorage.setItem('emberwood.resume', JSON.stringify({ world: 2, pos: state.pos, yaw: state.yaw, pitch: state.pitch, fly: state.fly })); } catch (err) {}
  if (settings.fx.ssr) { settings.fx.ssr = false; saveSettings(); }
  const o = document.createElement('div');
  o.id = 'ctxlost';
  o.textContent = 'The graphics driver reset. Reloading with lighter water reflections…';
  document.body.appendChild(o);
  setTimeout(() => location.reload(), 1200);
});
function start(data) {
  if (!data || !data.pos) {
    try {
      const r = JSON.parse(sessionStorage.getItem('emberwood.resume') || 'null');
      sessionStorage.removeItem('emberwood.resume');
      if (r && r.pos) data = r;
    } catch (err) {}
  }
  if (data && data.pos && data.world !== 2) data = null; // saved on the old flat world
  // a shared spot in the URL wins over everything else
  let shared = null;
  try { shared = parseSpot(location.hash); } catch (err) {}
  if (shared) {
    if (shared.seed !== settings.seed) { settings.seed = shared.seed; seedEl.value = shared.seed; saveSettings(); }
    if (shared.season !== null && shared.season !== settings.season) setSeason(shared.season);
    if (shared.tod !== null) settings.tod = shared.tod;
    applySpotEnv(shared);
    data = { world: 2, pos: shared.pos, yaw: shared.yaw, pitch: shared.pitch, fly: true };
  }
  requestPlanet();
  if (data && data.pos) restoreAt(data);
  requestAnimationFrame(frame);
}
let restoreTick = 0;
function restoreAt(data) {
  state.yaw = data.yaw; state.pitch = data.pitch; state.fly = data.fly;
  state.pos = data.pos.slice(); state.vel = [0, 0, 0]; state.spawned = false; state.restoring = true;
  const keepPos = data.pos.slice();
  clearInterval(restoreTick);
  restoreTick = setInterval(() => {
    const ch = chunks.get(ckey(Math.floor(keepPos[0] / CS), Math.floor(keepPos[2] / CS)));
    if (ch && ch.state === 'ready') {
      // a teleport lands on whatever is on top there: ground, or the surface of the water
      if (data.ground) {
        // under the canopy rather than on it: leaves and twigs are passed through, and a trunk is stepped around
        const tree = b => (b >= B.OAK_LOG && b <= B.LEAF_GREEN) || b === B.TWIG || isPlant(b);
        for (let k = 0; k < 4; k++) {
          const bx = Math.floor(keepPos[0]), bz = Math.floor(keepPos[2]);
          let y = CH - 2, b = 0;
          for (; y > 1; y--) { b = getBlock(bx, y, bz); if (b > 0 && !tree(b)) break; }
          keepPos[1] = y + (isW(b) ? 0.6 : 1.02);
          const above = getBlock(bx, y + 1, bz);
          if (above < B.OAK_LOG || above > B.SPRUCE_LOG) break;
          keepPos[0] += 1.5;
        }
      }
      state.pos = keepPos.slice(); state.spawned = true; state.restoring = false; clearInterval(restoreTick);
    }
  }, 100);
}
window.__emberwood = { get wxForce() { return wxForce; }, set wxForce(v) { wxForce = v; }, audio, heightCPU, setSeason: i => { setSeason(i); seasonVis = settings.season; }, get planet() { return planet; }, state, chunks, settings, setPlaying, stats, setBlock, getBlock, simQ, jobs: () => inflight(), results, get remeshCount() { return remeshCount; }, simFlips, get emitCount() { return emitCount; }, get foamCount() { return foamCount; }, weather, env, progs, ocean, boat, get boltPath() { return boltPath; }, spotCode, parseSpot, goToSpot };
if (hot && hot.ready) hot.ready(start); else start(hot && hot.data ? hot.data : {});
})();

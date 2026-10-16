// Emberwood chunk worker: terrain + tree generation and greedy meshing.
// Runs off the main thread; one instance per worker in the pool.
const CS = 32, CH = 124, P = CS + 2, WL = 30, CELL = 5, FR = 12;
let BARE = false; // winter: deciduous trees stand bare
const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, WATER = 5,
  OAK_LOG = 6, BIRCH_LOG = 7, SPRUCE_LOG = 8,
  LEAF_RED = 9, LEAF_ORANGE = 10, LEAF_YELLOW = 11, LEAF_BROWN = 12, LEAF_GREEN = 13,
  LITTER = 14, MOSSY = 15, PLANKS = 16, FLOW1 = 17, FALL = 24, SNOW = 25, ICE = 26,
  REED = 27, TUFT = 28, TWIG = 29; // cross-quad plants: reeds and cattails (two blocks tall), grass tufts
const isPlant = b => b === REED || b === TUFT;
// water: WATER is a source, FLOW1..FLOW7 (17..23) are flowing levels 1..7, FALL is a falling column
const isWater = b => b === WATER || (b >= FLOW1 && b <= FALL);
const levelOf = b => (b === WATER || b === FALL) ? 8 : (b >= FLOW1 && b < FALL) ? b - 16 : 0;

// ---------- noise ----------
function makeNoise(seed) {
  const p = new Uint8Array(256), perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const GX = [1, -1, 1, -1, 1, -1, 0, 0], GY = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  return function (x, y) {
    const sk = (x + y) * F2, i = Math.floor(x + sk), j = Math.floor(y + sk);
    const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0, g;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { g = perm[ii + perm[jj]] & 7; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { g = perm[ii + i1 + perm[jj + j1]] & 7; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { g = perm[ii + 1 + perm[jj + 1]] & 7; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
    return 70 * n;
  };
}

let seed = null, nA, nB, nC, nD, nE, nL, nM;
function setSeed(s) {
  if (s === seed) return;
  seed = s;
  nA = makeNoise(s * 7 + 1); nB = makeNoise(s * 7 + 2); nC = makeNoise(s * 7 + 3);
  nD = makeNoise(s * 7 + 4); nE = makeNoise(s * 7 + 5); nL = makeNoise(s * 7 + 6);
  nM = makeNoise(s * 13 + 9);
  PL = simulatePlanet(s, planetProgress);
  for (let k = 0; k < PN; k++) {
    cellY[k] = elevToY(PL.elev[k]);
    lakeY[k] = PL.lake[k] > 0 ? Math.floor(elevToY(PL.lake[k])) : 0;
  }
  // how well watered each cell is: land rain ranked 0..1, plus a halo around rivers and lakes
  {
    const lr = [];
    for (let k = 0; k < PN; k++) if (PL.elev[k] > 0) lr.push(PL.rain[k]);
    lr.sort((a, b) => a - b);
    for (let k = 0; k < PN; k++) {
      let lo = 0, hi = lr.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (lr[m] < PL.rain[k]) lo = m + 1; else hi = m; }
      rainN[k] = lr.length ? lo / lr.length : 0.5;
      wetF[k] = PL.elev[k] > 0 && (isMainRiver(k) || lakeY[k] > 0) ? 1 : 0;
    }
    const tmp = new Float32Array(PN);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < PH; j++)
        for (let i = 0; i < PW; i++) {
          let m = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) m = Math.max(m, wetF[pcell(i + di, j + dj)] * (di || dj ? 0.72 : 1));
          tmp[j * PW + i] = m;
        }
      wetF.set(tmp);
    }
  }
  segCache.clear();
  buildDeltas(); // (before the levels: the brooks' levels read the river mouths' channels)
  computeLevels();
}
function hash(x, z, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s + seed, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const hash3 = (x, y, z) => hash(x + Math.imul(y, 7919), z, 99);

// ---------- terrain ----------
// The planet simulation gives the large-scale height (one value per 16x16 cell, smoothly
// interpolated); local noise adds hills, rough mountain ridges and terraced cliff bands.
let PL = null, planetProgress = () => {};
const cellY = new Float32Array(PN), lakeY = new Float32Array(PN), rainN = new Float32Array(PN), wetF = new Float32Array(PN);
// land rises quickly off the coast (so lowland rivers still sit in valleys) and then more slowly
// toward the peaks
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
// the sea floor drops off the coast to about 27 blocks deep in the open ocean (it was ~12)
const elevToY = e => e <= 0 ? WL - 27 * (1 - Math.exp(e / 0.55)) : WL + 0.6 + 30 * (1 - Math.exp(-e / 0.9)) + 4 * (1 - Math.exp(-e / 0.06)) + 26 * smooth(0.35, 1.6, e);
const pcell = (i, j) => ((j < 0 ? 0 : j >= PH ? PH - 1 : j) * PW) + (((i % PW) + PW) % PW);
const cr = (a, b, c, d, t) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
function planetY(x, z) {
  const u = x / PCELL - 0.5, v = z / PCELL - 0.5;
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const row = jj => cr(cellY[pcell(i - 1, jj)], cellY[pcell(i, jj)], cellY[pcell(i + 1, jj)], cellY[pcell(i + 2, jj)], fu);
  return cr(row(j - 1), row(j), row(j + 1), row(j + 2), fv);
}
const cellAt = (x, z) => pcell(Math.floor(x / PCELL), Math.floor(z / PCELL));
// bilinear sample of a per-cell planet field
function fieldAt(F, x, z) {
  const u = x / PCELL - 0.5, v = z / PCELL - 0.5, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const a = F[pcell(i, j)] + (F[pcell(i + 1, j)] - F[pcell(i, j)]) * fu;
  const b = F[pcell(i, j + 1)] + (F[pcell(i + 1, j + 1)] - F[pcell(i, j + 1)]) * fu;
  return a + (b - a) * fv;
}
function rawHeight(x, z) {
  const Y = planetY(x, z);
  const land = Math.min(1, Math.max(0, (Y - WL) / 5));
  const mount = Math.min(1, Math.max(0, (Y - 42) / 18));
  const b = nB(x / 95, z / 95), c = nC(x / 28, z / 28);
  // plains keep only a gentle swell of the local hills
  const pl = fieldAt(PL.plain, x, z);
  let h = Y + (b * 4.5 + c * 1.5) * (0.25 + 0.75 * land) * (1 - 0.75 * pl);
  if (mount > 0) {
    // ridged multifractal on the plate ranges: knife-edge crests, steep faces, and each octave
    // only adds detail where the one above it is already high (peaks get rougher than valleys)
    let f = 1 / 120, a = 1, sum = 0, wgt = 1;
    for (let o = 0; o < 3; o++) {
      let r = 1 - Math.abs(nA(x * f + o * 17.3, z * f - o * 9.1));
      r *= r * wgt;
      wgt = Math.min(1, r * 1.8);
      sum += r * a; a *= 0.5; f *= 2.13;
    }
    h += mount * (sum * 24 - 8 + nC(x / 9, z / 9) * 1.2);
  }
  // terraced cliff bands on some uplands, which give rivers somewhere to fall
  const m = nM(x / 330, z / 330);
  const hi = Math.max(0, m - 0.05) * Math.min(1, Math.max(0, (Y - 36) / 6)) * (1 - pl);
  if (hi > 0) {
    const s = 6, f = h / s, fi = Math.floor(f);
    let fr = f - fi; fr = Math.min(1, Math.max(0, (fr - 0.6) / 0.25)); fr = fr * fr * (3 - 2 * fr);
    h += ((fi + fr) * s - h) * Math.min(1, hi * 4);
  }
  return h;
}

// ---------- erosion ----------
// An analytic erosion filter: every octave lays down stripes that run along the current
// downhill direction (blended between jittered points), so slopes get branching gullies
// separated by sharp ridges. Each octave bends the slope the next one follows, which makes
// small gullies feed into bigger ones. Steepness controls the depth and flat ground is left
// alone, so valley floors stay smooth like sediment. Being a pure function of (x, z), it
// stays seamless across chunks and every worker agrees on it.
let EROSION = 0, EROSION_AT = 0; // last erosion offset, < 0 inside gullies (read by the material pass)
function gullies(px, pz, dx, dz, out) {
  const cx = Math.floor(px), cz = Math.floor(pz);
  const qx = -dz, qz = dx; // across the slope
  let acc = 0, gx = 0, gz = 0, ws = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const kx = cx + i, kz = cz + j;
      const ox = px - (kx + hash(kx, kz, 71)), oz = pz - (kz + hash(kx, kz, 72));
      const w = Math.exp(-(ox * ox + oz * oz) * 1.6);
      const ph = (ox * qx + oz * qz) * 6.2832;
      const c = Math.cos(ph), sn = Math.sin(ph) * 6.2832;
      acc += c * w; gx -= sn * qx * w; gz -= sn * qz * w; ws += w;
    }
  out[0] = acc / ws; out[1] = gx / ws; out[2] = gz / ws;
}
const GO = [0, 0, 0], EROSION_AMP = 5, EROSION_BIAS = 0.2;
function baseHeight(x, z) {
  const h0 = rawHeight(x, z);
  // slope of the broad landform (wide differences skip the small bumps), which the gullies follow
  const e = 4;
  let sx = (rawHeight(x + e, z) - rawHeight(x - e, z)) / (2 * e);
  let sz = (rawHeight(x, z + e) - rawHeight(x, z - e)) / (2 * e);
  // keep shores and lake beds as they were so lakes don't grow
  let shore = (h0 - WL - 1) / 6; shore = shore < 0 ? 0 : shore > 1 ? 1 : shore;
  // glaciated ground was planed smooth by ice, so rain gullies fade out under it
  const k0 = cellAt(x, z), frost = Math.min(1, Math.max(fieldAt(PL.ice, x, z), -(PL.temp[k0] - (h0 - cellY[k0]) * 0.25) / 6));
  const steep0 = Math.min(1, Math.hypot(sx, sz) * 2.5) * shore * shore * (3 - 2 * shore) * (1 - Math.max(0, frost)) * (1 - fieldAt(PL.plain, x, z));
  let h = h0, amp = EROSION_AMP, freq = 1 / 44, ero = 0;
  if (steep0 > 0.01)
    for (let o = 0; o < 3; o++) {
      const sl = Math.hypot(sx, sz);
      if (sl < 1e-4) break;
      gullies(x * freq, z * freq, sx / sl, sz / sl, GO);
      const k = amp * steep0;
      const d = k * (GO[0] - EROSION_BIAS);
      h += d; ero += d;
      sx += GO[1] * k * freq; sz += GO[2] * k * freq;
      amp *= 0.5; freq *= 2;
    }
  // never cut dry land below the lake level (no stray puddles in gully bottoms)
  if (h0 >= WL + 1 && h < WL + 1) { ero += WL + 1 - h; h = WL + 1; }
  EROSION = ero;
  if (h < WL) h = Math.max(2, h);
  return h;
}

// ---------- rivers ----------
// Rivers come from the planet's drainage network: every cell that gathers enough rain carries
// a channel to the cell it drains into. Each cell gets one jittered river point and each link
// bends through a noisy midpoint, so channels meander instead of following the grid. The water
// level is the planet's (monotone) drainage surface, so a river only ever steps down, and big
// steps become waterfalls.
// Headwater brooks: well before a cell gathers enough water for a river, a thin brook already
// trickles down the hillside from a spring high on the slope, so a river doesn't appear out of
// nowhere halfway down a valley. Brooks are one or two blocks wide and cut only a small notch.
const RIVER_MIN = RIVER_MIN_PLANET, BROOK_MIN = 0.9, BROOK_AREA = 3, BROOK_R = 14;
// (half-width in blocks: a brook is 1-2 wide, a stream about 3, the great rivers of a continent 25-30;
// a brook never gets narrower than 0.8 so it stays one connected channel on the diagonals)
const riverWidth = a => a < RIVER_MIN ? 0.8 + 0.4 * Math.max(0, a - BROOK_MIN) / (RIVER_MIN - BROOK_MIN)
  : Math.min(16, Math.max(1.2, 1.4 + Math.sqrt(Math.max(0, a - RIVER_MIN) / RIVER_MIN) * 1.25));
const bankW = w => 3 + w * 1.4;
// how far from a channel valley walls can reach; level drops at least this big stay waterfalls
const VALLEY_R = 52, FALL_STEP = 3, PEAK = CH - 40;
const segCache = new Map();
let segs = [];
// one point per cell: a little jitter plus a smooth drift shared with the neighbours, so runs
// of cells bend together into long sweeping curves instead of straight grid lines
const riverPt = (ci, cj) => {
  const x = ci * PCELL + 8, z = cj * PCELL + 8;
  return [x + (hash(ci, cj, 51) - 0.5) * 4 + nE(x / 90, z / 90) * 9, z + (hash(ci, cj, 52) - 0.5) * 4 + nL(x / 90 + 40, z / 90) * 9];
};
// A river's water level sits just below the lowest ground around its river point (so it never
// runs perched above the land beside it) and never rises downstream.
// A brook follows the ground as it is after the big rivers' valleys have been cut into it, so
// near a river it runs down the valley side into it instead of being left perched up there.
const riverLV = new Float32Array(PN), levels2 = new Float32Array(PN), outLV = new Float32Array(PN); // (outLV: where a brook meets its river)
let carveLevels = false;
function ownLevel(k) {
  if (PL.elev[k] <= 0) return WL;
  if (lakeY[k]) return Math.max(WL, lakeY[k]);
  let y = cellY[k];
  if (isRiverCell(k)) {
    const i = k % PW, [x, z] = riverPt(i, (k - i) / PW);
    const near = carveLevels && !isMainRiver(k) ? mainSegsNear(x - 6, z - 6, x + 6, z + 6) : null;
    const g = (x, z) => near ? mainCarve(near, x, z, rawHeight(x, z)) : rawHeight(x, z);
    for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]]) y = Math.min(y, g(x + dx, z + dz));
    y = Math.max(y, (near ? Math.min(cellY[k], g(x, z)) : cellY[k]) - 6);
  }
  return Math.max(WL, Math.floor(y) - 1);
}
function levelPass(out) {
  out.fill(-1);
  const stack = [];
  for (let k = 0; k < PN; k++) {
    let c = k;
    while (out[c] < 0) { stack.push(c); const r = PL.recv[c]; if (r < 0 || PL.elev[c] <= 0) break; c = r; }
    while (stack.length) {
      const q = stack.pop(), r = PL.recv[q];
      // (the main rivers keep their first-pass levels: they never depend on the brooks)
      const own = carveLevels && isMainRiver(q) ? riverLV[q] : ownLevel(q);
      let down = r >= 0 && PL.elev[q] > 0 ? out[r] : -1;
      // a brook ends in the river's water where it meets it, which can lie below the river
      // cell's own level (at a mouth, the delta runs at sea level)
      if (carveLevels && down >= 0 && isRiverCell(q) && !isMainRiver(q) && isMainRiver(r)) {
        const ri = r % PW, [bx, bz] = riverPt(ri, (r - ri) / PW);
        const wB = mainCarve(mainSegsNear(bx, bz, bx, bz), bx, bz, 1e6);
        if (wB < down) down = Math.max(WL, Math.floor(wB));
        outLV[q] = down;
      }
      out[q] = Math.max(own, down);
    }
  }
}
function computeLevels() {
  // first every level from the bare ground, which settles the main rivers and their valleys;
  // then the brooks again over the ground with those valleys cut in (riverLV keeps the first
  // pass meanwhile: the main-river segments read it)
  carveLevels = false; segCache.clear(); levelPass(riverLV);
  outLV.fill(-1);
  carveLevels = true; levelPass(levels2); carveLevels = false;
  riverLV.set(levels2);
  segCache.clear();
}
const cellLevel = k => riverLV[k];
const isRiverCell = k => PL.elev[k] > 0 && PL.acc[k] >= BROOK_MIN && PL.area[k] >= BROOK_AREA && !(lakeY[k] && PL.recv[k] >= 0 && lakeY[PL.recv[k]]);
// a real river (not a headwater brook): these carve the big valleys, feed the forests and show on the map
const isMainRiver = k => isRiverCell(k) && PL.acc[k] >= RIVER_MIN && PL.area[k] >= RIVER_AREA;
function cellSegs(ci, cj) {
  const key = ci * 8192 + cj;
  let out = segCache.get(key);
  if (out) return out;
  out = [];
  if (cj >= 0 && cj < PH) {
    const k = pcell(ci, cj), r = PL.recv[k];
    if (r >= 0 && PL.elev[r] > 0 && isRiverCell(k)) { // links into the sea are drawn by buildDeltas
      let ri = r % PW, rj = (r - ri) / PW, di = ri - (((ci % PW) + PW) % PW);
      if (di > 1) di -= PW; else if (di < -1) di += PW;
      const A = riverPt(ci, cj), B = riverPt(ci + di, rj);
      // Catmull-Rom midpoint through the upstream and downstream river points rounds off
      // the corners, plus a little wobble
      let up = false, udi = 0, udj = 0, ua = 0;
      for (let dj = -1; dj <= 1; dj++) for (let dd = -1; dd <= 1; dd++) {
        const kk = pcell(ci + dd, cj + dj);
        if (PL.recv[kk] === k && PL.acc[kk] > ua && isRiverCell(kk)) { ua = PL.acc[kk]; up = true; udi = dd; udj = dj; }
      }
      const U = up ? riverPt(ci + udi, cj + udj) : [2 * A[0] - B[0], 2 * A[1] - B[1]];
      const r2 = PL.recv[r];
      let C;
      if (r2 >= 0 && PL.elev[r] > 0) {
        let r2i = r2 % PW, d2 = r2i - ri; if (d2 > 1) d2 -= PW; else if (d2 < -1) d2 += PW;
        C = riverPt(ci + di + d2, (r2 - r2i) / PW);
      } else C = [2 * B[0] - A[0], 2 * B[1] - A[1]];
      const ex = B[0] - A[0], ez = B[1] - A[1], len = Math.hypot(ex, ez) || 1;
      const off = (hash(ci, cj, 53) - 0.5) * 3;
      const M = [(-U[0] + 9 * A[0] + 9 * B[0] - C[0]) / 16 - ez / len * off, (-U[1] + 9 * A[1] + 9 * B[1] - C[1]) / 16 + ex / len * off];
      const brook = !isMainRiver(k), L = cellLevel(k), Lr = brook && outLV[k] >= 0 ? outLV[k] : cellLevel(r);
      const w = riverWidth(PL.acc[k]);
      // a big drop is a waterfall, small ones become a sloping run
      const fall = L - Lr >= FALL_STEP, Le = fall ? L : Lr;
      // fed from above by a stream that fell into this one: the start is a plunge pool
      let plunge = false, spring = true;
      for (let dj = -1; dj <= 1; dj++) for (let dd = -1; dd <= 1; dd++) {
        if (!dd && !dj) continue;
        const kk = pcell(ci + dd, cj + dj);
        if (PL.recv[kk] === k && isRiverCell(kk)) { spring = false; if (cellLevel(kk) - L >= FALL_STEP) plunge = true; }
      }
      // meanders: two more bend points pushed sideways by smooth noise, more for wider rivers
      // (brooks wander in tighter wiggles round the bumps of the hillside)
      const amp = brook ? 5 : 3 + Math.min(w, 8) * 1.1, wl = brook ? 13 : 23;
      const bend = (P0, P1) => {
        const mx = (P0[0] + P1[0]) / 2, mz = (P0[1] + P1[1]) / 2, dx = P1[0] - P0[0], dz = P1[1] - P0[1], l = Math.hypot(dx, dz) || 1;
        const o = nD(mx / wl, mz / wl) * amp;
        return [mx - dz / l * o, mz + dx / l * o];
      };
      const Q1 = bend(A, M), Q2 = bend(M, B), pts = [A, Q1, M, Q2, B];
      // The water steps down where the ground under the channel does, not only at the end of
      // the link: a stream that reaches the edge of a lower valley drops into it there instead
      // of running on at its old height across the valley floor, held up by banks (which left
      // walls and pillars standing in the valleys).
      const lv = [L, 0, 0, 0, Lr];
      // (a brook reads the ground with the rivers' valleys already cut in, like its level)
      let near = null;
      if (brook) {
        const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
        near = mainSegsNear(Math.min(...xs) - 5, Math.min(...zs) - 5, Math.max(...xs) + 5, Math.max(...zs) + 5);
      }
      const gr = (x, z) => near ? mainCarve(near, x, z, rawHeight(x, z)) : rawHeight(x, z);
      for (let n = 1; n < 4; n++) {
        const [x, z] = pts[n];
        let g = gr(x, z);
        for (const [dx, dz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) g = Math.min(g, gr(x + dx, z + dz));
        lv[n] = Math.max(Lr, Math.min(lv[n - 1], L + (Le - L) * n / 4, Math.floor(g) - 1));
      }
      for (let n = 0; n < 4; n++) {
        const [ax, az] = pts[n], [bx, bz] = pts[n + 1], l = Math.hypot(bx - ax, bz - az) || 1;
        const drop = lv[n] - lv[n + 1], f = drop >= FALL_STEP;
        out.push({ ax, az, bx, bz, L: lv[n], L2: f ? lv[n] : lv[n + 1], w, fx: (bx - ax) / l, fz: (bz - az) / l,
          lip: f, plunge: n === 0 ? plunge : lv[n - 1] - lv[n] >= FALL_STEP, spring: spring && n === 0, brook });
      }
    }
  }
  if (segCache.size > 20000) segCache.clear();
  segCache.set(key, out);
  return out;
}
// The main-river segments (no brooks) that can reach a box, for mainCarve.
function mainSegsNear(x0, z0, x1, z1) {
  const out = [], M = VALLEY_R + 16, mx = (x0 + x1) / 2;
  const hit = g => !(Math.max(g.ax, g.bx) < x0 - M || Math.min(g.ax, g.bx) > x1 + M || Math.max(g.az, g.bz) < z0 - M || Math.min(g.az, g.bz) > z1 + M);
  for (const g of deltaSegs) {
    if (g.brook) continue;
    const sh = Math.round((mx - g.ax) / PLANET_X) * PLANET_X, q = sh ? { ...g, ax: g.ax + sh, bx: g.bx + sh } : g;
    if (hit(q)) out.push(q);
  }
  const c0x = Math.floor((x0 - M) / PCELL) - 2, c1x = Math.floor((x1 + M) / PCELL) + 2;
  const c0z = Math.max(0, Math.floor((z0 - M) / PCELL) - 2), c1z = Math.min(PH - 1, Math.floor((z1 + M) / PCELL) + 2);
  for (let cj = c0z; cj <= c1z; cj++)
    for (let ci = c0x; ci <= c1x; ci++) {
      if (!isMainRiver(pcell(ci, cj))) continue;
      for (const g of cellSegs(ci, cj)) if (hit(g)) out.push(g);
    }
  return out;
}
// Ground height h at (x, z) after the main rivers' channels, banks and valley walls are cut
// into it: the same cuts heightAt makes, without the brooks.
function mainCarve(sg, x, z, h) {
  let bank = null, bankD = Infinity, bt = 0, near = -1, vw = 0, vl = 0, coreL = Infinity;
  for (const s of sg) {
    const ex = s.bx - s.ax, ez = s.bz - s.az;
    let t = ((x - s.ax) * ex + (z - s.az) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (s.ax + ex * t), z - (s.az + ez * t)), lv = s.L + (s.L2 - s.L) * t;
    if (d < s.w) { coreL = Math.min(coreL, Math.round(lv)); continue; }
    if (d - s.w < bankD) { bankD = d - s.w; bank = s; bt = t; }
    if (d < s.w + 2.5) near = Math.max(near, Math.round(lv));
    if (d - s.w < 30) { const k = Math.exp(-(d - s.w) / 5); vw += k; vl += k * lv; }
  }
  if (coreL < Infinity) return Math.min(h, coreL);
  if (!bank) return h;
  const bankL = Math.max(near, Math.round(bank.L + (bank.L2 - bank.L) * bt));
  if (bankD < bankW(bank.w) && h > bankL + 1) { let t = bankD / bankW(bank.w); t = t * t * (3 - 2 * t); h = bankL + 1 + t * (h - bankL - 1); }
  if (bankD < VALLEY_R) {
    const L = bankD < 2.5 || !vw ? bankL : vl / vw, fp = Math.max(0, bank.w - 2) * 2.2;
    const slope = (0.42 + 0.5 / (1 + bank.w * 0.6)) * (0.8 + 0.4 * (nC(x / 31, z / 31) * 0.5 + 0.5));
    const cap = L + 1 + Math.max(0, bankD - fp) * slope;
    let f = (VALLEY_R - bankD) / 18; f = f > 1 ? 1 : f * f * (3 - 2 * f);
    if (cap < h) h -= (h - cap) * 0.92 * f;
  }
  return h;
}
// Deltas: a big river reaching the sea splits a little upstream into distributaries that fan
// out across the flat sediment plain the planet laid down at its mouth.
let deltaSegs = [];
function buildDeltas() {
  deltaSegs = [];
  // every river's last cell before the sea: its channel is carried on from here by the arms
  // below (the planet's ocean cell can still be dry land at block scale), split into a delta
  // when the river is big enough
  for (let k = 0; k < PN; k++) {
    if (!isRiverCell(k) || PL.recv[k] < 0 || PL.elev[PL.recv[k]] > 0) continue;
    const i = k % PW, j = (k - i) / PW;
    // apex: the river point one cell upstream (the biggest tributary), else the mouth cell
    let up = k, ua = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const kk = pcell(i + di, j + dj);
      if (PL.recv[kk] === k && PL.acc[kk] > ua) { ua = PL.acc[kk]; up = kk; }
    }
    let ui = up % PW, uj = (up - ui) / PW, du = ui - i;
    if (du > 1) du -= PW; else if (du < -1) du += PW;
    const A = riverPt(i + du, uj), M = riverPt(i, j);
    let fx = M[0] - A[0], fz = M[1] - A[1];
    const r = PL.recv[k], ri = r % PW, rj = (r - ri) / PW;
    let dr = ri - i; if (dr > 1) dr -= PW; else if (dr < -1) dr += PW;
    const S = riverPt(i + dr, rj);
    fx += S[0] - M[0]; fz += S[1] - M[1];
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    // The river splits in two, each arm runs on a little and may split again, so the channels
    // branch like a tree instead of bursting from one pool. Each arm keeps its own bearing at
    // first, then increasingly follows the land down to the coast, and runs on until it is out
    // in open water (one step past the shore, so it breaks through the beach).
    const a = PL.acc[k], depth = a >= DELTA_MIN * 3 ? 2 : a >= DELTA_MIN ? 1 : 0, brook = !isMainRiver(k);
    const base = Math.atan2(fz, fx);
    const sea = (x, z) => baseHeight(x, z) < Math.max(WL, lakeAt(x, z)); // open sea or a lake
    const sl = 7;
    const arm = (x, z, hx, hz, bear, w, seed, lvl, steps) => {
      const splitAt = lvl > 0 ? (seed === 1 ? 1 : 2) + Math.floor(hash(k, seed, 66) * 2) : -1;
      for (let t = 0; t < steps; t++) {
        const cur = Math.atan2(hz, hx);
        let d = bear - cur; d = Math.atan2(Math.sin(d), Math.cos(d));
        let turn = d * 0.4;
        const gx = planetY(x + 8, z) - planetY(x - 8, z), gz = planetY(x, z + 8) - planetY(x, z - 8);
        if (gx * gx + gz * gz > 0.09) { // where the land clearly falls one way, lean down it
          let dd = Math.atan2(-gz, -gx) - cur; dd = Math.atan2(Math.sin(dd), Math.cos(dd));
          turn = turn * 0.6 + dd * 0.4 * 0.4;
        }
        turn = Math.max(-0.25, Math.min(0.25, turn + nD(x / 17 + seed, z / 17) * 0.15));
        let rel = cur + turn - base; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        const ang = base + Math.max(-1.3, Math.min(1.3, rel)); // never loop back upstream
        hx = Math.cos(ang); hz = Math.sin(ang);
        const qx = x + hx * sl, qz = z + hz * sl;
        deltaSegs.push({ ax: x, az: z, bx: qx, bz: qz, L: WL, L2: WL, w, fx: hx, fz: hz, lip: false, plunge: false, spring: false, brook });
        x = qx; z = qz;
        if (sea(x, z)) {
          // one more step so the channel cuts through the shore into the open water
          deltaSegs.push({ ax: x, az: z, bx: x + hx * sl, bz: z + hz * sl, L: WL, L2: WL, w, fx: hx, fz: hz, lip: false, plunge: false, spring: false, brook });
          return;
        }
        if (t === splitAt) {
          const sp = 0.32 + hash(k, seed, 67) * 0.2, cw = Math.max(1.3, w * 0.75);
          arm(x, z, hx, hz, ang - sp, cw, seed * 2 + 1, lvl - 1, steps - t - 1);
          arm(x, z, hx, hz, ang + sp, cw, seed * 2 + 2, lvl - 1, steps - t - 1);
          return;
        }
      }
    };
    arm(M[0], M[1], fx, fz, base, riverWidth(a), 1, depth, 14);
  }
}
// Gather the river segments that can touch a region (world block bounds, inclusive).
function prepareRivers(x0, z0, x1, z1) {
  segs = [];
  // (channels are gathered out to VALLEY_R past their edge, the widest river included, so every
  // chunk sees the same valleys)
  const M = VALLEY_R + 16, mx = (x0 + x1) / 2;
  for (const g of deltaSegs) {
    const sh = Math.round((mx - g.ax) / PLANET_X) * PLANET_X, m = g.brook ? BROOK_R + 8 : M;
    if (Math.max(g.ax, g.bx) + sh < x0 - m || Math.min(g.ax, g.bx) + sh > x1 + m || Math.max(g.az, g.bz) < z0 - m || Math.min(g.az, g.bz) > z1 + m) continue;
    segs.push(sh ? { ...g, ax: g.ax + sh, bx: g.bx + sh } : g);
  }
  const c0x = Math.floor((x0 - M) / PCELL) - 2, c1x = Math.floor((x1 + M) / PCELL) + 2;
  const c0z = Math.floor((z0 - M) / PCELL) - 2, c1z = Math.floor((z1 + M) / PCELL) + 2;
  for (let cj = c0z; cj <= c1z; cj++)
    for (let ci = c0x; ci <= c1x; ci++)
      for (const g of cellSegs(ci, cj)) {
        const m = g.brook ? BROOK_R + 8 : M; // a brook reaches no further than its notch
        if (Math.max(g.ax, g.bx) < x0 - m || Math.min(g.ax, g.bx) > x1 + m || Math.max(g.az, g.bz) < z0 - m || Math.min(g.az, g.bz) > z1 + m) continue;
        segs.push(g);
      }
}
// The river cell a column belongs to: inside a channel the lowest level wins (so tributaries
// spill into the main stream); otherwise the nearest bank.
const RA = { core: false, L: 0, d: 0, w: 0, t: 0, s: null };
const VAL = { s: null, d: Infinity, L: 0 }; // nearest channel outside the water, for valley carving
const BRK = { s: null, d: Infinity, L: 0, near: -1, nd: Infinity }; // nearest brook, for its notch
function riverAt(x, z) {
  let core = null, coreL = Infinity, bank = null, bankD = Infinity, ct = 0, cd = 0, bt = 0, near = -1;
  let bz = null, bzN = Infinity, bzD = 0, bzT = 0; // the channel whose bank zone this column is deepest inside
  let vw = 0, vl = 0; // valley floor level: nearby channels' levels blended by distance
  let bb = null, bbD = Infinity, bbT = 0; // nearest brook, which cuts its own small notch
  for (const s of segs) {
    const ex = s.bx - s.ax, ez = s.bz - s.az;
    let t = ((x - s.ax) * ex + (z - s.az) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x - (s.ax + ex * t), qz = z - (s.az + ez * t);
    const d = Math.sqrt(qx * qx + qz * qz);
    if (d < s.w) { const lv = Math.round(s.L + (s.L2 - s.L) * t); if (lv < coreL || (lv === coreL && d < cd)) { core = s; coreL = lv; ct = t; cd = d; } }
    else {
      const nb = (d - s.w) / bankW(s.w);
      if (nb < bzN) { bzN = nb; bz = s; bzD = d - s.w; bzT = t; }
      // the highest water right next to this column, so a bank between two channels holds both
      // (a brook steps down a block every few columns, and the water from each step spreads a
      // thin sheet over the reach below it: its banks hold the top of the whole stretch)
      if (d < s.w + 2.5) near = Math.max(near, s.brook ? Math.max(s.L, s.L2) : Math.round(s.L + (s.L2 - s.L) * t));
      // (brooks stay out of the big valleys: they cut their own notch below)
      if (s.brook) { if (d - s.w < bbD) { bbD = d - s.w; bb = s; bbT = t; } continue; }
      if (d - s.w < bankD) { bankD = d - s.w; bank = s; bt = t; }
      if (d - s.w < 30) { const k = Math.exp(-(d - s.w) / 5); vw += k; vl += k * (s.L + (s.L2 - s.L) * t); }
    }
  }
  const bankL = bank ? Math.max(near, Math.round(bank.L + (bank.L2 - bank.L) * bt)) : 0;
  // (blending keeps the floodplain from stepping along straight lines where a river's level
  // changes from one stretch to the next; right beside the water the bank's own level holds)
  VAL.s = bank; VAL.d = bankD; VAL.L = bankD < 2.5 || !vw ? bankL : vl / vw;
  BRK.near = near; BRK.nd = bankD < bbD ? bankD : bbD;
  BRK.s = bb; BRK.d = bbD; BRK.L = bb ? Math.max(near, bb.L + (bb.L2 - bb.L) * bbT) : 0;
  if (core) { RA.core = true; RA.s = core; RA.L = coreL; RA.d = cd; RA.w = core.w; RA.t = ct; return RA; }
  // (judged per channel, so a narrow stream's thin bank never punches a hole in a big river's)
  if (bz && bzN < 1) { RA.core = false; RA.s = bz; RA.L = Math.max(near, Math.round(bz.L + (bz.L2 - bz.L) * bzT)); RA.d = bzD; RA.w = bz.w; RA.t = bzT; return RA; }
  return null;
}
function heightAt(x, z) {
  let h = baseHeight(x, z);
  EROSION_AT = EROSION;
  const r = riverAt(x, z);
  if (r) {
    const L = r.L;
    if (r.core) {
      let depth = 1 + Math.round((1 - r.d / r.w) * (0.8 + Math.min(r.w, 10) * 0.45)); // bigger rivers run deeper
      if (r.s.lip && r.t > 0.65) depth = 0;          // shallow rock lip at the top of a fall
      if (r.s.plunge && r.t < 0.45) depth += 2;      // plunge pool at the bottom
      if (r.s.spring) depth += 1;
      // once a sea-level channel is out over the sea floor it stops cutting: no trench in the shallows
      if (!(L <= WL && h < WL)) h = Math.min(h, L - 1 - depth);
    } else {
      // banks are cut down to the water or built up into levees, then blend into the land
      // (never below one block above the water: a one-block step sends a thin sheet of flowing
      // water along the surface, and a bank level with the water would let it out)
      // Only the two blocks next to the water are built up as a levee where the land is lower;
      // further out the bank is only ever cut down, so where two channels at different heights
      // run close together the higher one's bank doesn't leave blocks standing in the lower valley.
      let t = r.d / bankW(r.w); t = t * t * (3 - 2 * t);
      // (a sea-level channel meeting open water gets no bank there, so it opens into the sea)
      if (!(L <= WL && h < WL)) h = h > L + 1 ? L + 1 + t * (h - L - 1) : r.d < 2 ? L + 1 : h;
    }
  }
  // Valleys: the ground can only rise so steeply away from a river, so every stream sits in a
  // carved valley. Small high streams cut steep V-shaped notches; big rivers get a flat
  // floodplain first and gentler walls.
  // The walls fade out by VALLEY_R from the channel's edge, so a column far from every river
  // never depends on which channels a chunk happened to gather (that left cliffs on chunk edges).
  if (VAL.s && (!r || !r.core) && VAL.d < VALLEY_R) {
    const v = VAL.s, fp = Math.max(0, v.w - 2) * 2.2;
    const slope = (0.42 + 0.5 / (1 + v.w * 0.6)) * (0.8 + 0.4 * (nC(x / 31, z / 31) * 0.5 + 0.5));
    const cap = VAL.L + 1 + Math.max(0, VAL.d - fp) * slope;
    let f = (VALLEY_R - VAL.d) / 18; f = f > 1 ? 1 : f * f * (3 - 2 * f);
    if (cap < h) h -= (h - cap) * 0.92 * f;
  }
  // a brook sits in a small V-shaped notch of its own, a few blocks across, that fades into
  // the hillside by BROOK_R
  if (BRK.s && (!r || !r.core) && BRK.d < BROOK_R) {
    const cap = BRK.L + 1 + BRK.d * (0.7 + 0.3 * (nC(x / 19, z / 19) * 0.5 + 0.5));
    let f = (BROOK_R - BRK.d) / 8; f = f > 1 ? 1 : f * f * (3 - 2 * f);
    if (cap < h) h -= (h - cap) * 0.85 * f;
  }
  // whatever cut the land down, the ground right beside running water stays a block above it
  if ((!r || !r.core) && BRK.near >= 0 && BRK.nd < 2 && !(BRK.near <= WL && h < WL) && h < BRK.near + 1) h = BRK.near + 1;
  // a lake's shore: ground just outside the lake rises to its water level, so a lake whose
  // edge falls on lower land doesn't pour out over it
  if ((!r || !r.core) && !lakeAt(x, z)) {
    const rim = Math.max(lakeAt(x + 2, z), lakeAt(x - 2, z), lakeAt(x, z + 2), lakeAt(x, z - 2));
    if (rim > h) h = rim;
  }
  // inland, dry ground stays above sea level (no stray sea-level puddles on the plains)
  if (h < WL + 1 && (!r || !r.core) && !lakeAt(x, z) && planetY(x, z) >= WL + 1.5) h = WL + 1;
  // the very top is squeezed so peaks still leave headroom for trees
  if (h > PEAK) h = PEAK + (h - PEAK) * 0.55;
  return Math.max(4, Math.min(CH - 22, Math.floor(h)));
}
// lake surface from the four planet cells around a column (0 = none)
function lakeAt(x, z) {
  const u = x / PCELL - 0.5, v = z / PCELL - 0.5, i = Math.floor(u), j = Math.floor(v);
  return Math.max(lakeY[pcell(i, j)], lakeY[pcell(i + 1, j)], lakeY[pcell(i, j + 1)], lakeY[pcell(i + 1, j + 1)]);
}
function waterTop(x, z) { const r = riverAt(x, z); return r && r.core ? r.L : Math.max(WL, lakeAt(x, z)); }
// biome with ragged borders; local temperature also falls with height above the cell's mean
function biomeAt(x, z) { return PL.biome[cellAt(x + nD(x / 40, z / 40) * 14, z + nE(x / 40, z / 40) * 14)]; }
function tempAt(x, z, y) { const k = cellAt(x, z); return PL.temp[k] - (y - cellY[k]) * 0.25 + nL(x / 23, z / 23) * 1.5; }
function inRiver(x, z) { const r = riverAt(x, z); return !!r && (r.core || r.d < 1.5); }

// ---------- features (trees, bushes, boulders, fallen logs) ----------
function feature(cx, cz) {
  const r = hash(cx, cz, 1);
  const x = cx * CELL + 1 + Math.floor(hash(cx, cz, 2) * (CELL - 2));
  const z = cz * CELL + 1 + Math.floor(hash(cx, cz, 3) * (CELL - 2));
  const h = heightAt(x, z);
  if (h <= WL + 1 || inRiver(x, z)) return null;
  // nothing takes root on bare rock walls of gullies and cliffs
  if (Math.max(h - heightAt(x + 1, z), h - heightAt(x - 1, z), h - heightAt(x, z + 1), h - heightAt(x, z - 1)) >= 3) return null;
  // forests thicken with rain and crowd along rivers and lakes; they thin toward the tree line
  const wet = fieldAt(rainN, x, z) * 0.7 + fieldAt(wetF, x, z) * 0.55;
  const dens = (0.35 + 0.4 * nD(x / 130, z / 130) + 0.3 * wet) * Math.min(1, (tempAt(x, z, h) + 4) / 5);
  const k = hash(cx, cz, 4), k2 = hash(cx, cz, 7);
  const bio = biomeAt(x, z), t = tempAt(x, z, h);
  if (t < -4 || bio === BIOME.ICE) return r > 0.985 ? { type: 'boulder', x, z, h, k, k2 } : null; // above the tree line
  const grove = nE(x / 170, z / 170);
  let type = null, treeP;
  switch (bio) {
    case BIOME.AUTUMN:
      treeP = dens * 0.62;
      if (grove < -0.28) type = k < 0.82 ? 'birch' : 'maple';
      else if (grove > 0.33) type = k < 0.5 ? 'spruce' : k < 0.72 ? 'larch' : 'maple';
      else type = k < 0.45 ? 'maple' : k < 0.85 ? 'oak' : k < 0.93 ? 'birch' : 'spruce';
      break;
    case BIOME.TAIGA: treeP = dens * 0.55; type = k < 0.6 ? 'spruce' : k < 0.9 ? 'larch' : 'birch'; break;
    case BIOME.TUNDRA: treeP = 0.04; type = k < 0.7 ? 'spruce' : 'larch'; break;
    case BIOME.GRASS: treeP = dens * 0.06; type = k < 0.5 ? 'oak' : 'birch'; break;
    case BIOME.WARM: treeP = dens * 0.7; type = k < 0.75 ? 'green' : k < 0.9 ? 'oak' : 'maple'; break;
    default: treeP = 0; // desert
  }
  if (r < treeP) return { type, x, z, h, k, k2, big: hash(cx, cz, 9) < 0.07 && type !== 'birch' && type !== 'larch' };
  if (r > 0.975) return { type: 'boulder', x, z, h, k, k2 };
  const bushP = bio === BIOME.GRASS ? 0.12 : bio === BIOME.DESERT ? 0.015 : bio === BIOME.TUNDRA ? 0.06 : 0.04;
  if (r > 0.975 - bushP) return { type: 'bush', x, z, h, k, k2 };
  if (r > 0.925 && bio !== BIOME.DESERT) return { type: 'fallen', x, z, h, k, k2 };
  return null;
}

// leaf clump: an ellipsoid of leaves, mostly `a` with a share `p` of `b` mixed in, thinned to `dens`
function blob(set, cx, cy, cz, rx, ry, rz, a, b = a, p = 0, dens = 1) {
  const ix = Math.ceil(rx), iy = Math.ceil(ry), iz = Math.ceil(rz);
  for (let dy = -iy; dy <= iy; dy++)
    for (let dz = -iz; dz <= iz; dz++)
      for (let dx = -ix; dx <= ix; dx++) {
        const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
        if (d > 1) continue;
        const hv = hash3(cx + dx, cy + dy, cz + dz);
        if (d > 0.5 && hv < (d - 0.5) * 1.3) continue;
        if (dens < 1 && hash3(cz + dz, cy + dy, cx + dx) > dens) continue;
        set(cx + dx, cy + dy, cz + dz, hv > 1 - p ? b : a, true);
      }
}
// layered conifer: a skirt every three blocks, widest at the bottom, tips drooping one block
function conifer(set, x, z, base, top, maxR, leaf, sparse) {
  for (let y = base; y <= top; y++) {
    const t = (top - y) / Math.max(1, top - base), ph = (top - y) % 3;
    const rad = 0.7 + t * maxR * (ph === 0 ? 1 : ph === 1 ? 0.72 : 0.48);
    const ir = Math.ceil(rad);
    for (let dz = -ir; dz <= ir; dz++)
      for (let dx = -ir; dx <= ir; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > rad) continue;
        if (d > rad - 1 && hash3(x + dx, y, z + dz) < (sparse ? 0.45 : 0.22)) continue;
        if (sparse && hash3(z + dz, y, x + dx) < 0.18) continue;
        const droop = ph === 0 && d > rad - 1.2 && d > 1.5;
        set(x + dx, y - (droop ? 1 : 0), z + dz, leaf, true);
      }
  }
  set(x, top + 1, z, leaf, true); set(x, top + 2, z, leaf, true);
}
function trunkHeight(f) {
  const g = f.big ? 4 : 0;
  switch (f.type) {
    case 'maple': return 6 + Math.floor(f.k * 4) + g;
    case 'oak': return 4 + Math.floor(f.k * 3) + g;
    case 'green': return 6 + Math.floor(f.k * 4);
    case 'birch': return 8 + Math.floor(f.k * 5);
    case 'spruce': return 9 + Math.floor(f.k * 6) + g + 2;
    case 'larch': return 9 + Math.floor(f.k * 4);
  }
  return 0;
}
// The skeleton of a tree: trunk and branch logs plus the leaf clumps at the branch tips.
// Built once per feature so leaves, logs and the bare winter look all agree.
function treeShape(f) {
  if (f.shape) return f.shape;
  const logs = [], clumps = [], th = trunkHeight(f), top = f.h + th;
  const R = i => hash(f.x, f.z, 30 + i);
  const s = f.big ? 1.25 : 1;
  const branch = (x0, y0, z0, x1, y1, z1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      logs.push([Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t)]);
    }
  };
  let trunkTop = top;
  let tx = f.x, tz = f.z;
  switch (f.type) {
    case 'maple': {
      // a vase: the trunk forks into rising leaders, each crowned by a clump
      const a = f.k2 < 0.5 ? LEAF_RED : f.k2 < 0.85 ? LEAF_ORANGE : LEAF_YELLOW;
      const b = a === LEAF_RED ? LEAF_ORANGE : a === LEAF_ORANGE ? (f.k < 0.5 ? LEAF_RED : LEAF_YELLOW) : LEAF_ORANGE;
      const fork = f.h + Math.floor(th * 0.55);
      trunkTop = fork;
      const nb = 2 + Math.floor(R(0) * 2), a0 = R(1) * 6.283;
      for (let i = 0; i < nb; i++) {
        const an = a0 + i * 6.283 / nb + (R(2 + i) - 0.5) * 0.8, hl = (2 + R(5 + i) * 1.6) * s;
        const ex = Math.round(f.x + Math.cos(an) * hl), ez = Math.round(f.z + Math.sin(an) * hl), ey = top + Math.floor(R(8 + i) * 2);
        branch(f.x, fork, f.z, ex, ey, ez);
        clumps.push([ex, ey + 1, ez, (2.3 + R(11 + i) * 0.6) * s, 2.0 * s, (2.3 + R(14 + i) * 0.6) * s, a, b, 0.22]);
      }
      clumps.push([f.x, top + 1, f.z, 3.0 * s, 2.4 * s, 3.0 * s, a, b, 0.22]);
      break;
    }
    case 'oak': case 'green': {
      // a broad dome on wide, nearly level limbs
      const oak = f.type === 'oak';
      const a = oak ? (f.k2 < 0.55 ? LEAF_BROWN : f.k2 < 0.9 ? LEAF_ORANGE : LEAF_GREEN) : (f.k2 < 0.85 ? LEAF_GREEN : LEAF_YELLOW);
      const b = oak ? (a === LEAF_BROWN ? LEAF_ORANGE : LEAF_BROWN) : LEAF_GREEN;
      const nb = 4 + Math.floor(R(0) * 2), a0 = R(1) * 6.283;
      for (let i = 0; i < nb; i++) {
        const an = a0 + i * 6.283 / nb + (R(2 + i) - 0.5) * 0.7, hl = (3 + R(7 + i) * 2) * s;
        const y0 = top - Math.floor(R(12 + i) * 3), ex = Math.round(f.x + Math.cos(an) * hl), ez = Math.round(f.z + Math.sin(an) * hl);
        const ey = y0 + 1 + Math.floor(R(17 + i) * 2);
        branch(f.x, y0, f.z, ex, ey, ez);
        clumps.push([ex, ey + 1, ez, (2.4 + R(22 + i) * 0.7) * s, 1.8 * s, (2.4 + R(27 + i) * 0.7) * s, a, b, 0.2]);
      }
      clumps.push([f.x, top + 2, f.z, 3.4 * s, 2.3 * s, 3.4 * s, a, b, 0.2]);
      if (f.big || f.k > 0.6) // root flare
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
          if (R(40 + dx * 2 + dz) < 0.65 && heightAt(f.x + dx, f.z + dz) === f.h) logs.push([f.x + dx, f.h + 1, f.z + dz]);
      break;
    }
    case 'birch': {
      // slender, sometimes leaning, with small clumps hung off short twigs
      const lean = R(0) < 0.45, ld = Math.floor(R(1) * 4), lx = [1, -1, 0, 0][ld], lz = [0, 0, 1, -1][ld];
      const kink = f.h + Math.floor(th * 0.6);
      for (let y = f.h + 1; y <= top + 1; y++) logs.push([y > kink && lean ? f.x + lx : f.x, y, y > kink && lean ? f.z + lz : f.z]);
      trunkTop = -1;
      tx = lean ? f.x + lx : f.x; tz = lean ? f.z + lz : f.z;
      const n = 3 + Math.floor(R(2) * 2);
      for (let i = 0; i < n; i++) {
        const y = top - 4 + Math.floor((i * 5) / n), an = R(3) * 6.283 + i * 2.4;
        const cx = Math.round(tx + Math.cos(an) * 1.6), cz = Math.round(tz + Math.sin(an) * 1.6);
        const bx = tx + Math.sign(cx - tx), bz = tz + Math.sign(cz - tz);
        if (bx !== tx || bz !== tz) logs.push([bx, y, bz]);
        clumps.push([cx, y, cz, 1.7 + R(5 + i) * 0.5, 1.6, 1.7 + R(9 + i) * 0.5, LEAF_YELLOW, LEAF_ORANGE, 0.08]);
      }
      clumps.push([tx, top + 1, tz, 1.7, 2.3, 1.7, LEAF_YELLOW, LEAF_ORANGE, 0.08]);
      break;
    }
    case 'spruce': case 'larch': trunkTop = top; break;
  }
  if (trunkTop > 0) for (let y = f.h + 1; y <= trunkTop; y++) logs.push([f.x, y, f.z]);
  if (f.type === 'maple' || f.type === 'oak') {
    // big trees get a thicker foot
    if (f.big) for (let y = f.h + 1; y <= f.h + 3; y++) logs.push([f.x + 1, y, f.z], [f.x, y, f.z + 1], [f.x + 1, y, f.z + 1]);
  }
  return (f.shape = { logs, clumps, top });
}
const DECIDUOUS = { maple: 1, oak: 1, birch: 1, larch: 1, bush: 1 };
function placeLeaves(f, set) {
  if (f.type === 'boulder' || f.type === 'fallen') return;
  const bare = BARE && DECIDUOUS[f.type];
  if (f.type === 'bush') {
    if (!bare) blob(set, f.x, f.h + 1, f.z, 1.7, 1.3, 1.7, f.k2 < 0.5 ? LEAF_RED : LEAF_BROWN, LEAF_ORANGE, 0.2);
    return;
  }
  if (f.type === 'spruce' || f.type === 'larch') {
    const th = trunkHeight(f), top = f.h + th, s = f.big ? 1.3 : 1;
    if (bare) { conifer(set, f.x, f.z, f.h + 3, top, 2.6, TWIG, true); return; }
    if (f.type === 'spruce') conifer(set, f.x, f.z, f.h + 3 + Math.floor(f.k2 * 2), top, 3.4 * s, LEAF_GREEN, false);
    else conifer(set, f.x, f.z, f.h + 3, top, 2.9, LEAF_YELLOW, true);
    return;
  }
  const sh = treeShape(f);
  // in winter oaks keep a few dry brown leaves; the rest show a thin web of twigs
  for (const c of sh.clumps)
    if (bare) blob(set, c[0], c[1], c[2], c[3] * 0.85, c[4] * 0.85, c[5] * 0.85, f.type === 'oak' ? LEAF_BROWN : TWIG, TWIG, f.type === 'oak' ? 0.5 : 0, 0.24);
    else blob(set, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]);
}
function placeSolid(f, set, get) {
  const th = trunkHeight(f);
  if (th > 0) {
    const log = f.type === 'birch' ? BIRCH_LOG : (f.type === 'spruce' || f.type === 'larch') ? SPRUCE_LOG : OAK_LOG;
    if (f.type === 'spruce' || f.type === 'larch') {
      // the trunk stops short of the tip so the narrow top stays needles, not a bare post
      for (let y = f.h + 1; y <= f.h + th - 2; y++) set(f.x, y, f.z, log, false);
    } else {
      for (const [x, y, z] of treeShape(f).logs) set(x, y, z, log, false);
    }
    // a skirt of fallen leaves around every broadleaf trunk
    if (f.type !== 'spruce') {
      const rr = f.type === 'oak' || f.type === 'maple' ? 4 : 3;
      for (let dz = -rr; dz <= rr; dz++)
        for (let dx = -rr; dx <= rr; dx++) {
          if (dx * dx + dz * dz > rr * rr + 1 || hash(f.x + dx, f.z + dz, 11) > 0.6) continue;
          const gy = heightAt(f.x + dx, f.z + dz);
          if (get(f.x + dx, gy, f.z + dz) === GRASS) set(f.x + dx, gy, f.z + dz, LITTER, false);
        }
    }
  } else if (f.type === 'boulder') {
    const rr = 1.3 + f.k * 1.1, ir = Math.ceil(rr);
    for (let dy = -1; dy <= ir; dy++)
      for (let dz = -ir; dz <= ir; dz++)
        for (let dx = -ir; dx <= ir; dx++)
          if (dx * dx + dy * dy * 1.4 + dz * dz <= rr * rr) set(f.x + dx, f.h + dy, f.z + dz, MOSSY, false);
  } else if (f.type === 'fallen') {
    const len = 3 + Math.floor(f.k * 4), alongX = f.k2 < 0.5;
    const log = f.k < 0.3 ? BIRCH_LOG : OAK_LOG;
    for (let i = 0; i < len; i++) {
      const x = f.x + (alongX ? i : 0), z = f.z + (alongX ? 0 : i);
      if (heightAt(x, z) === f.h) set(x, f.h + 1, z, log, true);
    }
  }
}

// ---------- generation ----------
// Thin walls: where rivers step down in falls, the banks of the upper channel can be left
// standing as one- or two-block-wide stone fins between lower pools. A fin that holds back no
// water (no water within a block of it stands as high as its top) is cut down to the ground on
// either side. Heights come from a ring of 3 extra columns so every chunk agrees on the result.
const FE = 3, EPW = P + 2 * FE, finH = new Int16Array(EPW * EPW), finW = new Int16Array(EPW * EPW), finCore = new Uint8Array(EPW * EPW);
function removeFins(ox, oz) {
  for (let z = 0; z < EPW; z++)
    for (let x = 0; x < EPW; x++) {
      const i = z * EPW + x, ix = x - FE, iz = z - FE, wx = ox + ix, wz = oz + iz;
      finH[i] = ix >= 0 && iz >= 0 && ix < P && iz < P ? colH[iz * P + ix] : heightAt(wx, wz);
      const r = riverAt(wx, wz);
      finCore[i] = r && r.core ? 1 : 0;
      finW[i] = r && r.core ? r.L : Math.max(WL, lakeAt(wx, wz));
    }
  const wetAround = (x, z) => {
    let m = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const j = (z + dz) * EPW + x + dx;
      if (finW[j] > finH[j] || finCore[j]) m = Math.max(m, finW[j]);
    }
    return m;
  };
  for (let z = FE; z < FE + P; z++)
    for (let x = FE; x < FE + P; x++) {
      const i = z * EPW + x, h = finH[i];
      if (finCore[i]) continue;
      let target = h;
      // along x then z: this column alone, or with its neighbour on either side, sticks up 3+
      for (const [sx, sz] of [[1, 0], [0, 1]]) {
        const at = k => finH[(z + sz * k) * EPW + x + sx * k];
        const fin = (a, b) => { // columns a..b (offsets) form the fin
          const lo = Math.max(at(a - 1), at(b + 1));
          for (let k = a; k <= b; k++) if (at(k) - lo < 3 || finCore[(z + sz * k) * EPW + x + sx * k]) return -1;
          let w = 0;
          for (let k = a; k <= b; k++) w = Math.max(w, wetAround(x + sx * k, z + sz * k));
          return Math.max(lo, w + 1);
        };
        for (const [a, b] of [[0, 0], [0, 1], [-1, 0]]) {
          const t = fin(a, b);
          if (t >= 0 && t < target) target = t;
        }
      }
      if (target < h) colH[(z - FE) * P + x - FE] = target;
    }
}
const colH = new Int16Array(P * P), colE = new Float32Array(P * P), colW = new Int16Array(P * P), colT = new Float32Array(P * P);
// beaches only within a few blocks of open sea, not across low river plains and deltas
const nearSea = (x, z) => Math.min(planetY(x + 9, z), planetY(x - 9, z), planetY(x, z + 9), planetY(x, z - 9)) < WL - 0.3;
function genPadded(cx, cz) {
  const ox = cx * CS - 1, oz = cz * CS - 1;
  prepareRivers(ox - FR - 4, oz - FR - 4, ox + P + FR + 4, oz + P + FR + 4);
  const vol = new Uint8Array(P * P * CH);
  for (let z = 0; z < P; z++)
    for (let x = 0; x < P; x++) { colH[z * P + x] = heightAt(ox + x, oz + z); colE[z * P + x] = EROSION_AT; }
  removeFins(ox, oz);
  for (let z = 0; z < P; z++)
    for (let x = 0; x < P; x++) {
      const wx = ox + x, wz = oz + z, h = colH[z * P + x], rv = riverAt(wx, wz);
      const wt = rv && rv.core ? rv.L : Math.max(WL, lakeAt(wx, wz));
      const bio = biomeAt(wx, wz), cold = tempAt(wx, wz, Math.max(h, wt));
      colW[z * P + x] = wt; colT[z * P + x] = cold;
      const hx0 = colH[z * P + Math.max(0, x - 1)], hx1 = colH[z * P + Math.min(P - 1, x + 1)];
      const hz0 = colH[Math.max(0, z - 1) * P + x], hz1 = colH[Math.min(P - 1, z + 1) * P + x];
      const drop = Math.max(h - hx0, h - hx1, h - hz0, h - hz1), ero = colE[z * P + x];
      let top, soil = 3;
      if (h < wt && wt > WL) top = hash(wx, wz, 5) < 0.3 ? MOSSY : DIRT; // river bed
      else if (h < wt) top = h < wt - 2 && hash(wx, wz, 5) < 0.5 ? DIRT : SAND;
      else if (h <= WL + 1 && nearSea(wx, wz)) top = cold < -2 ? SNOW : bio === BIOME.TUNDRA && hash(wx, wz, 5) < 0.5 ? DIRT : SAND;
      else if (h <= WL + 1 && cold >= -2) top = hash(wx, wz, 5) < 0.35 ? MOSSY : GRASS; // low wet ground: marsh
      else if (cold < -8 && drop <= 1 && !(rv && rv.d < 3)) { top = ICE; soil = 2; } // glacier ice in the high cold troughs
      else if (cold < -2) { top = SNOW; if (drop >= 3) soil = 0; } // snow lies on every ledge above the snow line
      else if (drop >= 3 || (drop >= 2 && ero > 0.6)) { top = STONE; soil = 0; } // bare rock on steep ridges and gully walls
      else if (bio === BIOME.DESERT) { top = SAND; soil = 4; }
      else if (ero < -2.2 && drop <= 1) top = hash(wx, wz, 7) < 0.35 ? MOSSY : DIRT; // washed-out sediment in gully floors
      else if (drop >= 2) { top = hash(wx, wz, 8) < 0.5 ? STONE : DIRT; soil = 1; }
      else if (bio === BIOME.TUNDRA) top = hash(wx, wz, 6) < 0.3 ? MOSSY : hash(wx, wz, 9) < 0.15 ? STONE : GRASS;
      else if (bio === BIOME.AUTUMN) top = nL(wx / 14, wz / 14) + hash(wx, wz, 6) * 0.35 > 0.5 ? LITTER : GRASS;
      else if (bio === BIOME.TAIGA) top = hash(wx, wz, 6) < 0.25 ? MOSSY : nL(wx / 14, wz / 14) > 0.55 ? LITTER : GRASS;
      else if (bio === BIOME.GRASS) top = hash(wx, wz, 6) < 0.08 ? DIRT : GRASS;
      else top = hash(wx, wz, 6) < 0.15 ? MOSSY : GRASS;
      const under = bio === BIOME.DESERT ? SAND : DIRT;
      const sub = top === ICE ? ICE : under;
      for (let y = 0; y <= h; y++) vol[(y * P + z) * P + x] = y < h - soil ? STONE : y < h ? sub : top;
      for (let y = h + 1; y <= wt; y++) vol[(y * P + z) * P + x] = WATER;
      if (wt > h && cold < -3) vol[(wt * P + z) * P + x] = ICE; // frozen seas and lakes
    }
  const set = (wx, y, wz, b, onlyAir) => {
    const x = wx - ox, z = wz - oz;
    if (x < 0 || z < 0 || x >= P || z >= P || y < 0 || y >= CH) return;
    const i = (y * P + z) * P + x;
    if (onlyAir && vol[i] !== AIR) return;
    vol[i] = b;
  };
  const get = (wx, y, wz) => {
    const x = wx - ox, z = wz - oz;
    if (x < 0 || z < 0 || x >= P || z >= P || y < 0 || y >= CH) return -1;
    return vol[(y * P + z) * P + x];
  };
  const feats = [];
  const c0x = Math.floor((ox - FR) / CELL), c1x = Math.floor((ox + P + FR) / CELL);
  const c0z = Math.floor((oz - FR) / CELL), c1z = Math.floor((oz + P + FR) / CELL);
  for (let z = c0z; z <= c1z; z++)
    for (let x = c0x; x <= c1x; x++) { const f = feature(x, z); if (f) feats.push(f); }
  for (const f of feats) placeLeaves(f, set);
  for (const f of feats) placeSolid(f, set, get);
  placePlants(vol, ox, oz);
  return vol;
}

// Reeds and cattails crowd the dry edge of rivers, lakes and marshes; grass tufts dot
// meadows and forest floors. Both stand on the ground block and are meshed as crossed quads.
function placePlants(vol, ox, oz) {
  for (let z = 1; z < P - 1; z++)
    for (let x = 1; x < P - 1; x++) {
      const i = z * P + x, h = colH[i], wt = colW[i];
      if (h < wt || h + 2 >= CH || colT[i] < -2) continue;
      const top = vol[(h * P + z) * P + x];
      if (top !== GRASS && top !== MOSSY && top !== LITTER && top !== SAND) continue;
      if (vol[((h + 1) * P + z) * P + x] !== AIR || vol[((h + 2) * P + z) * P + x] !== AIR) continue;
      const wx = ox + x, wz = oz + z;
      // open water within two blocks, its surface no more than two below this ground
      let wet = false;
      for (let dz = -2; dz <= 2 && !wet; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= P || zz >= P) continue;
          const j = zz * P + xx;
          if (colW[j] > colH[j] && colW[j] >= h - 2) { wet = true; break; }
        }
      const marsh = h <= WL + 1 && top !== SAND;
      const clump = nL(wx / 9, wz / 9) * 0.6 + hash(wx, wz, 21);
      if ((wet && clump > 0.62) || (marsh && clump > 0.9)) {
        if (top === SAND && hash(wx, wz, 22) < 0.5) continue;
        vol[((h + 1) * P + z) * P + x] = REED;
        continue;
      }
      if (top === SAND) continue;
      const bio = biomeAt(wx, wz);
      const tp = bio === BIOME.GRASS ? 0.22 : bio === BIOME.DESERT ? 0.01 : bio === BIOME.TUNDRA ? 0.08 : top === LITTER ? 0.015 : 0.06;
      if (hash(wx, wz, 23) < tp * (0.5 + nD(wx / 40, wz / 40))) vol[((h + 1) * P + z) * P + x] = TUFT;
    }
}

// ---------- greedy mesher ----------
const SOL = new Uint8Array(256);
for (let i = 1; i < 256; i++) SOL[i] = isWater(i) || isPlant(i) ? 0 : 1;
const isCanopy = b => (b >= OAK_LOG && b <= LEAF_GREEN) || b === TWIG;

let outO = new Uint32Array(1 << 16), nO = 0, outW = new Uint32Array(1 << 12), nW = 0;
let minY = CH, maxY = 0;
function push(water, v) {
  if (water) {
    if (nW >= outW.length) { const t = new Uint32Array(outW.length * 2); t.set(outW); outW = t; }
    outW[nW++] = v;
  } else {
    if (nO >= outO.length) { const t = new Uint32Array(outO.length * 2); t.set(outO); outO = t; }
    outO[nO++] = v;
  }
}
const aoF = (a, b, c) => (a && b) ? 0 : 3 - (a + b + c);

// Water vertices carry 64 + level*9 + dir in their block byte: level 1..8 sets the surface
// height, dir 0..7 is the flow heading in 45° steps and 8 means still water.
let gv = null;
function waterCode(x, y, z, b, side) {
  const lv = levelOf(b);
  if (side) return 64 + lv * 9 + 8;
  let fx = 0, fz = 0;
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of nb) {
    const n = gv(x + dx, y, z + dz);
    if (SOL[n]) continue;
    let nl;
    if (isWater(n)) nl = isWater(gv(x + dx, y + 1, z + dz)) ? 8 : levelOf(n);
    else nl = isWater(gv(x + dx, y - 1, z + dz)) || gv(x + dx, y - 1, z + dz) === AIR ? -4 : 0;
    fx += (lv - nl) * dx; fz += (lv - nl) * dz;
  }
  const wx = curOx + x, wz = curOz + z;
  if (lv === 8) {
    const r = riverAt(wx, wz);
    if (r && r.core && r.L > WL) { fx += r.s.fx * 3; fz += r.s.fz * 3; }
  }
  if (Math.hypot(fx, fz) < 0.5) return 64 + lv * 9 + 8;
  const dir = ((Math.round(Math.atan2(fz, fx) / (Math.PI / 4)) % 8) + 8) % 8;
  return 64 + lv * 9 + dir;
}
const wp3 = [0, 0, 0];
function emitWaterSide(d, u, v, s, sl, i, j, nIdx, code, wetAbove) {
  const pl = sl + (s > 0 ? 1 : 0);
  const cu = [i, i + 1, i + 1, i], cv = [j, j, j + 1, j + 1];
  const ord = s > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  for (const c of ord) {
    wp3[d] = pl; wp3[u] = cu[c]; wp3[v] = cv[c];
    // a top vertex drops to the surface, unless more water sits above (a seamless falling sheet)
    const top = !wetAbove && wp3[1] > (u === 1 ? i : j) ? 1 : 0;
    push(true, (wp3[0] | (wp3[1] << 6) | (wp3[2] << 13) | (nIdx << 19) | (top << 22) | (code << 24)) >>> 0);
  }
}
let curOx = 0, curOz = 0;
// two crossed diagonal planes, each drawn from both sides; the normal slot tells the planes
// apart (2 and 3) and the AO bits carry 0 at the foot and 3 at the tip, used for sway and shade
function emitPlant(x, y, z, b, ht) {
  const planes = [[x, z, x + 1, z + 1, 2], [x + 1, z, x, z + 1, 3]];
  for (const [x0, z0, x1, z1, n] of planes) {
    const v = [[x0, y, z0, 0], [x1, y, z1, 0], [x1, y + ht, z1, 3], [x0, y + ht, z0, 3]];
    for (const ord of [[0, 1, 2, 3], [0, 3, 2, 1]])
      for (const c of ord) {
        const [px, py, pz, a] = v[c];
        push(false, (px | (py << 6) | (pz << 13) | (n << 19) | (a << 22) | (b << 24)) >>> 0);
      }
  }
  if (y < minY) minY = y;
  if (y + ht > maxY) maxY = y + ht;
}
function mesh(vol, cx, cz) {
  nO = 0; nW = 0; minY = CH; maxY = 0;
  curOx = cx * CS; curOz = cz * CS;
  const dims = [CS, CH, CS];
  const g = (x, y, z) => y < 0 ? STONE : y >= CH ? AIR : vol[(y * P + z + 1) * P + x + 1];
  // water depth (0..3) shared by the four columns around a vertex corner at (x, z)
  function seaDepthAt(x, z) {
    let m = 3;
    for (let dz = -1; dz <= 0; dz++)
      for (let dx = -1; dx <= 0; dx++) {
        let n = 0;
        while (n < 3 && isWater(g(x + dx, WL - n, z + dz))) n++;
        if (n < m) m = n;
      }
    return m;
  }
  // how deep the open sea is under a vertex, up to 100 blocks: storm swells only build over deep
  // water and die away as the sea floor rises toward the coast
  function seaDeepAt(x, z) {
    let m = 100;
    for (let dz = -1; dz <= 0; dz++)
      for (let dx = -1; dx <= 0; dx++) {
        let n = 0;
        while (n < m && WL - n > 0 && isWater(g(x + dx, WL - n, z + dz))) n++;
        if (n < m) m = n;
      }
    return m;
  }
  gv = g;
  const S = q => SOL[g(q[0], q[1], q[2])];
  const pos = [0, 0, 0], q = [0, 0, 0], p = [0, 0, 0];
  const cu = [0, 0, 0, 0], cv = [0, 0, 0, 0], ao = [0, 0, 0, 0];
  for (let y = 1; y < CH - 2; y++)
    for (let z = 0; z < CS; z++)
      for (let x = 0; x < CS; x++) {
        const b = g(x, y, z);
        if (b === REED || b === TUFT) emitPlant(x, y, z, b, b === REED ? 2 : 1);
      }
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3, du = dims[u], dv = dims[v];
    const mask = new Int32Array(du * dv);
    for (let s = 1; s >= -1; s -= 2) {
      const nIdx = d * 2 + (s > 0 ? 0 : 1);
      for (let sl = 0; sl < dims[d]; sl++) {
        let n = 0;
        for (let j = 0; j < dv; j++)
          for (let i = 0; i < du; i++, n++) {
            pos[d] = sl; pos[u] = i; pos[v] = j;
            const b = g(pos[0], pos[1], pos[2]);
            if (b === AIR || isPlant(b)) { mask[n] = 0; continue; }
            q[0] = pos[0]; q[1] = pos[1]; q[2] = pos[2]; q[d] += s;
            const nb = g(q[0], q[1], q[2]);
            if (isWater(b)) {
              mask[n] = 0;
              if (nb !== AIR) continue;
              if (d === 1 && s > 0) mask[n] = waterCode(pos[0], pos[1], pos[2], b) | (255 << 8) | (1 << 16);
              else if (d !== 1) emitWaterSide(d, u, v, s, sl, i, j, nIdx, waterCode(pos[0], pos[1], pos[2], b, true), isWater(g(pos[0], pos[1] + 1, pos[2])));
              continue;
            }
            if (SOL[nb]) { mask[n] = 0; continue; }
            q[u] -= 1; const l = S(q); q[u] += 2; const r = S(q); q[u] -= 1;
            q[v] -= 1; const bt = S(q); q[v] += 2; const t = S(q); q[v] -= 1;
            q[u] -= 1; q[v] -= 1; const lb = S(q);
            q[u] += 2; const rb = S(q);
            q[v] += 2; const rt = S(q);
            q[u] -= 2; const lt = S(q);
            q[u] += 1; q[v] -= 1;
            mask[n] = b | (aoF(l, bt, lb) << 8) | (aoF(r, bt, rb) << 10) | (aoF(r, t, rt) << 12) | (aoF(l, t, lt) << 14);
          }
        n = 0;
        for (let j = 0; j < dv; j++)
          for (let i = 0; i < du;) {
            const k = mask[n];
            if (!k) { i++; n++; continue; }
            // the open sea's surface is kept in 2x2 pieces so its vertices can roll with the swell
            const seaTop = d === 1 && s > 0 && sl === WL && ((k >> 16) & 1), cap = seaTop ? 2 : 1 << 30;
            let w = 1;
            while (i + w < du && w < cap && mask[n + w] === k) w++;
            let h = 1;
            outer: while (j + h < dv && h < cap) {
              for (let x = 0; x < w; x++) if (mask[n + x + h * du] !== k) break outer;
              h++;
            }
            // emit quad
            const b = k & 255, water = (k >> 16) & 1;
            ao[0] = (k >> 8) & 3; ao[1] = (k >> 10) & 3; ao[2] = (k >> 12) & 3; ao[3] = (k >> 14) & 3;
            const pl = sl + (s > 0 ? 1 : 0);
            cu[0] = i; cu[1] = i + w; cu[2] = i + w; cu[3] = i;
            cv[0] = j; cv[1] = j; cv[2] = j + h; cv[3] = j + h;
            let o0 = 0, o1 = 1, o2 = 2, o3 = 3;
            if (s < 0) { o1 = 3; o3 = 1; }
            if (ao[o0] + ao[o2] < ao[o1] + ao[o3]) { const t = o0; o0 = o1; o1 = o2; o2 = o3; o3 = t; }
            const ord = [o0, o1, o2, o3];
            for (let c = 0; c < 4; c++) {
              const cc = ord[c];
              p[d] = pl; p[u] = cu[cc]; p[v] = cv[cc];
              // sea vertices carry how deep the water is around them (0..3): the swell dies out on the shore
              // and, in the block byte (145 + depth; water codes end at 144), how deep it is in full
              let bb = b;
              if (seaTop) { ao[cc] = seaDepthAt(p[0], p[2]); bb = 145 + seaDeepAt(p[0], p[2]); }
              // storm swells lift and lower the sea surface by a few blocks
              const pad = seaTop ? 5 : 0;
              if (p[1] - pad < minY) minY = p[1] - pad;
              if (p[1] + pad > maxY) maxY = p[1] + pad;
              push(water, (p[0] | (p[1] << 6) | (p[2] << 13) | (nIdx << 19) | (ao[cc] << 22) | (bb << 24)) >>> 0);
            }
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[n + x + y * du] = 0;
            i += w; n += w;
          }
      }
    }
  }
}

// Leaf blocks with open air below drop leaves; water touching air needs the simulation.
function scanExtras(vol) {
  const emit = [], unstable = [];
  for (let y = 1; y < CH; y++)
    for (let z = 0; z < CS; z++)
      for (let x = 0; x < CS; x++) {
        const i = (y * P + z + 1) * P + x + 1, b = vol[i];
        if (b >= LEAF_RED && b <= LEAF_BROWN) {
          if (vol[i - P * P] === AIR) emit.push(x | (y << 6) | (z << 13) | (b << 20));
        } else if (isWater(b)) {
          if (vol[i - P * P] === AIR || vol[i - 1] === AIR || vol[i + 1] === AIR || vol[i - P] === AIR || vol[i + P] === AIR)
            unstable.push(x | (y << 6) | (z << 13));
          // spray: the foot of a waterfall (type 60) and surf where the sea laps a dry shore (type 61)
          if (vol[i + P * P] === AIR || b === FALL) {
            const below = vol[i - P * P], wx = curOx + x, wz = curOz + z;
            if (b === FALL && below !== FALL && below !== AIR && hash(wx, wz, 61 + y) < 0.7) emit.push(x | (y << 6) | (z << 13) | (60 << 20));
            else if (b === WATER && y === WL && hash(wx, wz, 62) < 0.35) {
              const sd = (j) => SOL[vol[j]] && vol[j + P * P] === AIR;
              if (sd(i - 1) || sd(i + 1) || sd(i - P) || sd(i + P)) emit.push(x | (y << 6) | (z << 13) | (61 << 20));
            }
          }
        }
      }
  return { emit: new Uint32Array(emit), unstable: new Uint32Array(unstable) };
}
function groundHeights(vol) {
  const hts = new Uint8Array(CS * CS);
  for (let z = 0; z < CS; z++)
    for (let x = 0; x < CS; x++) {
      let y = CH - 1;
      for (; y >= 0; y--) {
        const b = vol[(y * P + z + 1) * P + x + 1];
        if (b !== AIR && !isCanopy(b) && !isPlant(b)) break;
      }
      hts[z * CS + x] = y + 1;
    }
  return hts;
}

// a job that throws reports back instead of silently never answering (which used to leave
// the chunk, and eventually the whole queue, stuck)
onmessage = e => {
  const m = e.data;
  try { handleJob(m); }
  catch (err) { postMessage({ type: 'error', job: m.type || 'chunk', cx: m.cx, cz: m.cz, gen: m.gen, version: m.version, msg: String((err && err.stack) || err).slice(0, 600) }); }
};
function handleJob(m) {
  if (m.type === 'planet') {
    // the planet is simulated in every worker (deterministic from the seed); one of them
    // reports progress and sends the summary maps the main thread needs for spawn and the map
    planetProgress = m.report ? (text, f) => postMessage({ type: 'progress', text, f }) : () => {};
    setSeed(m.seed);
    planetProgress = () => {};
    if (!m.report) { postMessage({ type: 'ready', gen: m.gen }); return; }
    const ys = new Uint8Array(PN), riv = new Uint8Array(PN), lk = new Uint8Array(PN), tmp = new Int8Array(PN);
    for (let k = 0; k < PN; k++) {
      ys[k] = Math.max(0, Math.min(255, Math.round(cellY[k])));
      // (brooks are 1..8, rivers 9 and up)
      riv[k] = isMainRiver(k) ? Math.max(9, Math.min(255, Math.round(PL.acc[k] * 4))) : isRiverCell(k) ? Math.max(1, Math.min(8, Math.round(PL.acc[k] * 4))) : 0;
      lk[k] = lakeY[k];
      tmp[k] = Math.max(-127, Math.min(127, Math.round(PL.temp[k])));
    }
    const biome = PL.biome.slice();
    // raw fields for the map's study views (plates, rain, temperature, drainage, rivers)
    const L = { elev: Float32Array.from(PL.elev), rain: Float32Array.from(PL.rain), temp: Float32Array.from(PL.temp), acc: Float32Array.from(PL.acc), lake: Float32Array.from(PL.lake), plate: Int32Array.from(PL.plate) };
    postMessage({ type: 'planet', gen: m.gen, seed: m.seed, PW, PH, PCELL, ys, riv, lk, tmp, biome, L },
      [ys.buffer, riv.buffer, lk.buffer, tmp.buffer, biome.buffer, ...Object.values(L).map(a => a.buffer)]);
    return;
  }
  setSeed(m.seed);
  BARE = !!m.bare;
  let vol, blocks = null;
  if (m.padded) vol = m.padded;
  else {
    vol = genPadded(m.cx, m.cz);
    if (m.blocks) {
      blocks = m.blocks;
      for (let y = 0; y < CH; y++)
        for (let z = 0; z < CS; z++)
          vol.set(blocks.subarray((y * CS + z) * CS, (y * CS + z) * CS + CS), (y * P + z + 1) * P + 1);
    } else {
      blocks = new Uint8Array(CS * CS * CH);
      for (let y = 0; y < CH; y++)
        for (let z = 0; z < CS; z++)
          blocks.set(vol.subarray((y * P + z + 1) * P + 1, (y * P + z + 1) * P + 1 + CS), (y * CS + z) * CS);
    }
  }
  if (m.padded) prepareRivers(m.cx * CS - 1, m.cz * CS - 1, m.cx * CS + CS, m.cz * CS + CS);
  mesh(vol, m.cx, m.cz);
  const heights = groundHeights(vol);
  const { emit, unstable } = scanExtras(vol);
  const o = outO.slice(0, nO), w = outW.slice(0, nW);
  const transfer = [o.buffer, w.buffer, heights.buffer, emit.buffer, unstable.buffer];
  if (blocks) transfer.push(blocks.buffer);
  postMessage({ cx: m.cx, cz: m.cz, version: m.version, gen: m.gen, blocks, heights, o, w, minY, maxY, emit, unstable }, transfer);
}

// ---------- planet ----------
// The whole world is simulated once, up front, on a 512x256 grid that wraps east-west
// (each cell is 16x16 blocks, so the planet is 8192 blocks around and 4096 pole to pole):
//   1. tectonic plates drift; collisions push up ranges, rifts and ridges open where they part
//   2. temperature falls with latitude and height; prevailing winds carry ocean moisture inland
//      and drop it as rain on windward slopes, leaving rain shadows behind mountains
//   3. stream-power erosion: rain collects into drainage networks that cut valleys while the
//      plates keep lifting the ranges; basins with no outlet fill into lakes
//   4. rivers are the cells that gather enough rain; biomes come from temperature and rain
// Chunk workers then sample these fields to build voxels.
const PW = 512, PH = 256, PCELL = 16, PN = PW * PH;
const PLANET_X = PW * PCELL, PLANET_Z = PH * PCELL;
// a stream needs this much collected rain and at least this many cells of land draining into it
const RIVER_MIN_PLANET = 2.2, RIVER_AREA = 6, DELTA_MIN = 18;
// continental crust height, highland strength, background uplift during erosion
const CONT_BASE = 0.6, HIGH_AMP = 1.2, BG_UP = 0.9;
const BIOME = { OCEAN: 0, ICE: 1, TUNDRA: 2, TAIGA: 3, AUTUMN: 4, GRASS: 5, DESERT: 6, WARM: 7, SAVANNA: 8, SCRUB: 9 };

function planetRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
// 3D gradient noise, sampled on the sphere so the map wraps without seams
function noise3(seed) {
  const rnd = planetRng(seed * 2654435761);
  const perm = new Uint8Array(512), g = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    let x, y, z, l;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.01);
    l = Math.sqrt(l); g[i * 3] = x / l; g[i * 3 + 1] = y / l; g[i * 3 + 2] = z / l;
  }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const X = xi & 255, Y = yi & 255, Z = zi & 255;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const gr = (h, dx, dy, dz) => { h *= 3; return g[h] * dx + g[h + 1] * dy + g[h + 2] * dz; };
    const a = perm[X] + Y, aa = perm[a] + Z, ab = perm[a + 1] + Z, b = perm[X + 1] + Y, ba = perm[b] + Z, bb = perm[b + 1] + Z;
    const l = (t, p, q) => p + t * (q - p);
    return l(w,
      l(v, l(u, gr(perm[aa], xf, yf, zf), gr(perm[ba], xf - 1, yf, zf)), l(u, gr(perm[ab], xf, yf - 1, zf), gr(perm[bb], xf - 1, yf - 1, zf))),
      l(v, l(u, gr(perm[aa + 1], xf, yf, zf - 1), gr(perm[ba + 1], xf - 1, yf, zf - 1)), l(u, gr(perm[ab + 1], xf, yf - 1, zf - 1), gr(perm[bb + 1], xf - 1, yf - 1, zf - 1))));
  };
}
function fbm3(n, x, y, z, oct, f) {
  let s = 0, a = 1, t = 0;
  for (let o = 0; o < oct; o++) { s += n(x * f, y * f, z * f) * a; t += a; a *= 0.5; f *= 2.03; }
  return s / t;
}

// Binary min-heap over cell indices keyed by a Float32Array
function makeHeap(n) {
  const idx = new Int32Array(n + 1), key = new Float32Array(n + 1);
  let size = 0;
  return {
    get size() { return size; },
    clear() { size = 0; },
    push(i, k) {
      let p = ++size;
      while (p > 1) { const q = p >> 1; if (key[q] <= k) break; idx[p] = idx[q]; key[p] = key[q]; p = q; }
      idx[p] = i; key[p] = k;
    },
    pop() {
      const top = idx[1], li = idx[size], lk = key[size--];
      let p = 1;
      for (;;) {
        let c = p << 1;
        if (c > size) break;
        if (c < size && key[c + 1] < key[c]) c++;
        if (key[c] >= lk) break;
        idx[p] = idx[c]; key[p] = key[c]; p = c;
      }
      idx[p] = li; key[p] = lk;
      return top;
    },
  };
}

function simulatePlanet(seed, progress = () => {}) {
  const rnd = planetRng(seed * 7919 + 17);
  const nWarp = noise3(seed + 1), nCrust = noise3(seed + 2), nDetail = noise3(seed + 3), nRidge = noise3(seed + 4), nRain = noise3(seed + 5);
  const px = new Float32Array(PN), py = new Float32Array(PN), pz = new Float32Array(PN), lat = new Float32Array(PN);
  for (let j = 0; j < PH; j++) {
    const la = Math.PI / 2 - (j + 0.5) / PH * Math.PI;
    for (let i = 0; i < PW; i++) {
      const lo = i / PW * Math.PI * 2, k = j * PW + i;
      px[k] = Math.cos(la) * Math.cos(lo); py[k] = Math.sin(la); pz[k] = Math.cos(la) * Math.sin(lo); lat[k] = la;
    }
  }
  const W = i => (i + PW) % PW;

  // ---- 1. continents and plates ----
  progress('Drifting tectonic plates', 0.02);
  const toCell = (x, y, z) => {
    const la = Math.asin(Math.max(-1, Math.min(1, y))), lo = Math.atan2(z, x);
    return [((lo / (Math.PI * 2) * PW) % PW + PW) % PW, (Math.PI / 2 - la) / Math.PI * PH];
  };
  // Continents are old, thick, buoyant crust: a few big ragged landmasses drawn from warped
  // large-scale noise. They never sink, so the plates are grown around them (below) and carry
  // them whole, the way real plates do.
  const nCont = noise3(seed + 7), nCoast = noise3(seed + 8), nPlain = noise3(seed + 9);
  const crust0 = new Float32Array(PN);
  for (let k = 0; k < PN; k++) {
    const x = px[k], y = py[k], z = pz[k];
    // two layers of warp: the broad one bends whole continents, the fine one pulls the coast
    // out into peninsulas and pushes it in as gulfs and bays
    let wx = x + fbm3(nWarp, x + 3, y, z, 3, 1.4) * 0.5, wy = y + fbm3(nWarp, y - 4, z, x, 3, 1.4) * 0.5, wz = z + fbm3(nWarp, z, x + 9, y, 3, 1.4) * 0.5;
    const fx = fbm3(nCoast, wx - 7, wy, wz, 4, 3.5), fy = fbm3(nCoast, wy + 5, wz, wx, 4, 3.5), fz = fbm3(nCoast, wz, wx - 2, wy, 4, 3.5);
    wx += fx * 0.22; wy += fy * 0.22; wz += fz * 0.22;
    crust0[k] = fbm3(nCont, wx, wy, wz, 6, 1.25) * 1.6;
  }
  const cthr = Float32Array.from(crust0).sort()[Math.floor(PN * 0.64)];
  const cont = new Uint8Array(PN);
  for (let k = 0; k < PN; k++) cont[k] = crust0[k] > cthr ? 1 : 0;
  const isCont = k => cont[k] === 1;

  // shortest-path growth over the 8 neighbours (true step lengths on the sphere), used for
  // plates, sea-floor age and distance to the coast
  const cosJ = new Float32Array(PH);
  for (let j = 0; j < PH; j++) cosJ[j] = Math.max(0.05, Math.cos(lat[j * PW]));
  const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const gheap = makeHeap(PN * 9), gdone = new Uint8Array(PN);
  const grow = (dst, lab, cost) => {
    gheap.clear(); gdone.fill(0);
    for (let k = 0; k < PN; k++) if (dst[k] < Infinity) gheap.push(k, dst[k]);
    while (gheap.size) {
      const k = gheap.pop();
      if (gdone[k]) continue;
      gdone[k] = 1;
      const i = k % PW, j = (k - i) / PW;
      for (const [di, dj] of NB8) {
        const jj = j + dj;
        if (jj < 0 || jj >= PH) continue;
        const kk = jj * PW + W(i + di);
        if (gdone[kk]) continue;
        const c = cost(k, kk, Math.hypot(di * cosJ[j], dj), lab[k]);
        if (!(c < Infinity)) continue;
        const nd = dst[k] + c;
        if (nd < dst[kk]) { dst[kk] = nd; lab[kk] = lab[k]; gheap.push(kk, nd); }
      }
    }
  };

  const NP = 13 + Math.floor(rnd() * 5);
  const plates = [];
  for (let p = 0; p < NP; p++) {
    let x, y, z, l;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = Math.hypot(x, y, z); } while (l > 1 || l < 0.1);
    let ax, ay, az, al;
    do { ax = rnd() * 2 - 1; ay = rnd() * 2 - 1; az = rnd() * 2 - 1; al = Math.hypot(ax, ay, az); } while (al > 1 || al < 0.1);
    const spin = 0.4 + rnd() * 0.9;
    plates.push({ x: x / l, y: y / l, z: z / l, ax: ax / al * spin, ay: ay / al * spin, az: az / al * spin,
      size: 0.7 + rnd() * 0.6, oc: 2 + rnd() * 6, cont: false, cf: 0 });
  }
  // Plates grow out from their seeds. Ocean floor can't ride up onto a continent, so a plate
  // reaching a coast from the sea mostly stops there; a plate born on a continent takes it
  // whole and spreads only slowly out over the ocean around it (some keep a wide apron of
  // sea floor, some barely reach past the shelf). Plate edges therefore run through the
  // oceans and along coasts, and cross a continent only where two plates share it.
  const plate = new Uint8Array(PN);
  {
    const dst = new Float32Array(PN).fill(Infinity), lab = new Uint8Array(PN), wig = new Float32Array(PN);
    for (let k = 0; k < PN; k++) wig[k] = Math.exp(fbm3(nWarp, px[k] * 1.3, py[k] * 1.3 + 5, pz[k] * 1.3, 4, 2.2) * 2.2);
    for (let p = 0; p < NP; p++) {
      const [ci, cj] = toCell(plates[p].x, plates[p].y, plates[p].z), k = Math.min(PH - 1, Math.floor(cj)) * PW + Math.floor(ci) % PW;
      plates[p].onCont = isCont(k);
      if (dst[k] === 0) continue;
      dst[k] = 0; lab[k] = p;
    }
    grow(dst, lab, (k, kk, st, p) => {
      const s = plates[p];
      let c = st * wig[kk] / s.size;
      if (cont[kk] && !cont[k]) c += 45;
      else if (!cont[kk] && s.onCont) c *= s.oc;
      return c;
    });
    plate.set(lab);
  }
  {
    const n = new Float32Array(NP), nc = new Float32Array(NP);
    for (let k = 0; k < PN; k++) { n[plate[k]]++; if (cont[k]) nc[plate[k]]++; }
    // slab pull: plates of ocean floor sinking at their edges move fast, continents drag
    for (let p = 0; p < NP; p++) {
      const s = plates[p];
      s.cf = nc[p] / Math.max(1, n[p]); s.cont = s.cf > 0.25;
      const f = s.cont ? 0.6 : 1.2;
      s.ax *= f; s.ay *= f; s.az *= f;
    }
  }
  // plate velocity at a cell: rotation about the plate's Euler pole (omega x p)
  const vel = (p, k) => {
    const s = plates[p];
    return [s.ay * pz[k] - s.az * py[k], s.az * px[k] - s.ax * pz[k], s.ax * py[k] - s.ay * px[k]];
  };
  // distance to the plate's own continental crust: a coast that sits just behind a plate edge
  // counts as the continent's own margin
  const contD = new Float32Array(PN).fill(Infinity);
  {
    const lab = new Uint8Array(PN);
    for (let k = 0; k < PN; k++) { lab[k] = plate[k]; if (cont[k]) contD[k] = 0; }
    grow(contD, lab, (k, kk, st, p) => plate[kk] !== p ? Infinity : st);
  }

  // boundary cells: convergence > 0 where plates push together, < 0 where they pull apart
  progress('Raising mountain ranges', 0.1);
  const conv = new Float32Array(PN), nbOf = new Int32Array(PN).fill(-1);
  for (let j = 0; j < PH; j++)
    for (let i = 0; i < PW; i++) {
      const k = j * PW + i, a = plate[k];
      let c = 0, n = 0, nbK = k;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const jj = j + dj;
        if (jj < 0 || jj >= PH) continue;
        const kk = jj * PW + W(i + di), b = plate[kk];
        if (b === a) continue;
        const va = vel(a, k), vb = vel(b, kk);
        const nx = px[kk] - px[k], ny = py[kk] - py[k], nz = pz[kk] - pz[k], nl = Math.hypot(nx, ny, nz) || 1;
        c += ((va[0] - vb[0]) * nx + (va[1] - vb[1]) * ny + (va[2] - vb[2]) * nz) / nl; n++; nbK = kk;
      }
      if (!n) continue;
      conv[k] = c / n; nbOf[k] = nbK;
    }
  // Sea-floor age: new floor is made at the spreading ridges and carried away at the plate's
  // speed, cooling and sinking as it goes (depth grows with the square root of age). Old floor
  // is the deep, heavy floor that sinks back into the mantle at the trenches.
  const age = new Float32Array(PN);
  {
    const dst = new Float32Array(PN).fill(Infinity), lab = new Uint8Array(PN), spd = new Float32Array(PN);
    for (let k = 0; k < PN; k++) {
      const v = vel(plate[k], k);
      spd[k] = Math.max(0.12, Math.hypot(v[0], v[1], v[2]));
      lab[k] = plate[k];
      if (nbOf[k] >= 0 && conv[k] < -0.02 && !cont[k]) dst[k] = 0;
    }
    grow(dst, lab, (k, kk, st, p) => plate[kk] !== p || cont[kk] ? Infinity : st / spd[kk]);
    for (let k = 0; k < PN; k++) age[k] = cont[k] ? 1 : 1 - Math.exp(-Math.min(dst[k], 400) / 45);
  }
  // boundary character: 1 continent-continent, 2 continent riding over sinking ocean floor,
  // 3 ocean floor sinking at a trench, 4 ocean floor overriding ocean floor (island arc side).
  // Where two continents meet, the plate carrying more continent rides over the other.
  const bType = new Uint8Array(PN), over = new Uint8Array(PN);
  const dist = new Float32Array(PN).fill(1e9), srcConv = new Float32Array(PN), srcType = new Uint8Array(PN), srcOver = new Uint8Array(PN);
  const queue = new Int32Array(PN * 4);
  let qh = 0, qt = 0;
  for (let k = 0; k < PN; k++) {
    const kk = nbOf[k];
    if (kk < 0) continue;
    const a = plate[k], b = plate[kk], ca = contD[k] <= 4, cb = contD[kk] <= 4;
    let t, o = 0;
    if (ca && cb) { t = 1; o = plates[a].cf > plates[b].cf || (plates[a].cf === plates[b].cf && a < b) ? 1 : 0; }
    else if (ca) { t = 2; o = 1; }
    else if (cb) t = 3;
    else {
      // ocean meets ocean: the older, colder, denser floor goes down
      const older = age[k] > age[kk] + 0.01 || (Math.abs(age[k] - age[kk]) <= 0.01 && a < b);
      t = older ? 3 : 4; o = older ? 0 : 1;
    }
    bType[k] = t; over[k] = o;
    dist[k] = 0; srcConv[k] = conv[k]; srcType[k] = t; srcOver[k] = o;
    queue[qt++] = k;
  }
  // breadth-first distance from the nearest boundary, carrying that boundary's character
  while (qh < qt) {
    const k = queue[qh++], i = k % PW, j = (k - i) / PW, d = dist[k] + 1;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const jj = j + dj;
      if (jj < 0 || jj >= PH) continue;
      const kk = jj * PW + W(i + di);
      if (dist[kk] <= d || plate[kk] !== plate[k]) continue;
      dist[kk] = d; srcConv[kk] = srcConv[k]; srcType[kk] = srcType[k]; srcOver[kk] = srcOver[k];
      if (qt < queue.length) queue[qt++] = kk;
    }
  }
  // Active margins face an ocean plate sinking under them: a narrow shelf, a trench offshore
  // and a coastal range. Every other coast is a passive margin that rides quietly with its
  // ocean floor: a broad shelf and a low coastal plain.
  const act = new Float32Array(PN);
  for (let k = 0; k < PN; k++) if (srcType[k] === 2 && srcConv[k] > 0.04) act[k] = Math.max(0, 1 - dist[k] / 12) * Math.min(1, srcConv[k] * 6);
  const actS = blurWrap(act, 3);
  // distance inland from the coast (in cells)
  const coastD = new Float32Array(PN).fill(Infinity);
  {
    const lab = new Uint8Array(PN);
    for (let k = 0; k < PN; k++) if (!cont[k]) coastD[k] = 0;
    grow(coastD, lab, (k, kk, st) => st);
  }
  // crust: continents vs ocean basins, smoothed into continental shelves
  let crust = new Float32Array(PN);
  for (let k = 0; k < PN; k++) {
    // a steep continental slope rises out of the deep ocean onto a shallow shelf, then the land
    // climbs only gently inland, so the coast itself runs across low, easily flooded ground.
    // The shelf is wide on passive margins and narrow where a trench lies offshore.
    const c = crust0[k] - cthr, pa = 1 - actS[k];
    let sh = Math.min(1, Math.max(0, (c + 0.07 + 0.09 * pa) / (0.06 + 0.04 * pa))); sh = sh * sh * (3 - 2 * sh);
    const ramp = Math.min(1, Math.max(0, (c + 0.04) / 0.32));
    const floor = -0.2 - 0.48 * Math.sqrt(age[k]);
    crust[k] = floor * (1 - sh) - 0.1 * sh + (CONT_BASE + 0.1) * ramp * (1.6 - 0.6 * ramp) + fbm3(nCrust, px[k], py[k], pz[k], 5, 1.6) * 0.3;
  }
  crust = blurWrap(crust, 2);
  // ragged coasts: fine noise the blur never touched gives bays, headlands and peninsulas, and
  // out on the shallow shelves it raises scattered islands. Some coasts are smooth, some broken
  // into whole archipelagos.
  for (let k = 0; k < PN; k++) {
    const x = px[k], y = py[k], z = pz[k];
    let r = (fbm3(nCoast, x + 11, y, z, 2, 1.6) + 0.12) / 0.3; r = r < 0 ? 0 : r > 1 ? 1 : r;
    crust[k] += fbm3(nCoast, x, y, z, 6, 4) * (0.35 + 0.9 * r);
  }
  // Boundary forces. Ranges rise at the plate edge; behind a big collision the thickened crust
  // floats up as a high plateau (like Tibet or the Altiplano); in front of it the weight of the
  // range bends the plate down into a long lowland (a foreland basin, like the Ganges plain)
  // that fills with sediment and gathers a big river along the mountain front. Pulling a
  // continent apart drops a narrow rift floor between raised shoulders.
  const elev = new Float32Array(PN), uplift = new Float32Array(PN), plat = new Float32Array(PN), fore = new Float32Array(PN), rift = new Float32Array(PN), riftSeg = new Float32Array(PN);
  const nRift = noise3(seed + 10);
  for (let k = 0; k < PN; k++) {
    const d = dist[k], c = srcConv[k], t = srcType[k], o = srcOver[k];
    let e = 0, u = 0;
    const band = (a, b, f, g) => { let p = (d - a) / (b - a), q = (g - d) / (g - f); p = p < 0 ? 0 : p > 1 ? 1 : p; q = q < 0 ? 0 : q > 1 ? 1 : q; return p * p * (3 - 2 * p) * q * q * (3 - 2 * q); };
    if (c > 0) {
      const cc = Math.min(c, 0.9);
      if (t === 1) {
        if (o) { u = cc * 1.6 * Math.exp(-d / 6); plat[k] = cc * 0.75 * band(3, 9, 18, 28); }
        else { u = cc * 1.3 * Math.exp(-d / 3.5); fore[k] = cc * Math.exp(-((d - 9) ** 2) / 22); }
      } else if (t === 2) {
        u = cc * 1.2 * Math.exp(-((d - 4) ** 2) / 20);                // coastal range above a subduction zone
        plat[k] = cc * 0.35 * band(5, 9, 13, 18);
        fore[k] = cc * 0.8 * Math.exp(-((d - 16) ** 2) / 30);
      } else if (t === 3) e -= c * 0.9 * Math.exp(-d / 2.5);           // ocean trench
      else u = c * 0.7 * Math.exp(-((d - 2) ** 2) / 6);                // island arc
    } else if (c < 0) {
      const w = Math.min(-c, 0.8);
      if (t === 1) {
        // the rift floor breaks into separate deep basins along its length (they hold lakes)
        const seg = 0.55 + 0.9 * Math.max(0, fbm3(nRift, px[k], py[k], pz[k], 3, 10) + 0.35);
        e += w * 0.45 * Math.exp(-((d - 3.5) ** 2) / 4) - w * 1.1 * seg * Math.exp(-(d * d) / 2.2);
        rift[k] = Math.exp(-(d * d) / 3); riftSeg[k] = seg;
      } else if (t !== 2) e += w * 0.18 * Math.exp(-d / 2);            // crest of a spreading ridge
    }
    uplift[k] = Math.max(0, u);
    elev[k] = e;
  }
  const foreS = blurWrap(fore, 2), platS = blurWrap(plat, 2);
  // highlands: thick continental crust rides high, so continents carry broad uplands and
  // plateaus (with gentle lowlands between) instead of sitting just above the sea
  const nHigh = noise3(seed + 6), highland = new Float32Array(PN), contW = new Float32Array(PN), plain = new Float32Array(PN);
  for (let k = 0; k < PN; k++) {
    let c = (crust[k] + 0.1) / 0.5; c = c < 0 ? 0 : c > 1 ? 1 : c * c * (3 - 2 * c);
    contW[k] = c;
    // plains: broad stretches of old, stable continent (shields and sediment basins) that never
    // got lifted again, so they lie low and flat; also the foreland basins, and the coastal
    // plains of passive margins
    let pl = (fbm3(nPlain, px[k], py[k], pz[k], 3, 1.7) + 0.02) / 0.16; pl = pl < 0 ? 0 : pl > 1 ? 1 : pl * pl * (3 - 2 * pl);
    const coastPl = (1 - actS[k]) * Math.exp(-coastD[k] / 5) * 0.8;
    plain[k] = c * Math.min(1, Math.max(pl, coastPl, foreS[k] * 2.2));
    // uplands: broad plateaus where the noise is high, plus long worn-down ridge belts along
    // its zero lines (old folded mountains), rather than round domes
    const hn = fbm3(nHigh, px[k], py[k], pz[k], 4, 2.4), rg = Math.max(0, 1 - Math.abs(hn) * 6);
    highland[k] = c * (Math.max(0, hn + 0.02) * 0.8 + rg * rg * 0.35) * (1 - plain[k]);
    crust[k] += highland[k] * HIGH_AMP;
    elev[k] += crust[k] + c * (platS[k] - foreS[k] * 0.4);
  }
  // smooth the boundary forces so ranges follow the plate edges instead of grid steps
  const upS = blurWrap(blurWrap(uplift, 2), 2), elS = blurWrap(elev, 1);
  for (let k = 0; k < PN; k++) {
    const ridged = 1 - Math.abs(fbm3(nRidge, px[k], py[k], pz[k], 5, 6));
    const u = upS[k] * (0.6 + 0.8 * ridged * ridged) * 0.6;
    // slow background uplift on continents (more under the highlands and plateaus) keeps
    // relief alive while rivers cut down, so the land ends up as ridges and valleys instead of
    // a worn-flat plain (ranges still cut across a plain where plates collide)
    plain[k] *= 1 - Math.min(1, upS[k] * 4);
    uplift[k] = u + contW[k] * BG_UP * (0.4 + highland[k] * 3 + platS[k] * 2.5) * (1 - 0.92 * plain[k]);
    // rift basins keep sinking while the sills between them hold up, so the lakes last
    if (rift[k] > 0.2 && cont[k]) uplift[k] = uplift[k] * (1 - rift[k]) + rift[k] * (1.1 - riftSeg[k]) * 1.6;
    let e = elS[k] + u + fbm3(nDetail, px[k], py[k], pz[k], 6, 9) * 0.12 * (1 - 0.7 * plain[k]);
    // polar seas at the very top and bottom of the map
    const pole = Math.abs(lat[k]) / (Math.PI / 2);
    if (pole > 0.93) e = Math.min(e, -0.4 - (pole - 0.93) * 8);
    elev[k] = e;
  }
  // put sea level where about 31% of the planet is land
  {
    const s = Float32Array.from(elev).sort();
    const sl = s[Math.floor(PN * 0.69)];
    for (let k = 0; k < PN; k++) {
      elev[k] -= sl;
      // the plains settle just above the sea, tilted gently so they still drain
      if (elev[k] > 0 && plain[k] > 0) elev[k] += (Math.max(0.03, 0.05 + elev[k] * 0.08) - elev[k]) * plain[k] * 0.9;
      // a rift floor inside a continent stays above the sea, with sills between its deep
      // basins, so they hold a chain of long lakes
      if (rift[k] > 0.2 && cont[k]) elev[k] = Math.max(elev[k], 0.05 + 0.35 * Math.max(0, 1.15 - riftSeg[k]) * rift[k]);
    }
  }
  // hotspots: mantle plumes fixed under the drifting plates punch out chains of volcanic
  // islands. The newest island sits over the plume and is the tallest; older ones were carried
  // away with the plate, cooled, sank and wore down into low islands and seamounts.
  const volc = new Uint8Array(PN);
  {
    const hr = planetRng(seed * 31 + 7);
    const NH = 7 + Math.floor(hr() * 4);
    for (let h = 0, tries = 0; h < NH && tries < 400; tries++) {
      const k = Math.floor(hr() * PN);
      if (isCont(k) || elev[k] > -0.25 || Math.abs(lat[k]) > 1.0) continue;
      h++;
      const v = vel(plate[k], k), vl = Math.hypot(v[0], v[1], v[2]) || 1;
      const len = 5 + Math.floor(hr() * 5), sp = 0.045 + hr() * 0.02;
      for (let n = 0; n < len; n++) {
        let x = px[k] - v[0] / vl * sp * n, y = py[k] - v[1] / vl * sp * n, z = pz[k] - v[2] / vl * sp * n;
        const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
        const [ci, cj] = toCell(x, y, z);
        // big shield volcanoes with ragged flanks (lava flows, collapsed sides), so each island
        // has its own outline instead of a round dot
        const peak = 0.7 + hr() * 0.3 - n * 0.15, r = 2.2 + hr() * 1.8 + n * 0.12;
        for (let dj = -8; dj <= 8; dj++) for (let di = -8; di <= 8; di++) {
          const jj = Math.floor(cj) + dj, ii = Math.floor(ci) + di;
          if (jj < 0 || jj >= PH) continue;
          const kk = jj * PW + W(ii);
          const d2 = ((ii + 0.5 - ci) ** 2 + (jj + 0.5 - cj) ** 2) / (r * r) * (1 + 1.6 * fbm3(nCoast, px[kk] * 3 + h, py[kk] * 3, pz[kk] * 3, 3, 9));
          if (d2 < 9 && peak > elev[kk]) elev[kk] += (peak - elev[kk]) * Math.exp(-d2);
          // the young volcanoes are still building, which keeps them above the waves
          if (d2 < 9 && peak > 0) { uplift[kk] += peak * 1.6 * Math.exp(-d2); volc[kk] = 1; }
        }
      }
    }
  }

  // island arcs: where ocean floor dives under ocean floor, a curved line of volcanoes rises
  // a little way behind the trench on the overriding plate (like the Aleutians or the Lesser
  // Antilles)
  for (let k = 0; k < PN; k++) {
    if (srcType[k] !== 4 || srcConv[k] <= 0.05 || dist[k] > 7 || isCont(k)) continue;
    const a = Math.exp(-((dist[k] - 3) ** 2) / 4) * Math.min(1, srcConv[k] * 2.5);
    let v = (fbm3(nCoast, px[k] + 21, py[k], pz[k], 3, 16) + 0.02) / 0.18; v = v < 0 ? 0 : v > 1 ? 1 : v;
    const add = a * v * 0.75;
    if (add > 0.05) { elev[k] += add; uplift[k] += add * 1.2; volc[k] = 1; }
  }
  // Volcanoes on land: a line of tall cones along the coastal range above a sinking plate (the
  // Andes, the Cascades), and a few along the shoulders of the rifts.
  {
    const hr = planetRng(seed * 53 + 11), cones = [];
    const cand = [];
    for (let k = 0; k < PN; k++) {
      if (elev[k] <= 0.1 || !cont[k]) continue;
      const d = dist[k];
      if (srcType[k] === 2 && srcConv[k] > 0.06 && d >= 2 && d <= 7) cand.push(k);
      else if (srcType[k] === 1 && srcConv[k] < -0.06 && d >= 2 && d <= 5) cand.push(k);
    }
    for (let n = cand.length - 1; n > 0; n--) { const m = Math.floor(hr() * (n + 1)), t = cand[n]; cand[n] = cand[m]; cand[m] = t; }
    for (const k of cand) {
      const i0 = k % PW, j0 = (k - i0) / PW;
      const arc = srcType[k] === 2;
      if (hr() > (arc ? 0.03 : 0.025)) continue;
      const sp = arc ? 11 : 12;
      if (cones.some(([i, j]) => Math.abs(j - j0) < sp && Math.min(Math.abs(i - i0), PW - Math.abs(i - i0)) < sp)) continue;
      cones.push([i0, j0]);
      const h = (arc ? 0.55 : 0.4) + hr() * 0.35, r = 1.1 + hr() * 0.5, top = elev[k] + h;
      for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
        const jj = j0 + dj;
        if (jj < 0 || jj >= PH) continue;
        const kk = jj * PW + W(i0 + di), d2 = (di * di + dj * dj) / (r * r);
        if (d2 > 9) continue;
        const f = Math.exp(-d2 * 0.8);
        if (top * f + elev[kk] * (1 - f) > elev[kk]) elev[kk] = top * f + elev[kk] * (1 - f);
        uplift[kk] += h * 1.4 * f; volc[kk] = 1;
      }
    }
  }

  // ---- 2. climate ----
  // Two seasons are worked out, July and January (northern summer and winter), and the year is
  // their average. The sun drags the equatorial rain belt north and south with it (further over
  // land, which heats faster), and the dry subtropical highs and the westerly storm track follow,
  // so some lands get all their rain in one season: monsoon and savanna where the tropical rains
  // visit in summer, Mediterranean coasts where the storms only reach in winter.
  progress('Blowing wind and rain across the oceans', 0.25);
  const temp = new Float32Array(PN), rain = new Float32Array(PN), tAnom = new Float32Array(PN);
  const sst = new Float32Array(PN), sstA = new Float32Array(PN), tAmp = new Float32Array(PN);
  const rJul = new Float32Array(PN), rJan = new Float32Array(PN), oce = new Float32Array(PN), landSA = new Float32Array(PN);
  const rainNoise = new Float32Array(PN);
  for (let k = 0; k < PN; k++) rainNoise[k] = 0.85 + 0.3 * (fbm3(nRain, px[k], py[k], pz[k], 3, 4) + 0.5);
  // prevailing winds by latitude: trade winds blow west, westerlies east, polar winds west
  const windDir = la => la < 30 ? -1 : la < 60 ? 1 : -1;
  const climate = () => {
    for (let k = 0; k < PN; k++) temp[k] = planetTemp(Math.abs(Math.sin(lat[k])), Math.max(0, elev[k]));
    // Ocean currents. The trade winds and westerlies turn each ocean basin into a gyre: warm water
    // runs poleward up its western side (the Gulf Stream, the Kuroshio) and cold water comes back
    // toward the equator down its eastern side, welling up off the coast (California, Humboldt,
    // Benguela). Further north the warm drift crosses the basin and keeps its far shore mild
    // (Norway), while cold polar water runs down the western side (Labrador). Distances to land are
    // measured along each row: which side of its basin a stretch of sea lies on.
    const dW = new Float32Array(PN), dE = new Float32Array(PN), CAP = 80;
    for (let j = 0; j < PH; j++) {
      for (const [dir, D] of [[1, dW], [-1, dE]]) {
        let d = CAP;
        for (let pass = 0; pass < 2; pass++)
          for (let s = 0; s < PW; s++) {
            const i = dir > 0 ? s : PW - 1 - s, k = j * PW + i;
            d = elev[k] > 0 ? 0 : Math.min(CAP, d + 1);
            if (pass) D[k] = d;
          }
      }
    }
    for (let k = 0; k < PN; k++) {
      if (elev[k] > 0) { sstA[k] = 0; continue; }
      const la = Math.abs(lat[k]) * 180 / Math.PI;
      // (open ocean with no shore within reach either way, like the Southern Ocean, has no gyre)
      const basin = dW[k] < CAP && dE[k] < CAP ? 1 : 0.3;
      const sub = Math.exp(-((la - 27) ** 2) / 120), pol = Math.exp(-((la - 55) ** 2) / 90);
      sstA[k] = basin * (sub * (7 * Math.exp(-dW[k] / 9) - 8 * Math.exp(-dE[k] / 6))
        + pol * (7 * Math.exp(-dE[k] / 14) - 5 * Math.exp(-dW[k] / 8)));
    }
    sstA.set(blurWrap(sstA, 2));
    for (let k = 0; k < PN; k++) if (elev[k] > 0) sstA[k] = 0;
    // oceanity: how much sea air reaches a cell along the prevailing wind. Coasts the wind blows
    // onto stay mild (and take on the warmth or chill of the current offshore); deep continental
    // interiors downwind of a lot of land run colder and swing further between summer and winter
    for (let j = 0; j < PH; j++) {
      const dir = windDir(Math.abs(90 - (j + 0.5) / PH * 180));
      let o = 1, sa = 0;
      for (let pass = 0; pass < 2; pass++)
        for (let s = 0; s < PW; s++) {
          const i = dir > 0 ? s : PW - 1 - s, k = j * PW + i;
          if (elev[k] <= 0) { o = 1; sa = sstA[k]; } else { o *= 0.93; sa *= 0.9; }
          if (pass) { oce[k] = o; landSA[k] = sa; }
        }
    }
    const oceS = blurWrap(oce, 2), saS = blurWrap(landSA, 2);
    for (let k = 0; k < PN; k++) {
      const la = Math.abs(lat[k]) * 180 / Math.PI, f = Math.min(1, Math.max(0, (la - 25) / 30));
      const s = Math.abs(Math.sin(lat[k]));
      if (elev[k] > 0) {
        tAnom[k] = (oceS[k] - 0.45) * 6 * f + saS[k] * 0.8;
        // half the yearly range: a degree or two at the equator, ~20 in a far continental interior
        tAmp[k] = (0.8 + 21 * Math.pow(s, 1.6)) * (0.3 + 0.7 * (1 - oceS[k]));
      } else {
        tAnom[k] = 0;
        tAmp[k] = 0.4 + 6 * Math.pow(s, 1.5);
      }
      temp[k] += tAnom[k];
      sst[k] = elev[k] > 0 ? 0 : Math.max(-1.8, planetTemp(s, 0) + sstA[k]);
    }
    // rain, one season at a time (hs = +1 for July, -1 for January)
    const coldNear = new Float32Array(PN);
    for (let j = 0; j < PH; j++)
      for (let i = 0; i < PW; i++) {
        const k = j * PW + i;
        if (elev[k] <= 0) continue;
        let c = 0;
        for (let d = 1; d <= 4; d++) for (const kk of [j * PW + W(i - d), j * PW + W(i + d)]) if (elev[kk] <= 0) c = Math.min(c, sstA[kk] * (1 - (d - 1) * 0.2));
        coldNear[k] = c;
      }
    for (const [hs, R] of [[1, rJul], [-1, rJan]]) {
      for (let j = 0; j < PH; j++) {
        const phi = 90 - (j + 0.5) / PH * 180, la = Math.abs(phi), dir = windDir(la);
        // the summer hemisphere's storm track sits further poleward and is weaker
        const sum = Math.sign(phi) === hs ? 1 : -1, storm = 52 + 4 * sum;
        let m = 0.5;
        for (let pass = 0; pass < 2; pass++)
          for (let s = 0; s < PW; s++) {
            const i = dir > 0 ? s : PW - 1 - s, k = j * PW + i, kn = j * PW + W(i + dir);
            const e = elev[k];
            // the equatorial rains follow the sun, further over land; the dry belt follows them
            const itcz = (e > 0 ? 12 : 6) * hs, dl = phi - itcz;
            const belt = 0.35 + 0.95 * Math.exp(-((dl - 3 * Math.sign(dl)) ** 2) / 120)
              + (0.75 - 0.12 * sum) * Math.exp(-((la - storm) ** 2) / 160)
              - 0.3 * Math.exp(-((Math.abs(dl) - 27) ** 2) / 50);
            if (e <= 0) {
              const T = sst[k] + tAmp[k] * hs * Math.sign(phi) * 0.6;
              m += (1.2 - m) * 0.08 * Math.max(0.15, (T + 10) / 35); // evaporation from warm seas
              if (pass) R[k] = m * 0.4 * belt;
            } else {
              const rise = Math.max(0, elev[kn] - e);
              // windward slopes wring the air out (less so where the air is sinking in the dry season)
              const r = Math.min(m, m * (0.035 * belt + rise * 2.6));
              m -= r * 0.9;
              // cold water offshore chills the air from below, so it holds its water: the coasts
              // beside the upwelling currents are fog deserts (the Atacama, the Namib)
              if (pass) R[k] = (r * 14 * Math.min(1.1, 0.25 + 0.75 * belt) + m * 0.18 * belt) * Math.max(0.4, 1 + 0.11 * coldNear[k]);
            }
          }
      }
      // rain also spreads north and south a little
      const r2 = blurWrap(R, 2);
      for (let k = 0; k < PN; k++) R[k] = Math.max(0, r2[k]) * rainNoise[k] * 1.3;
    }
    for (let k = 0; k < PN; k++) rain[k] = (rJul[k] + rJan[k]) * 0.5;
  };
  climate();

  // ---- 3. erosion ----
  const heap = makeHeap(PN);
  const fill = new Float32Array(PN), order = new Int32Array(PN), recv = new Int32Array(PN), acc = new Float32Array(PN);
  const done = new Uint8Array(PN), jit = new Float32Array(PN);
  for (let k = 0; k < PN; k++) jit[k] = rnd();
  const flood = () => {
    // priority flood from the sea: every land cell drains to the ocean along a path that never
    // climbs; basins are filled flat (those become lakes)
    done.fill(0); heap.clear();
    let n = 0;
    for (let k = 0; k < PN; k++) if (elev[k] <= 0) { fill[k] = elev[k]; done[k] = 1; heap.push(k, elev[k]); recv[k] = -1; }
    while (heap.size) {
      const k = heap.pop(); order[n++] = k;
      const i = k % PW, j = (k - i) / PW, f = fill[k];
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= PH) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const kk = jj * PW + W(i + di);
          if (done[kk]) continue;
          done[kk] = 1;
          fill[kk] = Math.max(elev[kk], f + 1e-5 * (1 + jit[kk]));
          heap.push(kk, fill[kk]);
        }
      }
    }
    // each cell drains to its steepest lower neighbour, with a little per-cell variation so
    // flow on smooth slopes doesn't lock onto the grid's straight and diagonal lines
    for (let o = 0; o < n; o++) {
      const k = order[o];
      if (elev[k] <= 0) continue;
      const i = k % PW, j = (k - i) / PW, f = fill[k];
      let best = -1, bs = -1;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= PH) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const kk = jj * PW + W(i + di);
          if (fill[kk] >= f) continue;
          const sl = (f - fill[kk]) / (di && dj ? 1.414 : 1) * (0.7 + 0.6 * jit[(kk * 7 + k) % PN]);
          if (sl > bs) { bs = sl; best = kk; }
        }
      }
      recv[k] = best;
    }
    return n;
  };
  // Glaciers: below freezing, ice rather than rain does the carving. It follows the same
  // valleys but is wide and slow, so it deepens them with little regard for how much water
  // they gather and planes the floor and walls into a U: broad troughs instead of gullies.
  const sinLat = new Float32Array(PN), ice = new Float32Array(PN);
  for (let k = 0; k < PN; k++) sinLat[k] = Math.abs(Math.sin(lat[k]));
  const ITER = 40, KT = globalThis.__KT ?? 0.05;
  const pre = new Float32Array(PN), qs = new Float32Array(PN), dep = new Float32Array(PN);
  for (let it = 0; it < ITER; it++) {
    // halfway through, the wind and rain are worked out again over the mountains as they now stand
    if (it === ITER >> 1) climate();
    for (let k = 0; k < PN; k++) ice[k] = elev[k] > 0 ? Math.min(1, Math.max(0, -(planetTemp(sinLat[k], elev[k]) + tAnom[k]) / 6)) : 0;
    if (it % 4 === 0) progress('Eroding valleys', 0.3 + 0.55 * it / ITER);
    const n = flood();
    // flow accumulation from the summits down
    for (let k = 0; k < PN; k++) acc[k] = elev[k] > 0 ? rain[k] : 0;
    for (let o = n - 1; o >= 0; o--) { const k = order[o], r = recv[k]; if (r >= 0) acc[r] += acc[k]; }
    // implicit stream-power incision (Braun & Willett) from the outlets up, plus tectonic uplift
    const K = 0.012, dt = 1;
    for (let o = 0; o < n; o++) {
      const k = order[o], r = recv[k];
      if (r < 0 || elev[k] <= 0) { pre[k] = elev[k]; continue; }
      elev[k] = Math.max(elev[k] + uplift[k] * 0.012 * dt, Math.min(elev[k], 0.03));
      pre[k] = elev[k];
      // lake floor: no incision, and fine mud settles out of the still water, so most basins end
      // up as flat lake plains instead of inland seas (the deep rift basins keep their long lakes)
      if (fill[k] > elev[k] + 1e-4) { elev[k] += (fill[k] - elev[k]) * 0.035 * (1 - 0.85 * Math.min(1, rift[k] * 2)); continue; }
      const dx = (k % PW) !== (r % PW) && Math.floor(k / PW) !== Math.floor(r / PW) ? 1.414 : 1;
      const f = K * dt * (Math.sqrt(acc[k]) * (1 - 0.6 * ice[k]) + ice[k] * 1.6 * Math.pow(acc[k], 0.25)) / dx;
      const base = volc[k] ? Math.max(fill[r], 0) : fill[r];
      const nh = (elev[k] + f * base) / (1 + f);
      elev[k] = Math.max(nh, base + 1e-5);
    }
    // Sediment: what the streams wear away is carried on downstream, as much as the stream can
    // move (more water and a steeper bed carry more), and the rest is dropped. So gravel fans spread
    // where steep streams leave the mountains, rivers build up their own floodplains on the
    // lowlands, lakes fill in from where the rivers enter, and a river reaching the sea pushes
    // a delta out over the shallow shelf.
    qs.fill(0);
    for (let o = n - 1; o >= 0; o--) {
      const k = order[o], r = recv[k];
      if (elev[k] <= 0 || r < 0) continue;
      let q = qs[k] + Math.max(0, pre[k] - elev[k]);
      if (fill[k] > elev[k] + 1e-4) {
        const d = Math.min(q, (fill[k] - elev[k]) * 0.5) * (1 - 0.85 * Math.min(1, rift[k] * 2));
        elev[k] += d; dep[k] += d; q -= d;
      } else if (!volc[k]) {
        const dx = (k % PW) !== (r % PW) && Math.floor(k / PW) !== Math.floor(r / PW) ? 1.414 : 1;
        const cap = KT * Math.sqrt(acc[k]) * Math.max(0, elev[k] - Math.max(elev[r], 0)) / dx;
        if (q > cap) { const d = Math.min((q - cap) * 0.5, 0.01); elev[k] += d; dep[k] += d; q -= d; }
      }
      if (elev[r] > 0) qs[r] += q;
      else if (elev[r] > -0.15) {
        // at the coast: some settles on the shelf at the mouth, the rest the sea sweeps away
        const d = Math.min(q * 0.3, 0.004 - elev[r]);
        if (d > 0) { elev[r] += d; dep[r] += d; }
      }
    }
    // hillslope creep softens the ridges a little
    if (it % 2 === 1) {
      const sm = blurWrap(elev, 1);
      for (let k = 0; k < PN; k++) if (elev[k] > 0 && !volc[k]) elev[k] += (sm[k] - elev[k]) * (0.25 + 0.3 * ice[k]);
    }
  }

  // ---- 4. final drainage, lakes, rivers and biomes ----
  progress('Filling lakes and tracing rivers', 0.88);
  const area = new Float32Array(PN);
  const accumulate = n => {
    for (let k = 0; k < PN; k++) { acc[k] = elev[k] > 0 ? rain[k] : 0; area[k] = elev[k] > 0 ? 1 : 0; }
    for (let o = n - 1; o >= 0; o--) { const k = order[o], r = recv[k]; if (r >= 0) { acc[r] += acc[k]; area[r] += area[k]; } }
  };
  let n = flood();
  accumulate(n);
  // Deltas: where a big river meets the sea, the last few cells are low, flat sediment plains
  const mouthOf = () => {
    const m = [];
    for (let k = 0; k < PN; k++) { const r = recv[k]; if (r >= 0 && elev[k] > 0 && elev[r] <= 0 && acc[k] >= DELTA_MIN) m.push(k); }
    return m;
  };
  for (const k of mouthOf()) {
    const i0 = k % PW, j0 = (k - i0) / PW, R = acc[k] >= DELTA_MIN * 3 ? 4 : 3;
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const j = j0 + dj, d = Math.hypot(di, dj);
        if (j < 0 || j >= PH || d > R) continue;
        const kk = j * PW + W(i0 + di);
        if (elev[kk] > 0 && elev[kk] < 0.35) elev[kk] = Math.min(elev[kk], 0.004 + d * 0.006);
      }
  }
  n = flood();
  accumulate(n);
  // Streams running side by side down the same slope join the bigger one early, so channels
  // only split where the ground actually divides them (and in deltas)
  for (let o = n - 1; o >= 0; o--) {
    const k = order[o];
    if (elev[k] <= 0 || acc[k] < RIVER_MIN_PLANET || area[k] < RIVER_AREA) continue;
    const i = k % PW, j = (k - i) / PW;
    let best = -1, ba = acc[k] * 2;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const jj = j + dj;
      if ((!di && !dj) || jj < 0 || jj >= PH) continue;
      const kk = jj * PW + W(i + di);
      if (kk === recv[k] || recv[kk] === k || fill[kk] >= fill[k] || elev[kk] <= 0) continue;
      if (acc[kk] > ba) { ba = acc[kk]; best = kk; }
    }
    if (best >= 0) recv[k] = best;
  }
  for (let k = 0; k < PN; k++) {
    temp[k] = planetTemp(sinLat[k], elev[k]) + tAnom[k];
    ice[k] = elev[k] > 0 ? Math.min(1, Math.max(0, -temp[k] / 6)) : 0;
  }
  // Water budget. Not all the rain reaches the sea: the warmer and drier the land, the more of it
  // the air takes back. Streams crossing dry country soak away into their beds, and a basin with
  // no outlet holds a lake only as big as its inflow can keep topped up against evaporation from
  // its surface. Where that falls short the lake shrinks below its rim, or dries out into a flat
  // salt pan, and nothing flows on out of the basin.
  // (evaporation in the same units as rain: from open water, and the most the land could give up)
  const petW = T => 0.02 * Math.max(0, T + 5), petL = T => 0.004 * Math.max(1, T + 5);
  const arid = new Float32Array(PN), moist = new Float32Array(PN);
  for (let k = 0; k < PN; k++) {
    if (elev[k] <= 0) { moist[k] = 1; continue; }
    const ai = rain[k] / petL(temp[k] + 0.5 * tAmp[k]);
    arid[k] = Math.min(1, Math.max(0, 1 - ai));
    moist[k] = ai / (1 + ai);
  }
  // the lakes: connected stretches of water standing in filled basins
  const lakeId = new Int32Array(PN).fill(-1), lakes = [];
  const isLakeCell = k => elev[k] > 0 && fill[k] - elev[k] > 0.004;
  for (let k0 = 0; k0 < PN; k0++) {
    if (lakeId[k0] >= 0 || !isLakeCell(k0)) continue;
    const id = lakes.length, cells = [k0];
    lakeId[k0] = id;
    for (let q = 0; q < cells.length; q++) {
      const k = cells[q], i = k % PW, j = (k - i) / PW;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj;
        if ((!di && !dj) || jj < 0 || jj >= PH) continue;
        const kk = jj * PW + W(i + di);
        if (lakeId[kk] < 0 && isLakeCell(kk) && Math.abs(fill[kk] - fill[k]) < 1e-3) { lakeId[kk] = id; cells.push(kk); }
      }
    }
    let T = 0;
    for (const k of cells) T += temp[k] + 0.5 * tAmp[k];
    lakes.push({ cells, T: T / cells.length, Q: 0, keep: 1 });
  }
  // inflow to each lake, passing on only what's left over downstream (a few rounds, so lakes
  // that drain into other lakes settle)
  for (let pass = 0; pass < 3; pass++) {
    for (const L of lakes) L.Q = 0;
    for (let k = 0; k < PN; k++) { acc[k] = elev[k] > 0 ? rain[k] * (1 - 0.6 * arid[k]) : 0; area[k] = elev[k] > 0 ? 1 : 0; }
    for (let o = n - 1; o >= 0; o--) {
      const k = order[o], r = recv[k];
      if (r < 0) continue;
      let a = acc[k];
      const id = lakeId[k];
      if (id >= 0 && lakeId[r] !== id) { lakes[id].Q += a; a *= lakes[id].keep; }
      else if (id < 0) a *= 1 - arid[k] * (0.02 + 0.1 / (1 + acc[k] / 5));
      acc[r] += a; area[r] += area[k];
    }
    for (const L of lakes) { const E = petW(L.T) * L.cells.length; L.keep = L.Q > E ? (L.Q - E) / L.Q : 0; }
  }
  const lake = new Float32Array(PN); // lake surface elevation, 0 = none
  const salt = new Uint8Array(PN), basin = new Uint8Array(PN);
  for (const L of lakes) {
    const E = petW(L.T) * L.cells.length;
    if (L.Q >= E) { for (const k of L.cells) lake[k] = fill[k]; continue; }
    // a closed lake: it covers only as many cells as its inflow can keep wet
    const beds = L.cells.slice().sort((a, b) => elev[a] - elev[b]);
    const m = Math.floor(L.Q / Math.max(1e-6, petW(L.T)));
    const top = fill[beds[0]];
    const lv = m >= 1 ? Math.min(top, elev[beds[Math.min(m, beds.length) - 1]] + 0.006) : 0;
    for (const k of beds) {
      if (lv && elev[k] < lv - 0.002) lake[k] = lv;
      else basin[k] = 1;
    }
    // the dry floor around a shrunken or vanished lake in warm country is crusted with salt
    if (L.T > 2) {
      const ns = Math.ceil(beds.length * 0.45) + m;
      for (let q = 0; q < Math.min(ns, beds.length); q++) if (basin[beds[q]]) salt[beds[q]] = 1;
    }
  }
  const mouths = mouthOf();
  const biome = new Uint8Array(PN);
  // Biomes from how warm and how wet a place is, and from when its rain falls. Effective moisture:
  // heat evaporates rain, so hot lands need more of it. The thresholds are fixed amounts (about the
  // driest tenth, quarter, 40% and half of the land on an Earth-like planet), so a planet with big
  // dry interiors really does have more desert.
  const eff = new Float32Array(PN);
  for (let k = 0; k < PN; k++) eff[k] = rain[k] / (0.7 + 0.03 * Math.max(0, temp[k]));
  const r10 = 0.002, r25 = 0.014, r40 = 0.044, q50 = 0.08;
  for (let k = 0; k < PN; k++) {
    const t = temp[k], r = eff[k];
    // rain in the local summer and winter half of the year
    const north = lat[k] >= 0, rs = north ? rJul[k] : rJan[k], rw = north ? rJan[k] : rJul[k];
    const dry = Math.min(rs, rw) / Math.max(1e-6, Math.max(rs, rw));
    let b;
    if (elev[k] <= 0) b = t < -6 ? BIOME.ICE : BIOME.OCEAN;
    else if (salt[k] && t > 2) b = BIOME.DESERT;
    else if (t < -8) b = BIOME.ICE;
    else if (t < -1) b = BIOME.TUNDRA;
    else if (t < 6) b = BIOME.TAIGA;
    else if (r < r10) b = t > 14 ? BIOME.DESERT : BIOME.GRASS;
    // warm lands where the storms only bring rain in winter: Mediterranean scrub and evergreen oak
    else if (t >= 11 && t < 21 && rs < 0.45 * rw && r < q50 * 3) b = BIOME.SCRUB;
    // the drier half of the open plains is grassland: prairie and meadow with scattered trees
    else if (t < 20) b = r < r25 || (plain[k] > 0.5 && r < q50) ? BIOME.GRASS : BIOME.AUTUMN;
    // the tropics: rainforest where it rains all year, savanna where the rains come in one season
    // or are too light for closed forest
    else b = r < r25 ? BIOME.DESERT : r < r40 || (dry < 0.3 && r < q50 * 4) ? BIOME.SAVANNA : BIOME.WARM;
    biome[k] = b;
  }
  progress('Done', 1);
  return { elev, fill, lake, acc, area, recv, rain, temp, biome, plate, mouths, ice, plain, sst, tAmp, rJul, rJan, dep, moist, salt, basin };
}

// mean temperature from latitude (sin) and height, roughly Earth-like
const planetTemp = (s, e) => 28 - 40 * Math.pow(s, 2.5) - 5 * Math.max(0, e);

function blurWrap(src, r) {
  const tmp = new Float32Array(PN), out = new Float32Array(PN), n = 2 * r + 1;
  for (let j = 0; j < PH; j++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[j * PW + ((i + PW) % PW)];
    for (let i = 0; i < PW; i++) {
      tmp[j * PW + i] = s / n;
      s += src[j * PW + (i + r + 1) % PW] - src[j * PW + ((i - r) % PW + PW) % PW];
    }
  }
  for (let i = 0; i < PW; i++)
    for (let j = 0; j < PH; j++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) { const jj = j + d; if (jj < 0 || jj >= PH) continue; s += tmp[jj * PW + i]; c++; }
      out[j * PW + i] = s / c;
    }
  return out;
}

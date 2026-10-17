// Emberwood weather: a moisture and wind simulation on the planet grid around the player.
// Prevailing winds by latitude and drifting storm systems carry water vapour. Air that is forced
// up a mountainside, drawn into a storm's core or heated over warm land cools, its vapour
// condenses into cloud, and thick cloud rains out. In the lee of mountains the air sinks, warms
// and the cloud evaporates again. The cloud field is uploaded as a texture that a raymarcher
// shapes into 3D clouds, and that the terrain reads for cloud shadows.
// Cloud types follow from why the air rose: gentle, widespread lift gives flat stratus sheets,
// warm land gives cumulus, strong storm cores and hot afternoons tower into cumulonimbus that
// spread an anvil under the tropopause and throw lightning. High cirrus is a separate thin layer
// fed by anvil outflow and by the moist air ahead of storms, carried by the faster upper winds.
const CLOUD_N = 128;                 // simulated cells per side; one planet cell is 16 blocks
const CLOUD_BASE = 150, CLOUD_TOP = 236, CLOUD_ADV = 0.3; // advection: cells per second per unit of wind

function createWeather(gl) {
  const N = CLOUD_N, NN = N * N, PWc = 512, PHc = 256, PC = 16;
  let q = new Float32Array(NN), c = new Float32Array(NN), q2 = new Float32Array(NN), c2 = new Float32Array(NN);
  const u = new Float32Array(NN), v = new Float32Array(NN), lift = new Float32Array(NN), tops = new Float32Array(NN);
  const hgt = new Float32Array(NN), tmp = new Float32Array(NN), sea = new Uint8Array(NN), wet = new Float32Array(NN);
  const rainOut = new Float32Array(NN), cvt = new Float32Array(NN), ciSrc = new Float32Array(NN), shield = new Float32Array(NN);
  let ci = new Float32Array(NN), ci2 = new Float32Array(NN);
  // ta: how much warmer or colder the air is than the planet's climate (°C), carried by the wind:
  // warm sectors and cold air behind fronts. taF: what the fronts push it toward. fg: low fog
  // (sea fog that drifts ashore, radiation fog over land), also carried by the wind.
  let ta = new Float32Array(NN), ta2 = new Float32Array(NN), fg = new Float32Array(NN), fg2 = new Float32Array(NN);
  const taF = new Float32Array(NN), coldSea = new Float32Array(NN), strat = new Float32Array(NN);
  // snow on the ground, per cell and fixed to the land (not carried by the wind): sn how much fresh
  // snow lies there (0..1) and snE the height its lower edge has reached (it falls down to where the
  // air is near freezing and melts back uphill in warm air and sun)
  const sn = new Float32Array(NN), snE = new Float32Array(NN), sn2 = new Float32Array(NN), snE2 = new Float32Array(NN);
  // soil moisture (0..1), also fixed to the land: rain soaks it, sun and wind dry it, and wet ground
  // gives more vapour back to the air. cape: instability stored up by the sun heating moist ground,
  // spent by the thunderstorms it sets off. Both are shifted with the grid like the snow.
  const sm = new Float32Array(NN), sm2 = new Float32Array(NN), cape = new Float32Array(NN), cape2 = new Float32Array(NN);
  // pressure: pr the local departure (hPa) made by warm and cold air (sea breezes, cold pools, warm
  // sectors), pu/pv the wind it drives, lh the latent heat being released by condensation (per s),
  // hB the ground height smoothed over a few cells (ridges stick out of it, valleys sit below)
  const pr = new Float32Array(NN), pu = new Float32Array(NN), pv = new Float32Array(NN), lh = new Float32Array(NN);
  const hB = new Float32Array(NN), wrk = new Float32Array(NN), wrk2 = new Float32Array(NN);
  // thunderstorm cells: each grows, rains and collapses into a cold pool whose edge sets off new ones
  let cells = [];
  const px = new Uint8Array(NN * 4), px2 = new Uint8Array(NN * 2), px3 = new Uint8Array(NN * 4);
  // lightning: candidate thunderstorm cells and the strike currently flashing
  let cbCells = [], cbW = 0, clock = 0, strike = null;
  let ox = 0, oz = 0, pl = null, storms = [], acc = 0, simT = 0, seasonOff = 0, ready = false;
  const mean = [0, 0];
  const smooth01 = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

  // ---- GPU resources: the cloud map and a tiling 3D noise for the cloud shapes ----
  // Each map is kept twice: the last two simulation steps. The field steps four times a second and
  // the shaders cross-fade from the older map to the newer one in between, so cloud cover changes
  // smoothly instead of popping at every step.
  const mkMap = (fmt, ifmt, src, mip) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, N, N, 0, fmt, gl.UNSIGNED_BYTE, src);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  // map: R cover, G tops, B rain; map2: R = cirrus, G = how convective the cloud is (0 stratus .. 1 cumulonimbus)
  const maps = [mkMap(gl.RGBA, gl.RGBA8, px, true), mkMap(gl.RGBA, gl.RGBA8, px, true)];
  const maps2 = [mkMap(gl.RG, gl.RG8, px2, true), mkMap(gl.RG, gl.RG8, px2, true)];
  // snow map: R the height (/2) above which the season's snow lies, G the lower edge (/2) of fresh
  // snow, B how much fresh snow; it stays put on the land, so it has its own origin
  const snowMap = mkMap(gl.RGBA, gl.RGBA8, px3, false);
  let snowO = [0, 0];
  let cur = 0, lastDt = 0.25;
  // grid origin and mean wind each map was made with
  const mapO = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const noise = gl.createTexture();
  {
    // R: tiling value-noise fbm, G: inverted Worley (billows), both tiling once over the texture.
    // 64 texels across (it was 32, which looked soft and blocky up close) with one more octave
    // of each for the small detail on cloud edges
    const S = 64, out = new Uint8Array(S * S * S * 2);
    let seed = 9127;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const lat = (n) => { const a = new Float32Array(n * n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
    const L4 = lat(4), L8 = lat(8), L16 = lat(16), L32 = lat(32);
    const vn = (L, n, x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
      const g = (a, b, c) => L[(((c % n) + n) % n * n + ((b % n) + n) % n) * n + ((a % n) + n) % n];
      const l = (a, b, t) => a + (b - a) * t;
      return l(l(l(g(xi, yi, zi), g(xi + 1, yi, zi), sx), l(g(xi, yi + 1, zi), g(xi + 1, yi + 1, zi), sx), sy),
        l(l(g(xi, yi, zi + 1), g(xi + 1, yi, zi + 1), sx), l(g(xi, yi + 1, zi + 1), g(xi + 1, yi + 1, zi + 1), sx), sy), sz);
    };
    const worley = (F, fp, x, y, z) => {
      const cx = x * F, cy = y * F, cz = z * F;
      const ix = Math.floor(cx), iy = Math.floor(cy), iz = Math.floor(cz);
      let d = 9;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
        const gx = ix + a, gy = iy + b, gz = iz + e;
        const p = fp[((((gz % F) + F) % F) * F + (((gy % F) + F) % F)) * F + (((gx % F) + F) % F)];
        const dx = gx + p[0] - cx, dy = gy + p[1] - cy, dz = gz + p[2] - cz, dd = dx * dx + dy * dy + dz * dz;
        if (dd < d) d = dd;
      }
      return Math.sqrt(d);
    };
    const pts = n => { const a = []; for (let i = 0; i < n ** 3; i++) a.push([rnd(), rnd(), rnd()]); return a; };
    const fp5 = pts(5), fp11 = pts(11);
    for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (z * S + y) * S + x;
      const f = vn(L4, 4, x / 16, y / 16, z / 16) * 0.5 + vn(L8, 8, x / 8, y / 8, z / 8) * 0.27 +
        vn(L16, 16, x / 4, y / 4, z / 4) * 0.15 + vn(L32, 32, x / 2, y / 2, z / 2) * 0.08;
      const u = x / S, v = y / S, w = z / S;
      const bill = Math.max(0, 1 - worley(5, fp5, u, v, w) * 1.1) * 0.72 + Math.max(0, 1 - worley(11, fp11, u, v, w) * 1.1) * 0.28;
      out[i * 2] = Math.round(Math.min(1, Math.max(0, (f - 0.2) / 0.6)) * 255);
      out[i * 2 + 1] = Math.round(Math.min(1, bill) * 255);
    }
    gl.bindTexture(gl.TEXTURE_3D, noise);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, S, S, S, 0, gl.RG, gl.UNSIGNED_BYTE, out);
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  }

  // 2D cloud texture for the sky layer, tiling, 256 texels: R broad fbm, G big inverted-Worley billows,
  // B finer fbm, A small billows. Mipmapped so distant cloud is filtered, not aliased.
  const tex2 = gl.createTexture();
  {
    const S = 256, out = new Uint8Array(S * S * 4);
    let seed = 4721;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const lat = n => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
    const vn = (L, n, x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const g = (a, b) => L[(((b % n) + n) % n) * n + (((a % n) + n) % n)];
      return (g(xi, yi) * (1 - sx) + g(xi + 1, yi) * sx) * (1 - sy) + (g(xi, yi + 1) * (1 - sx) + g(xi + 1, yi + 1) * sx) * sy;
    };
    const fbm = (o0, oN, x, y) => { let v = 0, w = 0, a = 1; for (let o = o0; o < oN; o++) { const n = 4 << o; v += vn(LS[o], n, x * n, y * n) * a; w += a; a *= 0.55; } return v / w; };
    const LS = []; for (let o = 0; o < 7; o++) LS.push(lat(4 << o));
    const pts = F => { const a = []; for (let i = 0; i < F * F; i++) a.push([rnd(), rnd()]); return a; };
    const worley = (F, fp, x, y) => {
      const cx = x * F, cy = y * F, ix = Math.floor(cx), iy = Math.floor(cy);
      let d = 9;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const gx = ix + a, gy = iy + b, q = fp[(((gy % F) + F) % F) * F + (((gx % F) + F) % F)];
        const dx = gx + q[0] - cx, dy = gy + q[1] - cy;
        d = Math.min(d, dx * dx + dy * dy);
      }
      return Math.sqrt(d);
    };
    const f6 = pts(6), f13 = pts(13), f24 = pts(24), f47 = pts(47);
    const c01 = v => Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, i = (y * S + x) * 4;
      out[i] = c01((fbm(0, 5, u, v) - 0.22) / 0.56);
      // billows use the squared cell distance: round-topped bumps (plain distance makes cones,
      // which stood up as pointed fins once the clouds got height)
      const bw = (F, fp) => Math.max(0, 1 - (worley(F, fp, u, v) * 1.15) ** 2);
      out[i + 1] = c01(bw(6, f6) * 0.7 + bw(13, f13) * 0.3);
      out[i + 2] = c01((fbm(2, 7, u, v) - 0.2) / 0.6);
      out[i + 3] = c01(bw(24, f24) * 0.65 + bw(47, f47) * 0.35);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  // mean cloud cover of the whole map, used for sky beyond the map's edge
  let meanCover = 0.3, maxRain = 0, soilWet = 0;

  // ---- climate inputs ----
  const qsat = T => 0.5 * Math.exp(0.065 * T);
  const cellK = (gi, gj) => Math.min(PHc - 1, Math.max(0, gj)) * PWc + (((gi % PWc) + PWc) % PWc);
  const latDeg = gj => 90 - (gj + 0.5) / PHc * 180;
  function seasonTemp(gj) {
    // the chosen season is the player's own (as for the sun): summer warms the player's
    // hemisphere and cools the other one, winter the other way round
    const n = (latDeg(gj) >= 0 ? 1 : -1) * (latDeg(oz + (N >> 1)) >= 0 ? 1 : -1);
    return seasonOff * n * Math.min(1, Math.abs(latDeg(gj)) / 30);
  }
  // the daily cycle: how strongly the sun heats the land right now (0 at night, 1 early afternoon),
  // and how far the air is above or below its daily mean (warmest mid-afternoon, coldest before dawn)
  const dayHeat = () => { const t = api.tod; return t > 8.5 && t < 18.5 ? Math.sin(Math.PI * (t - 8.5) / 10) : 0; };
  const dayTemp = () => Math.cos(2 * Math.PI * (api.tod - 15) / 24);
  function equilibrium(gi, gj) {
    const k = cellK(gi, gj), T = pl.tmp[k] + seasonTemp(gj) + api.temp;
    const s = pl.L.elev[k] <= 0 || pl.ys[k] < 30;
    return (s ? 0.82 : 0.45 + 0.35 * Math.min(1, pl.L.rain[k] / 2)) * qsat(T) * api.humid;
  }
  function prevailing(gj, out) {
    const la = latDeg(gj), a = Math.abs(la), hem = la >= 0 ? 1 : -1;
    // trades blow west and toward the equator, westerlies east and poleward, polar easterlies west
    let ux, uz;
    if (a < 30) { ux = -1; uz = 0.35 * hem; }
    else if (a < 60) { ux = 1.15; uz = -0.25 * hem; }
    else { ux = -0.7; uz = 0.2 * hem; }
    const edge = Math.min(Math.abs(a - 30), Math.abs(a - 60)), calm = Math.min(1, edge / 6);
    out[0] = ux * (0.35 + 0.65 * calm); out[1] = uz;
  }
  function seedStorms(seed) {
    let s = (seed * 2654435761) >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    storms = [];
    for (let i = 0; i < 46; i++) storms.push(newStorm(rnd, true));
    storms.rnd = rnd;
    // a storm seeded part-way through its life starts at the strength its fuel allows
    for (const st of storms) st.k = stormTarget(st);
  }
  function newStorm(rnd, anywhere) {
    // lows form mostly in the storm tracks around 40-60 degrees, a few over the warm tropics
    const trop = rnd() < 0.25;
    let la = (trop ? 8 + rnd() * 14 : 38 + rnd() * 24) * (rnd() < 0.5 ? 1 : -1), x = rnd() * PWc;
    // tropical storms are born over warm sea: try a few spots until one is
    if (trop && pl) for (let t = 0; t < 12; t++) {
      const gj = Math.floor((90 - la) / 180 * PHc), k = cellK(Math.floor(x), gj);
      if (isSeaK(k) && seaTemp(k, gj) > 25.5) break;
      la = (8 + rnd() * 14) * (rnd() < 0.5 ? 1 : -1); x = rnd() * PWc;
    }
    // mid-latitude lows carry a warm and a cold front; tropical ones are round. k is how deep the
    // low is right now (0..1.5): it follows what the storm can feed on, not a clock.
    return { x, z: (90 - la) / 180 * PHc, r: (trop ? 4 : 7) + rnd() * (trop ? 4 : 9),
      s: 0.8 + rnd() * 0.7, age: anywhere ? rnd() * 0.85 : 0, life: 0.6 + rnd() * 0.8, fronts: !trop, k: 0 };
  }
  // seconds per unit of storm age: a storm lives 0.6-1.4 units, about one to two game days
  const stormT = () => Math.max(600, api.dayLen) * 1.4;
  const strOf = s => s.s * s.k * api.stormMul;
  // sea-surface temperature: the planet's own if it has one, otherwise the air above the sea
  const seaTemp = (k, gj) => (pl.L.sst ? pl.L.sst[k] + seasonTemp(gj) * 0.5 : pl.tmp[k] + seasonTemp(gj)) + api.temp;
  const isSeaK = k => pl.L.elev[k] <= 0 || pl.ys[k] < 30;
  // What a storm lives on. A tropical storm draws its energy from warm sea (it needs about 26 °C)
  // and dies within hours of landfall. A mid-latitude low feeds on the contrast between polar and
  // tropical air across the storm track, deepens over the moist ocean, and runs through a life
  // cycle: it deepens for its first third, then occludes and fills. Near the player the latent heat
  // actually being released under the storm deepens it further.
  function stormTarget(s) {
    const gi = Math.floor(s.x), gj = Math.max(0, Math.min(PHc - 1, Math.floor(s.z)));
    const R = Math.max(2, Math.round(s.r * 0.6));
    let seaN = 0, sst = 0, n = 0;
    for (let dj = -R; dj <= R; dj += 2) for (let di = -R; di <= R; di += 2) {
      const k = cellK(gi + di, gj + dj); n++;
      if (isSeaK(k)) { seaN++; sst += seaTemp(k, gj + dj); }
    }
    const sea = seaN / n, T = seaN ? sst / seaN : 0;
    let f;
    if (!s.fronts) f = 1.45 * smooth01((T - 24.5) / 4.5) * sea * sea;
    else {
      const tN = pl.tmp[cellK(gi, gj - 8)] + seasonTemp(gj - 8), tS = pl.tmp[cellK(gi, gj + 8)] + seasonTemp(gj + 8);
      const baro = Math.min(1.3, Math.abs(tN - tS) / 12);
      const a = s.age / s.life;
      f = (0.35 + 0.65 * baro) * (0.7 + 0.5 * sea) * smooth01(a / 0.3 + 0.15) * (1 - smooth01((a - 0.55) / 0.45));
    }
    // latent heat released under the storm, where the grid covers it
    const ci0 = Math.round(s.x - ox), cj0 = Math.round(s.z - oz);
    if (ci0 > 2 && cj0 > 2 && ci0 < N - 3 && cj0 < N - 3) {
      let L = 0, m = 0;
      for (let dj = -R; dj <= R; dj += 2) for (let di = -R; di <= R; di += 2) {
        const i = ci0 + di, j = cj0 + dj;
        if (i >= 0 && j >= 0 && i < N && j < N) { L += lh[j * N + i]; m++; }
      }
      f *= 1 + Math.min(0.45, (m ? L / m : 0) * LH_FEED);
    }
    return f;
  }
  const LH_FEED = 2.5;
  function staticFields() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i, gi = ox + i, gj = oz + j, k = cellK(gi, gj);
      hgt[n] = Math.max(30, pl.ys[k]);
      tmp[n] = pl.tmp[k] + seasonTemp(gj) + api.temp;
      sea[n] = pl.L.elev[k] <= 0 || pl.ys[k] < 30 ? 1 : 0;
      // how wet the ground usually is: the planet's water balance (rain against evaporation) if it
      // has one, otherwise its rainfall
      wet[n] = pl.L.moist ? Math.min(1, pl.L.moist[k]) : Math.min(1, pl.L.rain[k] / 2);
      // cold currents run up the west coasts of the subtropics (the planet makes those coasts
      // fog deserts): sea within a few cells west of land at 14-38 degrees is cold and breeds fog
      coldSea[n] = 0;
      const la = Math.abs(latDeg(gj));
      if (sea[n] && la > 12 && la < 40) {
        for (let d = 1; d <= 6; d++) {
          const kk = cellK(gi + d, gj);
          if (pl.L.elev[kk] > 0 && pl.ys[kk] >= 30) { coldSea[n] = Math.sin((la - 12) / 28 * Math.PI) * (1 - (d - 1) / 6); break; }
        }
      }
      // over the sea the surface temperature is what storms and showers feel
      if (sea[n] && pl.L.sst) tmp[n] = seaTemp(k, gj);
      if (sm[n] < 0) sm[n] = wet[n];
    }
    blur(hgt, hB, 3);
  }
  // box blur of a grid field, radius r cells, clamped at the edges (src and dst may not be the same)
  function blur(src, dst, r) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let t = 0, m = 0;
      for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < N) { t += src[j * N + ii]; m++; } }
      wrk2[j * N + i] = t / m;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let t = 0, m = 0;
      for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < N) { t += wrk2[jj * N + i]; m++; } }
      dst[j * N + i] = t / m;
    }
  }
  function fillEquilibrium() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const n = j * N + i; q[n] = equilibrium(ox + i, oz + j) * 0.9; c[n] = 0; ci[n] = 0; ta[n] = 0; fg[n] = 0; sn[n] = 0; snE[n] = 999; sm[n] = wet[n]; cape[n] = 0; lh[n] = 0; pr[n] = 0; pu[n] = 0; pv[n] = 0; }
    cells = [];
  }
  function centreOn(x, z) {
    return [Math.floor(x / PC) - (N >> 1), Math.floor(z / PC) - (N >> 1)];
  }

  // ---- thunderstorm cells ----
  // A cell grows for its first third, rains hardest in the middle and collapses in the last third.
  // While it rains, the falling rain cools the air under it into a cold pool; the cold, heavy air
  // makes high pressure that spreads out along the ground as a gust front, and where that pushes
  // into warm, unstable air it lifts it and sets off the next cell.
  const cellI = f => f < 0.35 ? smooth01(f / 0.35) : f < 0.65 ? 1 : 1 - smooth01((f - 0.65) / 0.35);
  function stepCells(dt) {
    for (let k = cells.length - 1; k >= 0; k--) {
      const cl = cells[k];
      cl.age += dt;
      if (cl.age > cl.life) { cells.splice(k, 1); continue; }
      // a cell moves with the wind through its depth: the low-level wind and the faster wind aloft
      const i = Math.round(cl.x - ox), j = Math.round(cl.z - oz);
      if (i < 0 || j < 0 || i >= N || j >= N) { cells.splice(k, 1); continue; }
      const n = j * N + i;
      cl.x += u[n] * 1.3 * dt * CLOUD_ADV; cl.z += v[n] * 1.3 * dt * CLOUD_ADV;
    }
    // new cells: where the stored instability is high and something lifts the air (a hill, a
    // front, sea-breeze convergence, the edge of a cold pool)
    if (cells.length >= 90) return;
    const tries = 160;
    for (let t = 0; t < tries; t++) {
      const n = (Math.random() * NN) | 0, i = n % N, j = (n / N) | 0;
      if (i < 3 || j < 3 || i > N - 4 || j > N - 4) continue;
      const trig = cape[n] * (0.35 + Math.max(0, lift[n]) * 1.6) - 0.1;
      if (trig <= 0 || Math.random() > trig * dt * 0.0016 * NN / tries) continue;
      let near = false;
      for (const o of cells) if ((o.x - ox - i) ** 2 + (o.z - oz - j) ** 2 < 9) { near = true; break; }
      if (near) continue;
      // wind shear (the wind aloft blows harder than at the ground) tilts a storm so its rain
      // doesn't fall into its own updraft: sheared storms live longer
      const shear = Math.min(1, Math.hypot(u[n], v[n]) * 0.6);
      cells.push({ x: ox + i + Math.random(), z: oz + j + Math.random(), age: 0,
        life: (170 + Math.random() * 130) * (1 + 0.6 * shear), s: Math.min(1.2, 0.55 + trig * 1.6), r: 1.4 + Math.random() * 1.2 });
      if (cells.length >= 90) break;
    }
  }
  // stamp the cells into the fields (after winds() has filled lift, tops and cvt)
  function stampCells(dt) {
    for (const cl of cells) {
      const f = cl.age / cl.life, I = cellI(f), ci0 = cl.x - ox - 0.5, cj0 = cl.z - oz - 0.5;
      const R = cl.r * (0.8 + 0.4 * I), W = Math.ceil(R * 2);
      for (let j = Math.max(0, Math.floor(cj0) - W); j <= Math.min(N - 1, Math.ceil(cj0) + W); j++)
        for (let i = Math.max(0, Math.floor(ci0) - W); i <= Math.min(N - 1, Math.ceil(ci0) + W); i++) {
          const n = j * N + i, d2 = ((i - ci0) ** 2 + (j - cj0) ** 2) / (R * R);
          if (d2 > 4) continue;
          const g = Math.exp(-d2);
          // updraft while it grows and matures, downdraft as it collapses
          lift[n] = Math.min(1.6, lift[n] + (f < 0.72 ? I * cl.s * 1.25 : -0.35 * I) * g);
          tops[n] = Math.max(tops[n], (0.45 + 0.55 * cl.s * I) * g);
          cvt[n] = Math.max(cvt[n], Math.min(1, 1.1 * I * g));
          cape[n] = Math.max(0, cape[n] - dt * 0.012 * I * g);
          // rain-cooled air (the cold pool) under the raining part of its life
          if (f > 0.35) { const tgt = -7 * cl.s * I * g; if (ta[n] > tgt) ta[n] += (tgt - ta[n]) * Math.min(1, dt * 0.04); }
        }
    }
  }

  // wind = prevailing flow + storm vortices + the local pressure wind, steered by the ground;
  // lift = slope the wind climbs + storm cores and fronts + warm-land convection + converging air
  // + warm air advancing over cold + latent heat
  const pw = [0, 0];
  function winds(dt) {
    const near = storms.filter(s => {
      let dx = s.x - (ox + N / 2); dx -= Math.round(dx / PWc) * PWc;
      return Math.abs(dx) < N / 2 + s.r * 4 && Math.abs(s.z - (oz + N / 2)) < N / 2 + s.r * 4;
    });
    // land convection follows the sun: nothing at night, building through the morning, strongest
    // in the early afternoon, so cumulus grow toward midday and thunderstorms come late in the day
    const dH = dayHeat(), heat = 0.15 + 1.45 * dH, dT = dayTemp();
    // Local pressure. Warm air is light and cold air heavy, so sunny land by day, warm sectors and
    // latent heat make low pressure, and night land, cold pools and the air behind cold fronts make
    // high pressure. It is spread over a few cells, like the air column above. The wind it drives
    // blows down the pressure slope, turned a little by the earth's spin (right in the north, left
    // in the south): this gives sea breezes on sunny afternoons, land breezes at night and the
    // gust fronts of thunderstorms.
    for (let n = 0; n < NN; n++) { const cl = Math.min(1, c[n] * 2.6); wrk[n] = -0.45 * (ta[n] + dT * (sea[n] ? 0.6 : 4.5 * (1 - 0.6 * cl))); }
    blur(wrk, pr, 2);
    const hemG = oz + N / 2 < PHc / 2 ? 1 : -1, rs = 0.35 * hemG, rc = Math.sqrt(1 - rs * rs);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      const gx = ((i < N - 1 ? pr[n + 1] : pr[n]) - (i > 0 ? pr[n - 1] : pr[n])) * 0.5;
      const gz = ((j < N - 1 ? pr[n + N] : pr[n]) - (j > 0 ? pr[n - N] : pr[n])) * 0.5;
      let wx = -gx * 0.75, wz = -gz * 0.75;
      const m = Math.hypot(wx, wz); if (m > 1.6) { wx *= 1.6 / m; wz *= 1.6 / m; }
      pu[n] = rc * wx - rs * wz; pv[n] = rc * wz + rs * wx;
    }
    let mu = 0, mv = 0;
    for (let j = 0; j < N; j++) {
      prevailing(oz + j, pw);
      for (let i = 0; i < N; i++) {
        const n = j * N + i, gi = ox + i + 0.5, gj = oz + j + 0.5;
        let wu = pw[0], wv = pw[1], up = 0, cs = 0, sh = 0, fl = 0, fc = 0, ft = 0, st = 0, tf = 0;
        for (const s of near) {
          let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
          const dz = gj - s.z, rr = (dx * dx + dz * dz) / (s.r * s.r);
          if (rr > 16) continue;
          const e = Math.exp(-rr), str = strOf(s), hem = s.z < PHc / 2 ? 1 : -1;
          if (rr <= 9) {
            const tang = str * 0.8 * e / s.r;
            // counter-clockwise in the north, clockwise in the south, spiralling inward
            wu += hem * dz * tang - dx * tang * 0.35; wv += -hem * dx * tang - dz * tang * 0.35;
            // broad lift under the whole system, so it reads as one solid overcast shield rather than
            // thin spiral arms with clear moats wound up by the vortex. A low with fronts keeps a
            // smaller round core: the fronts carry its weather out to the sides.
            const fr = s.fronts ? 0.55 : 1;
            up += str * Math.exp(-rr * (s.fronts ? 0.6 : 0.3)) * 0.9 * fr;
            // high cloud streams out ahead of and around the storm
            cs += str * Math.exp(-rr * 0.22) * 0.55;
            // the storm's cloud shield: one broad overcast with soft edges over the whole system
            sh = Math.max(sh, Math.min(1, str * 1.2) * Math.exp(-rr * (s.fronts ? 0.45 : 0.18)));
          }
          if (s.fronts && str > 0.05) {
            // Fronts, in cells. The low drifts east; seen from its centre the cold front trails
            // toward the equator and bends back west, the warm front runs east and bends toward the
            // equator, and the warm sector lies between them. Ahead of the warm front warm air
            // slides up over the cold: a wide band of layered cloud and steady rain with cirrus far
            // out in front. The cold front is a narrow line of towering cloud and downpours with
            // cold, clearer, showery air behind it.
            const R = s.r, sq = dz * hem;
            const cf = sq > 0 ? smooth01(sq / (0.25 * R)) * (1 - smooth01((sq - 2.4 * R) / (0.8 * R))) : 0;
            const dc = dx + 0.3 * sq + 0.08 * sq * sq / R;
            const wf = dx > 0 ? smooth01(dx / (0.25 * R)) * (1 - smooth01((dx - 2.8 * R) / (0.9 * R))) : 0;
            const dw = sq - 0.35 * dx - 0.05 * dx * dx / R;
            if (cf > 0) {
              const band = Math.exp(-(dc * dc) / 6.25) * cf * str;
              fl += band * 1.5; fc = Math.max(fc, band * 0.9); ft = Math.max(ft, band * 0.75);
              // behind it: cold air sinking, a few showers
              const behind = dc < 0 ? cf * (1 - Math.exp(dc / 2)) * Math.exp(dc / (2.2 * R)) : 0;
              tf -= behind * str * 6; fl -= behind * str * 0.35; fc = Math.max(fc, behind * 0.35);
            }
            if (wf > 0) {
              const ahead = dw < 0 ? Math.exp(-((dw + 3.5) ** 2) / 14) : Math.exp(-(dw * dw) / 3);
              fl += ahead * wf * str * 0.85; st = Math.max(st, ahead * wf * Math.min(1, str * 1.5));
              cs += Math.exp(-((dw + 10) ** 2) / 20) * wf * str * 0.9;
            }
            // the warm sector between the two fronts
            if (cf > 0 && wf > 0 && dc > 0 && dw > 0) tf += str * 3.5 * Math.min(cf, wf) * smooth01(dc / 2) * smooth01(dw / 2);
          }
        }
        const xl = i > 0 ? hgt[n - 1] : hgt[n], xr = i < N - 1 ? hgt[n + 1] : hgt[n];
        const zl = j > 0 ? hgt[n - N] : hgt[n], zr = j < N - 1 ? hgt[n + N] : hgt[n];
        const hx = (xr - xl) * 0.5, hz = (zr - zl) * 0.5;
        // air forced up a slope rises however much the slope also slows it, so the lift comes from
        // the wind arriving at the hill
        const oro = (wu * hx + wv * hz) * 0.045 * api.windMul;
        wu += pu[n]; wv += pv[n];
        // The ground steers the wind: air slows climbing a steep slope and turns to flow round high
        // ground, ridges and hilltops stand in faster air than sheltered valleys, and on clear calm
        // nights cold air drains down the valleys (by day it creeps up the sunny slopes).
        const cl = Math.min(1, c[n] * 2.6), hl = Math.hypot(hx, hz);
        if (!sea[n] && hl > 0.5) {
          const ex = hx / hl, ez = hz / hl, upc = wu * ex + wv * ez;
          if (upc > 0) { const b = Math.min(0.6, hl / 80); wu -= ex * upc * b; wv -= ez * upc * b; }
          const calm0 = 1 - smooth01((Math.hypot(wu, wv) - 0.6) / 1.2);
          const drain = 0.55 * smooth01(-dT / 0.6) * (1 - cl) * calm0 - 0.2 * dH;
          const sl = Math.min(1, hl / 40);
          wu -= ex * sl * drain; wv -= ez * sl * drain;
        }
        const expo = Math.max(0.6, Math.min(1.5, 1 + (hgt[n] - hB[n]) / 110));
        wu *= expo * api.windMul; wv *= expo * api.windMul;
        u[n] = wu; v[n] = wv;
        // cold air behind a front over warm ground is unstable too, but only while the sun is up
        const conv = sea[n] ? 0 : Math.max(0, tmp[n] + ta[n] - 14) / 14 * 0.35 * heat;
        // air piling up where pressure winds meet (sea-breeze fronts, gust fronts) has to rise
        const div = ((i < N - 1 ? pu[n + 1] : pu[n]) - (i > 0 ? pu[n - 1] : pu[n]) + (j < N - 1 ? pv[n + N] : pv[n]) - (j > 0 ? pv[n - N] : pv[n])) * 0.5;
        const conf = Math.max(-0.35, Math.min(0.6, -div * 1.6));
        // warm air advancing over colder air slides up over it in layers; cold air undercutting
        // warm air sinks behind its leading edge
        const tax = ((i < N - 1 ? ta[n + 1] : ta[n]) - (i > 0 ? ta[n - 1] : ta[n])) * 0.5;
        const taz = ((j < N - 1 ? ta[n + N] : ta[n]) - (j > 0 ? ta[n - N] : ta[n])) * 0.5;
        const adv = Math.max(-0.3, Math.min(0.45, -(wu * tax + wv * taz) * 0.07));
        if (adv > 0) st = Math.max(st, Math.min(1, adv * 1.6));
        // latent heat: condensing cloud warms the air in it, which rises harder
        const lat = Math.min(0.3, lh[n] * 1.5);
        up += fl;
        lift[n] = Math.max(-0.7, Math.min(1.6, oro + up + conv + conf + adv + lat));
        // steady sunshine alone builds cumulus up to towering cumulus; thunderstorms need a cell
        tops[n] = Math.min(1, 0.18 + Math.max(0, up) * 0.45 + Math.min(0.32, conv * 1.1) + Math.max(0, oro) * 0.3 + ft + Math.max(0, conf) * 0.25);
        // convective share: hot land and storm cores bubble up, broad gentle lift stays layered
        const cv = Math.min(1, conv * 2.4 + Math.max(0, up - fl - 0.3) * 1.1 + Math.max(0, oro - 0.2) * 0.5 + (sea[n] ? 0 : 0.15 * heat) + Math.max(0, conf) * 0.8);
        cvt[n] = Math.min(1, Math.max(cv * (1 - 0.75 * st), fc));
        // air sinking down the lee of a range warms as it is squeezed (the foehn); snow on the
        // ground chills the air above it
        tf += Math.min(4, Math.max(0, -oro - 0.15) * 3) - 2.5 * sn[n];
        strat[n] = st; taF[n] = Math.max(-9, Math.min(8, tf));
        ciSrc[n] = Math.min(0.9, cs); shield[n] = sh;
        if (Math.abs(i - N / 2) < 4 && Math.abs(j - N / 2) < 4) { mu += wu; mv += wv; }
      }
    }
    mean[0] = mu / 64; mean[1] = mv / 64;
    stampCells(dt);
  }

  const samp = (f, x, z, outside) => {
    if (x < 0 || z < 0 || x > N - 1.001 || z > N - 1.001) return outside;
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, n = j * N + i;
    return (f[n] * (1 - fx) + f[n + 1] * fx) * (1 - fz) + (f[n + N] * (1 - fx) + f[n + N + 1] * fx) * fz;
  };
  // value noise on the cell grid so condensation is patchy (cloud streets, scattered cumulus)
  const hash = (i, j) => { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const vnoise = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash(i, j), b = hash(i + 1, j), cc = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * sx + (cc - a) * sz + (a - b - cc + d) * sx * sz;
  };

  function step(dt) {
    // Storms move with the flow above them, slower than the air streaming through them; tropical
    // storms drift west and poleward with the trades and swing east once they reach the westerlies.
    // Each one deepens or fills toward what it can feed on, and is replaced when it has filled.
    const ST = stormT();
    for (let i = 0; i < storms.length; i++) {
      const s = storms[i], hem = s.z < PHc / 2 ? 1 : -1;
      prevailing(Math.floor(s.z), pw);
      s.x = (s.x + pw[0] * dt * CLOUD_ADV * 0.55 + PWc) % PWc;
      s.z += (pw[1] * 0.7 - (s.fronts ? 0 : 0.5 * hem)) * dt * CLOUD_ADV * 0.55;
      s.z = Math.max(4, Math.min(PHc - 4, s.z));
      s.age += dt / ST;
      const tg = stormTarget(s);
      s.k += (tg - s.k) * Math.min(1, dt / (ST * (tg > s.k ? 0.1 : s.fronts ? 0.08 : 0.04)));
      if (s.age > s.life * (s.fronts ? 1 : 1.6) || (!s.fronts && s.age > 0.3 * s.life && s.k < 0.04)) storms[i] = newStorm(storms.rnd, false);
    }
    stepCells(dt);
    winds(dt);
    const ADV = CLOUD_ADV;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      const bx = i - u[n] * dt * ADV, bz = j - v[n] * dt * ADV;
      const eq = bx < 0 || bz < 0 || bx > N - 1.001 || bz > N - 1.001 ? equilibrium(ox + Math.round(bx), oz + Math.round(bz)) * 0.9 : 0;
      q2[n] = samp(q, bx, bz, eq); c2[n] = samp(c, bx, bz, 0);
      ci2[n] = samp(ci, i - u[n] * dt * ADV * 1.7, j - v[n] * dt * ADV * 1.7, 0);
      ta2[n] = samp(ta, bx, bz, 0); fg2[n] = samp(fg, bx, bz, 0);
    }
    let t = q; q = q2; q2 = t; t = c; c = c2; c2 = t; t = ci; ci = ci2; ci2 = t;
    t = ta; ta = ta2; ta2 = t; t = fg; fg = fg2; fg2 = t;
    const dT = dayTemp(), dH = dayHeat();
    simT += dt;
    const ns = 0.11, sx = mean[0] * simT * CLOUD_ADV, sz = mean[1] * simT * CLOUD_ADV;
    let rainSum = 0, landN = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      // air temperature: the planet's climate, the air mass the wind brought (fronts) and the time
      // of day (land swings more than sea, cloud cover damps the swing)
      ta[n] += (taF[n] - ta[n]) * Math.min(1, dt * (Math.abs(taF[n]) > Math.abs(ta[n]) ? 0.02 : 0.004));
      const cl = Math.min(1, c[n] * 2.6);
      const T = tmp[n] + ta[n] + dT * (sea[n] ? 0.6 : 4.5 * (1 - 0.6 * cl));
      // the sea and wet ground give vapour back to the air; dry ground gives little
      const target = (sea[n] ? 0.85 : 0.3 + 0.5 * sm[n]) * qsat(T) * api.humid;
      q[n] += (target - q[n]) * (sea[n] ? 0.02 : 0.003 + 0.006 * sm[n]) * dt;
      // saturation at cloud level: colder aloft, lowered further where the air rises
      const turb = vnoise((ox + i - sx) * ns * 2.2, (oz + j - sz) * ns * 2.2) * 0.65 + vnoise((ox + i - sx) * ns * 6, (oz + j - sz) * ns * 6) * 0.35;
      const qs = qsat(T - 5) * Math.exp(-lift[n] * 0.9) * (0.82 + 0.42 * turb) / api.cloudy;
      let cond = 0;
      if (q[n] > qs) { cond = (q[n] - qs) * Math.min(1, 0.25 * dt); q[n] -= cond; c[n] += cond; }
      else { const e = Math.min(c[n], (qs - q[n]) * Math.min(1, 0.2 * dt)); c[n] -= e; q[n] += e; cond = -e; }
      // latent heat: condensing vapour warms the air (evaporating cloud cools it again)
      ta[n] = Math.max(-12, Math.min(12, ta[n] + cond * 0.1));
      lh[n] += (Math.max(0, cond) / dt - lh[n]) * Math.min(1, dt * 0.1);
      // heavy cloud rains out. Thick cloud in rising air (fronts, storm cores, thunderheads) pours,
      // a quiet stratus deck only drizzles. Rain falling through dry air partly evaporates before it
      // lands (virga), cooling the air under the cloud; the rest soaks the ground.
      const hum = Math.min(1, q[n] / (0.85 * qsat(T)));
      const heavy = Math.min(1, 0.12 + Math.max(0, lift[n]) * 1.1 + cvt[n] * tops[n] * 0.9);
      const ex = Math.max(0, c[n] - 0.22 / Math.sqrt(api.rainMul));
      const r = ex * (0.025 + 0.02 * heavy) * api.rainMul * dt;
      c[n] -= r;
      const land = 0.55 + 0.45 * smooth01((hum - 0.25) / 0.5);
      q[n] += r * (1 - land);
      if (r > 0) ta[n] -= r * (1 - land) * 8;
      rainOut[n] += (ex * heavy * land * api.rainMul - rainOut[n]) * Math.min(1, dt * 0.4);
      if (!sea[n]) {
        // the soil: soaked by the rain that lands, dried by sun and wind, and slowly back toward
        // the climate's own wetness
        const sp0 = Math.hypot(u[n], v[n]);
        sm[n] = Math.min(1, sm[n] + r * land * 3);
        sm[n] -= dt * sm[n] * 0.0012 * (0.15 + dH * (1 - cl)) * (1 + 0.5 * Math.min(2, sp0));
        sm[n] += (wet[n] - sm[n]) * dt / 2400;
        // how much wetter than usual the ground is around the player (the rivers' catchment)
        if (Math.abs(i - N / 2) < 24 && Math.abs(j - N / 2) < 24) { rainSum += sm[n] - wet[n]; landN++; }
        // instability: the sun heating moist ground stores it up through the day, night bleeds it away
        const capeT = Math.min(1.2, Math.max(0, (T - 12) / 12) * (0.5 + 0.9 * hum) * dH * (1 - 0.45 * cl));
        cape[n] += (capeT - cape[n]) * dt * (capeT > cape[n] ? 0.004 : 0.0012);
      } else {
        // warm tropical sea keeps the air above it unstable day and night
        const capeT = Math.max(0, (T - 25) / 4) * 0.5 * hum;
        cape[n] += (capeT - cape[n]) * dt * 0.002;
      }
      // cirrus: fed by anvils blowing off thunderheads and by storm outflow, patchy, slow to fade
      const anvil = tops[n] > 0.68 && c[n] > 0.12 ? 0.9 : 0;
      const bg = Math.max(0, vnoise((ox + i - sx * 1.7) * 0.05, (oz + j - sz * 1.7) * 0.05) - 0.62) * 1.4;
      const tgt = Math.max(anvil, ciSrc[n] * (0.4 + 0.9 * turb), bg);
      ci[n] += (tgt - ci[n]) * (tgt > ci[n] ? 0.03 : 0.006) * dt;
      // low fog. Over cold sea, moist and fairly calm air fogs up, thickest in the night and morning,
      // and the wind carries it ashore. Over land on clear, calm nights the ground cools the air
      // under it into radiation fog, more readily over wet ground. The sun burns land fog off
      // through the morning.
      const sp = Math.hypot(u[n], v[n]), calm = 1 - smooth01((sp - 0.5) / 1.6);
      let fgT = 0;
      if (sea[n]) fgT = Math.min(1, coldSea[n] * 1.6 + Math.max(0, ta[n] - 2) * 0.12) * calm * smooth01((hum - 0.55) / 0.3) * (1 - 0.45 * dH);
      else fgT = (1 - cl) * calm * smooth01((hum - 0.45) / 0.35) * smooth01((-dT - 0.1) / 0.6) * (1 - dH) * (0.45 + 0.55 * sm[n]);
      const rate = fgT > fg[n] ? 0.006 : sea[n] ? 0.004 : 0.004 + 0.03 * dH;
      fg[n] += (fgT - fg[n]) * Math.min(1, rate * dt);
      // fresh snow: where it rains, it snows on the ground above the height where the air is near
      // freezing; that edge creeps down while it snows. Above freezing the edge melts back uphill,
      // faster in the afternoon sun, and once it is well above the ground the snow is gone
      const L0 = hgt[n] + (T - 0.5) / 0.25, p = Math.min(1, rainOut[n] * 4);
      if (p > 0.05 && !sea[n]) {
        if (sn[n] < 0.02) snE[n] = L0;
        else if (L0 < snE[n]) snE[n] += (L0 - snE[n]) * Math.min(1, dt * 0.05);
        if (L0 < hgt[n] + 90) sn[n] = Math.min(1, sn[n] + p * dt / 45);
      }
      if (L0 > snE[n]) snE[n] += Math.min(L0 - snE[n], dt * (1 + 3 * dH) / 60);
      if (snE[n] > hgt[n] + 70) sn[n] = Math.max(0, sn[n] - dt / 600);
    }
    soilWet = landN ? rainSum / landN : 0;
  }
  function upload() {
    for (let n = 0; n < NN; n++) {
      const cov = Math.max(Math.min(1, c[n] * 2.6), shield[n]);
      px[n * 4] = Math.round(Math.min(1, Math.sqrt(cov)) * 255);
      px[n * 4 + 1] = Math.round(tops[n] * 255);
      px[n * 4 + 2] = Math.round(Math.min(1, rainOut[n] * 4) * 255);
      px[n * 4 + 3] = 255;
      px2[n * 2] = Math.round(Math.min(1, ci[n]) * 255);
      px2[n * 2 + 1] = Math.round(cvt[n] * 255);
    }
    { let t = 0, m = 0; for (let n = 0; n < NN; n++) { t += px[n * 4]; if (px[n * 4 + 2] > m) m = px[n * 4 + 2]; } meanCover = t / NN / 255; maxRain = m / 255; }
    cur ^= 1;
    mapO[cur] = [ox, oz, mean[0], mean[1]];
    gl.bindTexture(gl.TEXTURE_2D, maps[cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, maps2[cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RG, gl.UNSIGNED_BYTE, px2);
    gl.generateMipmap(gl.TEXTURE_2D);
    const e2 = y => Math.round(Math.min(255, Math.max(0, y / 2)));
    for (let n = 0; n < NN; n++) {
      px3[n * 4] = e2(hgt[n] + (tmp[n] - 1) / 0.25);
      px3[n * 4 + 1] = e2(snE[n]);
      px3[n * 4 + 2] = Math.round(Math.min(1, sn[n]) * 255);
      px3[n * 4 + 3] = 255;
    }
    snowO = [ox, oz];
    gl.bindTexture(gl.TEXTURE_2D, snowMap);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px3);
    // thunderstorm cells: towering, thick, raining hard and convective
    cbCells = []; cbW = 0;
    for (let n = 0; n < NN; n++) {
      const cov = px[n * 4] / 255, rn = px[n * 4 + 2] / 255;
      if (tops[n] < 0.66 || cov < 0.75 || rn < 0.3 || cvt[n] < 0.45) continue;
      const w = (tops[n] - 0.6) * rn * cvt[n];
      cbCells.push(n, w); cbW += w;
    }
  }
  // one lightning strike: a few return strokes in quick succession
  function lightning(dt) {
    clock += dt;
    if (strike && clock - strike.t0 > 1.2) strike = null;
    if (strike || cbW <= 0) return;
    if (Math.random() > Math.min(0.5, cbW * 0.03) * dt) return;
    let r = Math.random() * cbW, n = cbCells[0];
    for (let k = 0; k < cbCells.length; k += 2) { r -= cbCells[k + 1]; if (r <= 0) { n = cbCells[k]; break; } }
    const i = n % N, j = (n / N) | 0;
    const strokes = [0];
    for (let k = 1, m = 1 + Math.floor(Math.random() * 3); k <= m; k++) strokes.push(strokes[k - 1] + 0.05 + Math.random() * 0.12);
    strike = { x: (ox + i + Math.random()) * PC, z: (oz + j + Math.random()) * PC, ground: hgt[n], t0: clock, strokes,
      seed: Math.random() * 1e9 | 0, cloud: Math.random() < 0.35 };
  }
  function shift(nx, nz) {
    const dx = nx - ox, dz = nz - oz;
    for (const [a, b] of [[q, q2], [c, c2], [ci, ci2], [ta, ta2], [fg, fg2]]) {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const si = i + dx, sj = j + dz, n = j * N + i;
        b[n] = si >= 0 && sj >= 0 && si < N && sj < N ? a[sj * N + si] : -1;
      }
    }
    let t = q; q = q2; q2 = t; t = c; c = c2; c2 = t; t = ci; ci = ci2; ci2 = t;
    t = ta; ta = ta2; ta2 = t; t = fg; fg = fg2; fg2 = t;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const si = i + dx, sj = j + dz, n = j * N + i, inside = si >= 0 && sj >= 0 && si < N && sj < N;
      sn2[n] = inside ? sn[si + sj * N] : 0; snE2[n] = inside ? snE[si + sj * N] : 999;
      sm2[n] = inside ? sm[si + sj * N] : -1; cape2[n] = inside ? cape[si + sj * N] : 0;
      wrk[n] = inside ? lh[si + sj * N] : 0;
    }
    sn.set(sn2); snE.set(snE2); sm.set(sm2); cape.set(cape2); lh.set(wrk);
    ox = nx; oz = nz;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      if (q[n] < 0) { q[n] = equilibrium(ox + i, oz + j) * 0.9; c[n] = 0; ci[n] = 0; ta[n] = 0; fg[n] = 0; }
    }
    staticFields();
  }


  // ---- 3D cloud shape noise (since v65): a 128³ Perlin-Worley base (R) with three Worley fbm
  // octaves (GBA), and a 64³ Worley detail texture, baked on the GPU once at start. Both tile.
  const bakeCloudNoise = () => {
    const VSN = '#version 300 es\nvoid main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }';
    const FSN = `#version 300 es
precision highp float;
uniform float uZ, uSize; uniform int uKind;
out vec4 o;
vec3 hash33(vec3 p){ p=fract(p*vec3(0.1031,0.1030,0.0973)); p+=dot(p,p.yxz+33.33); return fract((p.xxy+p.yxx)*p.zyx); }
float worley(vec3 p, float per){
  vec3 id=floor(p), f=fract(p); float md=1.0;
  for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec3 of=vec3(x,y,z); vec3 r=of+hash33(mod(id+of,per))-f; md=min(md,dot(r,r));
  }
  return 1.0-sqrt(md);
}
float wfbm(vec3 p, float f){ return worley(p*f,f)*0.625+worley(p*f*2.0,f*2.0)*0.25+worley(p*f*4.0,f*4.0)*0.125; }
float gr(vec3 i, vec3 f, vec3 of, float per){ vec3 g=normalize(hash33(mod(i+of,per)+0.5)*2.0-1.0+1e-4); return dot(g,f-of); }
float perlin(vec3 p, float per){
  vec3 i=floor(p), f=fract(p), u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(mix(gr(i,f,vec3(0,0,0),per),gr(i,f,vec3(1,0,0),per),u.x),mix(gr(i,f,vec3(0,1,0),per),gr(i,f,vec3(1,1,0),per),u.x),u.y),
             mix(mix(gr(i,f,vec3(0,0,1),per),gr(i,f,vec3(1,0,1),per),u.x),mix(gr(i,f,vec3(0,1,1),per),gr(i,f,vec3(1,1,1),per),u.x),u.y),u.z);
}
float pfbm(vec3 p, float f){ float s=0.0, a=1.0, n=0.0; for(int i=0;i<5;i++){ s+=perlin(p*f,f)*a; n+=a; a*=0.5; f*=2.0; } return s/n*1.4; }
void main(){
  vec3 p=vec3(gl_FragCoord.xy/uSize,(uZ+0.5)/uSize);
  if(uKind==0){
    float g=wfbm(p,4.0), b=wfbm(p,8.0), a=wfbm(p,16.0);
    float pn=abs(pfbm(p,4.0));
    o=vec4(clamp(g+pn*(1.0-g),0.0,1.0),g,b,a);
  } else o=vec4(wfbm(p,2.0),wfbm(p,4.0),wfbm(p,8.0),1.0);
}`;
    const pr = gl.createProgram();
    for (const [t, src] of [[gl.VERTEX_SHADER, VSN], [gl.FRAGMENT_SHADER, FSN]]) {
      const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('cloud noise: ' + gl.getShaderInfoLog(sh));
      gl.attachShader(pr, sh);
    }
    gl.linkProgram(pr);
    const vao = gl.createVertexArray(), fb = gl.createFramebuffer();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT);
    gl.useProgram(pr); gl.bindVertexArray(vao); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const bake = (S, kind) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texStorage3D(gl.TEXTURE_3D, Math.log2(S) + 1, gl.RGBA8, S, S, S);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
      gl.viewport(0, 0, S, S);
      gl.uniform1f(gl.getUniformLocation(pr, 'uSize'), S); gl.uniform1i(gl.getUniformLocation(pr, 'uKind'), kind);
      const uZ = gl.getUniformLocation(pr, 'uZ');
      for (let z = 0; z < S; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t, 0, z);
        gl.uniform1f(uZ, z); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.generateMipmap(gl.TEXTURE_3D);
      return t;
    };
    const base = bake(128, 0), detail = bake(64, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb); gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.bindVertexArray(null); gl.enable(gl.DEPTH_TEST);
    gl.deleteFramebuffer(fb); gl.deleteProgram(pr);
    return { base, detail };
  };
  const cloudNoise = bakeCloudNoise();

  const api = {
    windMul: 1,
    // time of day in hours, set every frame: drives the daily cycle of heating, convection and fog
    tod: 12,
    // environment knobs from the menu: temperature offset (°C), humidity, how readily air clouds
    // over, storm strength and how readily cloud rains out
    temp: 0, humid: 1, cloudy: 1, stormMul: 1, rainMul: 1,
    // seconds per game day (set from the day-length setting): storms live one to two days
    dayLen: 1200,
    envChanged() { if (pl) staticFields(); },
    noise, mean, tex2, cloudBase: cloudNoise.base, cloudDetail: cloudNoise.detail,
    get meanCover() { return meanCover; }, get maxRain() { return maxRain; },
    // how much wetter (+) or drier (-) than its usual the land around the player is (about
    // -0.5..0.5): the rivers draining it run high after rain and low after a dry spell
    get soilWet() { return soilWet; },
    get map() { return maps[cur]; }, get map2() { return maps2[cur]; },
    get snowMap() { return snowMap; }, get snowOrigin() { return snowO; },
    // fresh snow lying at a world position and height (0..1), for tests
    snowAt(x, z, y) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return 0; const n = j * N + i; return sn[n] * smooth01((y - snE[n] + 2) / 6); },
    get mapPrev() { return maps[cur ^ 1]; }, get map2Prev() { return maps2[cur ^ 1]; },
    // the field is stepped four times a second; between steps each map slides on with the mean wind
    // so clouds and their shadows drift smoothly, and the older map (one step further along) fades
    // into the newer one
    get origin() { const o = mapO[cur]; return [o[0] + o[2] * CLOUD_ADV * acc, o[1] + o[3] * CLOUD_ADV * acc]; },
    get originPrev() { const o = mapO[cur ^ 1]; return [o[0] + o[2] * CLOUD_ADV * (acc + lastDt), o[1] + o[3] * CLOUD_ADV * (acc + lastDt)]; },
    get blend() { return Math.min(1, acc / 0.25); },
    get ready() { return ready; },
    reset(planet, seed, x, z, season) {
      pl = planet; ready = false;
      if (!pl || !pl.L) return;
      seasonOff = [0, 8, 0, -14][season] || 0;
      [ox, oz] = centreOn(x, z);
      seedStorms(seed);
      staticFields(); fillEquilibrium();
      // spin the weather up so the sky is already mature when the player arrives
      simT = 0;
      for (let i = 0; i < 90; i++) step(2.5);
      upload(); upload();
      ready = true; acc = 0;
    },
    setSeason(season) { seasonOff = [0, 8, 0, -14][season] || 0; if (pl) staticFields(); },
    update(dt, x, z) {
      if (!ready) return;
      const [cx, cz] = centreOn(x, z);
      if (Math.abs(cx - ox) > N * 0.6 || Math.abs(cz - oz) > N * 0.6) {
        [ox, oz] = [cx, cz]; staticFields(); fillEquilibrium();
        for (let i = 0; i < 60; i++) step(2.5);
        upload(); upload(); return;
      }
      if (Math.abs(cx - ox) >= 12 || Math.abs(cz - oz) >= 12) shift(cx, cz);
      acc += dt;
      if (acc >= 0.25) { step(acc); lastDt = acc; acc = 0; upload(); }
      lightning(dt);
    },
    // the current lightning strike and its brightness right now (0 when dark)
    flash() {
      if (!strike) return null;
      const t = clock - strike.t0;
      let I = 0;
      for (const s of strike.strokes) if (t >= s) I += Math.exp(-(t - s) * 22) * (s === 0 ? 1 : 0.7);
      return { ...strike, I };
    },
    // rain falling at a world position (0..1)
    rainAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return 0; return px[(j * N + i) * 4 + 2] / 255; },
    cirrusAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return 0; return px2[(j * N + i) * 2] / 255; },
    typeAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return null; const n = j * N + i; return { cover: px[n * 4] / 255, tops: tops[n], conv: cvt[n], rain: px[n * 4 + 2] / 255, cirrus: ci[n], airMass: ta[n], front: taF[n], layered: strat[n], fog: fg[n], soil: sm[n], cape: cape[n], lift: lift[n], latent: lh[n] }; },
    // soil moisture (0..1) at a world position, and how much wetter it is than the climate's usual
    soilAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return [0.5, 0]; const n = j * N + i; return [sm[n], sm[n] - wet[n]]; },
    // the thunderstorm cells alive now, in world blocks, for the map and tests
    cells() { return cells.map(c => ({ x: c.x * PC, z: c.z * PC, r: c.r * PC, phase: c.age / c.life, I: cellI(c.age / c.life), s: c.s })); },
    // for tests: force a strike over the nearest thunderhead
    strikeNow(x, z, exact) {
      if (cbW <= 0) return null;
      let best = cbCells[0], bd = 1e18;
      for (let k = 0; k < cbCells.length; k += 2) { const n = cbCells[k], d = ((ox + n % N) * PC - x) ** 2 + ((oz + ((n / N) | 0)) * PC - z) ** 2; if (d < bd) { bd = d; best = n; } }
      const saved = [cbCells, cbW]; cbCells = [best, 1]; cbW = 1; strike = null;
      while (!strike) lightning(0.0001 + 1);
      [cbCells, cbW] = saved;
      if (exact) { strike.x = x; strike.z = z; strike.cloud = false; }
      return strike;
    },
    // cloud cover (0..1) over a world position, for the HUD and tests
    // for the map: wind at any planet cell, the storm systems, and the simulated cloud field
    windAt(gi, gj) {
      // inside the simulated grid: the full wind, pressure winds and the ground's steering included
      const fi = gi - ox - 0.5, fj = gj - oz - 0.5, wm = api.windMul || 1;
      if (ready && fi >= 1 && fj >= 1 && fi < N - 2 && fj < N - 2) return [samp(u, fi, fj, 0) / wm, samp(v, fi, fj, 0) / wm];
      const w = [0, 0]; prevailing(gj, w);
      for (const s of storms) {
        let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
        const dz = gj - s.z, rr = (dx * dx + dz * dz) / (s.r * s.r);
        if (rr > 9) continue;
        const e = Math.exp(-rr), str = strOf(s), hem = s.z < PHc / 2 ? 1 : -1;
        const tang = str * 0.8 * e / s.r;
        w[0] += hem * dz * tang - dx * tang * 0.35; w[1] += -hem * dx * tang - dz * tang * 0.35;
      }
      return w;
    },
    storms() { return storms.map(s => ({ x: s.x, z: s.z, r: s.r, north: s.z < PHc / 2, str: strOf(s), tropical: !s.fronts, age: s.age / s.life })); },
    // sea-level pressure (hPa) at a world position: the planet's pressure belts (equatorial low,
    // subtropical highs, subpolar lows, polar highs), the storms' lows and the local warm/cold air
    pressureAt(x, z) {
      const gi = x / PC, gj = z / PC, a = Math.abs(latDeg(gj - 0.5));
      let p = 1013 - 5 * Math.exp(-((a / 10) ** 2)) + 8 * Math.exp(-(((a - 30) / 12) ** 2)) - 9 * Math.exp(-(((a - 60) / 10) ** 2)) + 5 * Math.exp(-(((a - 88) / 10) ** 2));
      for (const s of storms) {
        let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
        const rr = (dx * dx + (gj - s.z) ** 2) / (s.r * s.r);
        if (rr < 16) p -= strOf(s) * (s.fronts ? 24 : 40) * Math.exp(-rr * 0.7);
      }
      return p + samp(pr, gi - ox - 0.5, gj - oz - 0.5, 0);
    },
    cloudField() { return { ox, oz, N, px }; },
    // air temperature (°C) at a world position and height: the cell's climate, the air mass the
    // wind brought, the time of day, then 0.25 °C colder per block above the cell's ground
    tempAt(x, z, y) {
      const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz;
      if (!pl) return 10;
      if (i < 0 || j < 0 || i >= N || j >= N) { const gj = Math.floor(z / PC), k = cellK(Math.floor(x / PC), gj); return pl.tmp[k] + seasonTemp(gj) + api.temp - (y - Math.max(30, pl.ys[k])) * 0.25; }
      const n = j * N + i, cl = Math.min(1, c[n] * 2.6);
      return tmp[n] + ta[n] + dayTemp() * (sea[n] ? 0.6 : 4.5 * (1 - 0.6 * cl)) - (y - hgt[n]) * 0.25;
    },
    // the planet's own temperature here before the air mass and time of day, for snow cover
    climateAt(x, z, y) { if (!pl) return 10; const gj = Math.floor(z / PC), k = cellK(Math.floor(x / PC), gj); return pl.tmp[k] + seasonTemp(gj) + api.temp - (y - Math.max(30, pl.ys[k])) * 0.25; },
    // low fog (0..1) at a world position, bilinear between cells
    fogAt(x, z) { return Math.max(0, samp(fg, x / PC - ox - 0.5, z / PC - oz - 0.5, 0)); },
    // share of sea among the cells within r cells, for the sound of the surf
    seaNear(x, z, r = 2) {
      const i0 = Math.floor(x / PC) - ox, j0 = Math.floor(z / PC) - oz;
      let s = 0, n = 0;
      for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) { if (i < 0 || j < 0 || i >= N || j >= N) continue; s += sea[j * N + i]; n++; }
      return n ? s / n : 0;
    },
    // Thunderstorm outflow: rain-cooled air under a storm is cold and heavy, so it makes high
    // pressure and pours out along the ground as a gust front. It is part of the simulated wind
    // (the pressure wind); this returns that part [x, z] at a world position, and 0 for the cold
    // (the cold pool is already in the air temperature).
    outflowAt(x, z) {
      const fi = x / PC - ox - 0.5, fj = z / PC - oz - 0.5;
      return [samp(pu, fi, fj, 0), samp(pv, fi, fj, 0), 0];
    },
    // Swell: the waves a storm's winds raise outrun the storm and arrive far away as long, regular
    // swell. Each storm over the sea sends swell outward, bigger from strong and large storms,
    // fading with distance, and land in the way stops it. Returns the direction it travels [x, z]
    // and its height in blocks.
    swellAt(x, z) {
      if (!pl) return [1, 0, 0];
      const gi = x / PC, gj = z / PC;
      let sx = 0, sz = 0, e = 0;
      for (const s of storms) {
        let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
        const dz = gj - s.z, d = Math.hypot(dx, dz), str = strOf(s);
        if (d > 170 || d < 1 || str < 0.1) continue;
        let land = 0;
        for (let t = 0.15; t < 0.95; t += 0.2) if (!isSeaK(cellK(Math.floor(s.x + dx * t), Math.floor(s.z + dz * t)))) land++;
        if (land > 1) continue;
        const E = str * str * s.r / 10 * Math.exp(-Math.max(0, d - s.r) / 70) * (1 - 0.45 * land);
        sx += dx / d * E; sz += dz / d * E; e += E;
      }
      const m = Math.hypot(sx, sz) || 1;
      return [sx / m, sz / m, Math.min(2.2, Math.sqrt(e) * 1.3)];
    },
    coverAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return 0; return px[(j * N + i) * 4] / 255; },
  };
  return api;
}

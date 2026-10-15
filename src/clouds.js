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
  const px = new Uint8Array(NN * 4), px2 = new Uint8Array(NN * 2);
  // lightning: candidate thunderstorm cells and the strike currently flashing
  let cbCells = [], cbW = 0, clock = 0, strike = null;
  let ox = 0, oz = 0, pl = null, storms = [], acc = 0, simT = 0, seasonOff = 0, ready = false;
  const mean = [0, 0];

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
  const maps2 = [mkMap(gl.RG, gl.RG8, px2, false), mkMap(gl.RG, gl.RG8, px2, false)];
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
  let meanCover = 0.3;

  // ---- climate inputs ----
  const qsat = T => 0.5 * Math.exp(0.065 * T);
  const cellK = (gi, gj) => Math.min(PHc - 1, Math.max(0, gj)) * PWc + (((gi % PWc) + PWc) % PWc);
  const latDeg = gj => 90 - (gj + 0.5) / PHc * 180;
  function seasonTemp(gj) {
    // summer warms the hemisphere it is summer in, winter cools it
    const n = latDeg(gj) >= 0 ? 1 : -1;
    return seasonOff * n * Math.min(1, Math.abs(latDeg(gj)) / 30);
  }
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
  }
  function newStorm(rnd, anywhere) {
    // lows form mostly in the storm tracks around 40-60 degrees, a few over the warm tropics
    const trop = rnd() < 0.25;
    const la = (trop ? 8 + rnd() * 14 : 38 + rnd() * 24) * (rnd() < 0.5 ? 1 : -1);
    return { x: rnd() * PWc, z: (90 - la) / 180 * PHc, r: (trop ? 4 : 7) + rnd() * (trop ? 4 : 9),
      s: 0.6 + rnd() * 0.9, age: anywhere ? rnd() : 0, life: 0.6 + rnd() * 0.8 };
  }
  function staticFields() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i, gi = ox + i, gj = oz + j, k = cellK(gi, gj);
      hgt[n] = Math.max(30, pl.ys[k]);
      tmp[n] = pl.tmp[k] + seasonTemp(gj) + api.temp;
      sea[n] = pl.L.elev[k] <= 0 || pl.ys[k] < 30 ? 1 : 0;
      wet[n] = Math.min(1, pl.L.rain[k] / 2);
    }
  }
  function fillEquilibrium() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const n = j * N + i; q[n] = equilibrium(ox + i, oz + j) * 0.9; c[n] = 0; ci[n] = 0; }
  }
  function centreOn(x, z) {
    return [Math.floor(x / PC) - (N >> 1), Math.floor(z / PC) - (N >> 1)];
  }

  // wind = prevailing flow + storm vortices; lift = slope the wind climbs + storm cores + warm-land convection
  const pw = [0, 0];
  function winds() {
    const near = storms.filter(s => {
      let dx = s.x - (ox + N / 2); dx -= Math.round(dx / PWc) * PWc;
      return Math.abs(dx) < N / 2 + s.r * 3 && Math.abs(s.z - (oz + N / 2)) < N / 2 + s.r * 3;
    });
    let mu = 0, mv = 0;
    for (let j = 0; j < N; j++) {
      prevailing(oz + j, pw);
      for (let i = 0; i < N; i++) {
        const n = j * N + i, gi = ox + i + 0.5, gj = oz + j + 0.5;
        let wu = pw[0], wv = pw[1], up = 0, cs = 0, sh = 0;
        for (const s of near) {
          let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
          const dz = gj - s.z, rr = (dx * dx + dz * dz) / (s.r * s.r);
          if (rr > 9) continue;
          const life = Math.sin(Math.PI * Math.min(1, s.age / s.life));
          const e = Math.exp(-rr), str = s.s * life * api.stormMul, hem = s.z < PHc / 2 ? 1 : -1;
          const tang = str * 0.8 * e / s.r;
          // counter-clockwise in the north, clockwise in the south, spiralling inward
          wu += hem * dz * tang - dx * tang * 0.35; wv += -hem * dx * tang - dz * tang * 0.35;
          // broad lift under the whole system, so it reads as one solid overcast shield rather than
          // thin spiral arms with clear moats wound up by the vortex
          up += str * Math.exp(-rr * 0.3) * 0.9;
          // high cloud streams out ahead of and around the storm
          cs += str * Math.exp(-rr * 0.22) * 0.55;
          // the storm's cloud shield: one broad overcast with soft edges over the whole system
          sh = Math.max(sh, Math.min(1, str * 1.2) * Math.exp(-rr * 0.18));
        }
        wu *= api.windMul; wv *= api.windMul;
        u[n] = wu; v[n] = wv;
        const xl = i > 0 ? hgt[n - 1] : hgt[n], xr = i < N - 1 ? hgt[n + 1] : hgt[n];
        const zl = j > 0 ? hgt[n - N] : hgt[n], zr = j < N - 1 ? hgt[n + N] : hgt[n];
        const oro = (wu * (xr - xl) + wv * (zr - zl)) * 0.5 * 0.045;
        const conv = sea[n] ? 0 : Math.max(0, tmp[n] - 14) / 14 * 0.35;
        lift[n] = Math.max(-0.7, Math.min(1.6, oro + up + conv));
        tops[n] = Math.min(1, 0.18 + Math.max(0, up) * 0.45 + conv * 1.3 + Math.max(0, oro) * 0.3);
        // convective share: hot land and storm cores bubble up, broad gentle lift stays layered
        cvt[n] = Math.min(1, conv * 2.4 + Math.max(0, up - 0.3) * 1.1 + Math.max(0, oro - 0.2) * 0.5 + (sea[n] ? 0 : 0.15));
        ciSrc[n] = Math.min(0.9, cs); shield[n] = sh;
        if (Math.abs(i - N / 2) < 4 && Math.abs(j - N / 2) < 4) { mu += wu; mv += wv; }
      }
    }
    mean[0] = mu / 64; mean[1] = mv / 64;
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
    // storms drift with the flow at their latitude, grow, fade and are replaced
    for (let i = 0; i < storms.length; i++) {
      const s = storms[i];
      prevailing(Math.floor(s.z), pw);
      s.x = (s.x + pw[0] * dt * CLOUD_ADV + PWc) % PWc; s.z += pw[1] * dt * CLOUD_ADV * 0.7;
      s.age += dt / 900;
      if (s.age > s.life) storms[i] = newStorm(storms.rnd, false);
    }
    winds();
    const ADV = CLOUD_ADV;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      const bx = i - u[n] * dt * ADV, bz = j - v[n] * dt * ADV;
      const eq = bx < 0 || bz < 0 || bx > N - 1.001 || bz > N - 1.001 ? equilibrium(ox + Math.round(bx), oz + Math.round(bz)) * 0.9 : 0;
      q2[n] = samp(q, bx, bz, eq); c2[n] = samp(c, bx, bz, 0);
      ci2[n] = samp(ci, i - u[n] * dt * ADV * 1.7, j - v[n] * dt * ADV * 1.7, 0);
    }
    let t = q; q = q2; q2 = t; t = c; c = c2; c2 = t; t = ci; ci = ci2; ci2 = t;
    simT += dt;
    const ns = 0.11, sx = mean[0] * simT * CLOUD_ADV, sz = mean[1] * simT * CLOUD_ADV;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i, T = tmp[n];
      // the sea and wet forests give vapour back to the air
      const target = (sea[n] ? 0.85 : 0.35 + 0.4 * wet[n]) * qsat(T) * api.humid;
      q[n] += (target - q[n]) * (sea[n] ? 0.02 : 0.006) * dt;
      // saturation at cloud level: colder aloft, lowered further where the air rises
      const turb = vnoise((ox + i - sx) * ns * 2.2, (oz + j - sz) * ns * 2.2) * 0.65 + vnoise((ox + i - sx) * ns * 6, (oz + j - sz) * ns * 6) * 0.35;
      const qs = qsat(T - 5) * Math.exp(-lift[n] * 0.9) * (0.82 + 0.42 * turb) / api.cloudy;
      if (q[n] > qs) { const d = (q[n] - qs) * Math.min(1, 0.25 * dt); q[n] -= d; c[n] += d; }
      else { const e = Math.min(c[n], (qs - q[n]) * Math.min(1, 0.2 * dt)); c[n] -= e; q[n] += e; }
      // heavy cloud rains out
      const r = Math.max(0, c[n] - 0.22 / Math.sqrt(api.rainMul)) * 0.04 * api.rainMul * dt;
      // what reaches the ground: thick cloud in rising air (fronts, storm cores, thunderheads) pours,
      // a quiet stratus deck only drizzles
      const heavy = Math.min(1, 0.12 + Math.max(0, lift[n]) * 1.1 + cvt[n] * tops[n] * 0.9);
      c[n] -= r; rainOut[n] += (Math.max(0, c[n] - 0.22 / Math.sqrt(api.rainMul)) * heavy * api.rainMul - rainOut[n]) * Math.min(1, dt * 0.4);
      // cirrus: fed by anvils blowing off thunderheads and by storm outflow, patchy, slow to fade
      const anvil = tops[n] > 0.68 && c[n] > 0.12 ? 0.9 : 0;
      const bg = Math.max(0, vnoise((ox + i - sx * 1.7) * 0.05, (oz + j - sz * 1.7) * 0.05) - 0.62) * 1.4;
      const tgt = Math.max(anvil, ciSrc[n] * (0.4 + 0.9 * turb), bg);
      ci[n] += (tgt - ci[n]) * (tgt > ci[n] ? 0.03 : 0.006) * dt;
    }
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
    { let t = 0; for (let n = 0; n < NN; n++) t += px[n * 4]; meanCover = t / NN / 255; }
    cur ^= 1;
    mapO[cur] = [ox, oz, mean[0], mean[1]];
    gl.bindTexture(gl.TEXTURE_2D, maps[cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, maps2[cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RG, gl.UNSIGNED_BYTE, px2);
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
    for (const [a, b] of [[q, q2], [c, c2], [ci, ci2]]) {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const si = i + dx, sj = j + dz, n = j * N + i;
        b[n] = si >= 0 && sj >= 0 && si < N && sj < N ? a[sj * N + si] : -1;
      }
    }
    let t = q; q = q2; q2 = t; t = c; c = c2; c2 = t; t = ci; ci = ci2; ci2 = t;
    ox = nx; oz = nz;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = j * N + i;
      if (q[n] < 0) { q[n] = equilibrium(ox + i, oz + j) * 0.9; c[n] = 0; ci[n] = 0; }
    }
    staticFields();
  }

  const api = {
    windMul: 1,
    // environment knobs from the menu: temperature offset (°C), humidity, how readily air clouds
    // over, storm strength and how readily cloud rains out
    temp: 0, humid: 1, cloudy: 1, stormMul: 1, rainMul: 1,
    envChanged() { if (pl) staticFields(); },
    noise, mean, tex2,
    get meanCover() { return meanCover; },
    get map() { return maps[cur]; }, get map2() { return maps2[cur]; },
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
      seasonOff = [0, 6, 0, -8][season] || 0;
      [ox, oz] = centreOn(x, z);
      seedStorms(seed);
      staticFields(); fillEquilibrium();
      // spin the weather up so the sky is already mature when the player arrives
      simT = 0;
      for (let i = 0; i < 90; i++) step(2.5);
      upload(); upload();
      ready = true; acc = 0;
    },
    setSeason(season) { seasonOff = [0, 6, 0, -8][season] || 0; if (pl) staticFields(); },
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
    typeAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return null; const n = j * N + i; return { cover: px[n * 4] / 255, tops: tops[n], conv: cvt[n], rain: px[n * 4 + 2] / 255, cirrus: ci[n] }; },
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
      const w = [0, 0]; prevailing(gj, w);
      for (const s of storms) {
        let dx = gi - s.x; dx -= Math.round(dx / PWc) * PWc;
        const dz = gj - s.z, rr = (dx * dx + dz * dz) / (s.r * s.r);
        if (rr > 9) continue;
        const life = Math.sin(Math.PI * Math.min(1, s.age / s.life)), e = Math.exp(-rr), str = s.s * life * api.stormMul, hem = s.z < PHc / 2 ? 1 : -1;
        const tang = str * 0.8 * e / s.r;
        w[0] += hem * dz * tang - dx * tang * 0.35; w[1] += -hem * dx * tang - dz * tang * 0.35;
      }
      return w;
    },
    storms() { return storms.map(s => ({ x: s.x, z: s.z, r: s.r, north: s.z < PHc / 2, str: s.s * api.stormMul * Math.sin(Math.PI * Math.min(1, s.age / s.life)) })); },
    cloudField() { return { ox, oz, N, px }; },
    coverAt(x, z) { const i = Math.floor(x / PC) - ox, j = Math.floor(z / PC) - oz; if (i < 0 || j < 0 || i >= N || j >= N) return 0; return px[(j * N + i) * 4] / 255; },
  };
  return api;
}

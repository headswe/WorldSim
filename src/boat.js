// Emberwood boat: a 10 m sailing yacht you can launch, board and steer on the open sea.
// The model is built here from lofted curves (a round-bilged hull with sheer and a raked stem, a
// teak deck, a coachroof with windows, cockpit coaming, wheel, rails, mast, rigging, a mainsail
// and a jib), not from blocks. It floats on the very same Gerstner waves the sea shader draws:
// seaWaveJS below is a line-for-line copy of seaWave() in shaders.js, so the hull rides the
// swells you see. The sails swing to leeward with the simulated wind; the boat heels, pitches and
// rolls on springs, and leaves a foamy wake that the water shader draws from a trail of points.
const VS_BOAT = `#version 300 es
${GLSL_COMMON}
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec4 aCol;
uniform mat4 uVP; uniform mat4 uModel; uniform mat4 uLightVP;
out vec3 vW; out vec3 vL; out vec3 vN; out vec4 vC; out vec4 vLP;
void main(){
  vec4 w=uModel*vec4(aPos,1.0);
  vW=w.xyz; vL=aPos; vN=mat3(uModel)*aNrm; vC=aCol;
  vLP=uLightVP*vec4(w.xyz+vN*0.04,1.0);
  gl_Position=uVP*w;
}`;
const FS_BOAT = `#version 300 es
${GLSL_COMMON}
${FS_LIGHTING}
in vec3 vW; in vec3 vL; in vec3 vN; in vec4 vC; in vec4 vLP;
out vec4 o;
// sheer (deck edge height) along the hull, u = 0 at the transom, 1 at the stem
float sheer(float u){ return 1.05+0.55*pow(clamp(u,0.0,1.0),2.2); }
void main(){
  int mat=int(vC.a+0.5);
  vec3 c=vC.rgb; float gloss=0.0;
  vec3 N=normalize(vN);
  vec3 V=normalize(vW-uCam);
  if(mat==1){ gloss=0.6; }
  else if(mat==2){
    // hull paint: antifouling below the waterline, a navy boot stripe, white topsides, navy sheer stripe
    float y=vL.y, ys=sheer((vL.x+5.0)/10.0);
    if(y<0.03){ c=vec3(0.34,0.08,0.06); gloss=0.05; }
    else if(y<0.15){ c=vec3(0.05,0.09,0.22); gloss=0.6; }
    else if(y>ys-0.14){ c=vec3(0.05,0.09,0.22); gloss=0.6; }
    else { c=vec3(0.93,0.93,0.91); gloss=0.7; }
  } else if(mat==3){
    // sailcloth: seams across the sail, light shines through it
    if(dot(N,V)>0.0) N=-N;
    float seam=smoothstep(0.035,0.0,abs(fract(vL.y/0.95)-0.5)-0.465);
    c*=1.0-0.12*seam;
  } else if(mat==4){ gloss=0.9; }
  else if(mat==5){
    // teak planks laid fore and aft with dark caulking
    float pz=vL.z/0.14, pi=floor(pz);
    float seg=floor((vL.x+pi*1.73)/2.4);
    float r=h1(uint(int(pi)+97)*7919u+uint(int(seg)+511)*104729u);
    c=mix(vec3(0.52,0.35,0.20),vec3(0.62,0.44,0.27),r);
    c=mix(c,vec3(0.10,0.08,0.06),smoothstep(0.07,0.03,fract(pz)));
  } else if(mat==6){ gloss=0.5; }
  vec3 alb=pow(c,vec3(2.2));
  if(mat==7){ o=vec4(outHDR(applyFog(alb*(3.0+10.0*uNight),vW)),1.0); return; }
  float sh=shadowF(vLP)*cloudShade(vW);
  float ndl=max(dot(N,uSunDir),0.0);
  vec3 amb=mix(uAmbGround,uAmbSky,N.y*0.5+0.5);
  vec3 lit=alb*(amb+uSunCol*ndl*sh);
  if(mat==3) lit+=alb*uSunCol*max(dot(-N,uSunDir),0.0)*0.45*sh;
  if(gloss>0.0){
    vec3 R=reflect(V,N);
    float fres=0.04+0.96*pow(1.0-max(dot(-V,N),0.0),5.0);
    lit+=skyCol(vec3(R.x,abs(R.y),R.z))*fres*gloss*0.5;
    lit+=uSunCol*pow(max(dot(R,uSunDir),0.0),mix(16.0,200.0,gloss))*gloss*sh*1.5;
  }
  // wet and darker where the sea washes over it
  if(vW.y<31.4 && mat!=2) lit*=0.8;
  o=vec4(outHDR(applyFog(lit,vW)),1.0);
}`;
const VS_BOAT_SHADOW = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP; uniform mat4 uModel;
void main(){ gl_Position=uLightVP*(uModel*vec4(aPos,1.0)); }`;

function createBoat(gl, program, setU) {
  // ---------- geometry ----------
  const L = 10, HB = 1.7;
  const sheer = u => 1.05 + 0.55 * Math.pow(Math.min(1, Math.max(0, u)), 2.2);
  const keelY = u => u < 0.5 ? -0.2 - 0.45 * smooth01(u / 0.5) : -0.65 + 0.5 * Math.pow((u - 0.5) / 0.5, 1.5);
  const halfB = u => u < 0.45 ? 1.3 + 0.4 * Math.sin(u / 0.45 * Math.PI / 2) : HB * Math.sqrt(Math.max(0, 1 - ((u - 0.45) / 0.55) ** 2));
  function smooth01(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }
  const C = {
    white: [0.93, 0.93, 0.91], off: [0.84, 0.84, 0.80], metal: [0.78, 0.79, 0.81], dark: [0.10, 0.10, 0.11],
    sail: [0.95, 0.93, 0.87], glass: [0.03, 0.05, 0.07], keel: [0.30, 0.08, 0.06], wood: [0.45, 0.30, 0.17], rim: [0.12, 0.09, 0.07],
  };
  function Mesh() { return { p: [], n: [], c: [] }; }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function vert(m, p, n, col, mat) { m.p.push(p[0], p[1], p[2]); m.n.push(n[0], n[1], n[2]); m.c.push(col[0], col[1], col[2], mat); }
  // a flat triangle; its normal is turned to face away from 'out' (a point inside the solid)
  function tri(m, a, b, c, col, mat, inside) {
    let n = norm(cross(sub(b, a), sub(c, a)));
    if (inside) { const ctr = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]; const d = sub(ctr, inside); if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0) n = [-n[0], -n[1], -n[2]]; }
    vert(m, a, n, col, mat); vert(m, b, n, col, mat); vert(m, c, n, col, mat);
  }
  function quad(m, a, b, c, d, col, mat, inside) { tri(m, a, b, c, col, mat, inside); tri(m, a, c, d, col, mat, inside); }
  // a smooth surface from a grid of points (rows x cols); normals averaged and turned away from
  // inside(p), which returns a point inside the solid near p (or null: keep the raw orientation)
  function grid(m, G, col, mat, inside) {
    const R = G.length, Cn = G[0].length, N = G.map(r => r.map(() => [0, 0, 0]));
    const acc = (i, j, n) => { const t = N[i][j]; t[0] += n[0]; t[1] += n[1]; t[2] += n[2]; };
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < Cn - 1; j++) {
      const a = G[i][j], b = G[i + 1][j], c = G[i + 1][j + 1], d = G[i][j + 1];
      const n = cross(sub(c, a), sub(d, b));
      acc(i, j, n); acc(i + 1, j, n); acc(i + 1, j + 1, n); acc(i, j + 1, n);
    }
    const fix = (i, j) => {
      let n = norm(N[i][j]);
      if (inside) { const q = inside(G[i][j]); const d = sub(G[i][j], q); if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0) n = [-n[0], -n[1], -n[2]]; }
      return n;
    };
    const NN = G.map((r, i) => r.map((_, j) => fix(i, j)));
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < Cn - 1; j++) {
      const ids = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
      for (const [a, b] of ids) vert(m, G[a][b], NN[a][b], col, mat);
    }
  }
  // a thin square rod from p to q
  function rod(m, p, q, r, col, mat) {
    const d = norm(sub(q, p));
    const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const a = norm(cross(d, up)), b = cross(d, a);
    const off = (s, t) => [a[0] * s * r + b[0] * t * r, a[1] * s * r + b[1] * t * r, a[2] * s * r + b[2] * t * r];
    const cs = [off(1, 1), off(-1, 1), off(-1, -1), off(1, -1)];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    for (let k = 0; k < 4; k++) {
      const o1 = cs[k], o2 = cs[(k + 1) % 4];
      quad(m, [p[0] + o1[0], p[1] + o1[1], p[2] + o1[2]], [q[0] + o1[0], q[1] + o1[1], q[2] + o1[2]], [q[0] + o2[0], q[1] + o2[1], q[2] + o2[2]], [p[0] + o2[0], p[1] + o2[1], p[2] + o2[2]], col, mat, mid);
    }
  }
  // a round tapered spar along y from (x, y0, z) to y1
  function spar(m, x, z, y0, y1, r0, r1, col, mat) {
    const G = [];
    for (let i = 0; i <= 1; i++) {
      const y = i ? y1 : y0, r = i ? r1 : r0, row = [];
      for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI * 2; row.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r]); }
      G.push(row);
    }
    grid(m, G, col, mat, p => [x, p[1], z]);
  }
  function box(m, c, s, col, mat) {
    const [x, y, z] = c, [a, b, d] = s.map(v => v / 2);
    const P = (i, j, k) => [x + (i ? a : -a), y + (j ? b : -b), z + (k ? d : -d)];
    const faces = [[P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)], [P(1, 0, 0), P(1, 0, 1), P(1, 1, 1), P(1, 1, 0)],
      [P(0, 0, 0), P(0, 0, 1), P(1, 0, 1), P(1, 0, 0)], [P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)],
      [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)], [P(0, 0, 1), P(0, 1, 1), P(1, 1, 1), P(1, 0, 1)]];
    for (const f of faces) quad(m, f[0], f[1], f[2], f[3], col, mat, c);
  }

  const hull = Mesh();
  const NI = 30, NJ = 14;
  const station = i => i / NI;
  const xAt = (u, f) => -L / 2 + u * L + 0.45 * f * Math.pow(u, 5); // stem raked forward at the top
  // hull sides: a superellipse section from the keel line up to the sheer
  for (const side of [1, -1]) {
    const G = [];
    for (let i = 0; i <= NI; i++) {
      const u = station(i), hb = halfB(u), ys = sheer(u), yk = keelY(u), row = [];
      for (let j = 0; j <= NJ; j++) {
        const th = j / NJ * Math.PI / 2;
        const sz = Math.pow(Math.sin(th), 2 / 2.6), cy = Math.pow(Math.cos(th), 2 / 2.6);
        const y = ys - (ys - yk) * cy, f = (y - yk) / (ys - yk);
        row.push([xAt(u, f), y, side * hb * sz * (0.94 + 0.06 * Math.sin(th))]);
      }
      G.push(row);
    }
    grid(hull, G, C.white, 2, p => [Math.min(Math.max(p[0], -4.5), 4.4), 0.35, 0]);
  }
  // transom
  {
    const u = 0, hb = halfB(u), ys = sheer(u), yk = keelY(u), ctr = [-L / 2, (ys + yk) / 2, 0];
    let prev = null;
    for (let j = -NJ; j <= NJ; j++) {
      const th = Math.abs(j) / NJ * Math.PI / 2, s = Math.sign(j) || 1;
      const y = ys - (ys - yk) * Math.pow(Math.cos(th), 2 / 2.6);
      const p = [-L / 2, y, s * hb * Math.pow(Math.sin(th), 2 / 2.6) * (0.94 + 0.06 * Math.sin(th))];
      if (prev) tri(hull, ctr, prev, p, C.white, 1, [0, 0.4, 0]);
      prev = p;
    }
    tri(hull, ctr, prev, [-L / 2, ys, -hb * 1.0], C.white, 1, [0, 0.4, 0]);
    tri(hull, ctr, [-L / 2, ys, hb], [-L / 2, ys, -hb], C.white, 1, [0, 0.4, 0]);
  }
  // teak deck with a little camber
  const deckY = (u, t) => sheer(u) + 0.07 * (1 - t * t);
  {
    const G = [];
    for (let i = 0; i <= NI; i++) {
      const u = station(i), hb = halfB(u), row = [];
      for (let k = 0; k <= 10; k++) { const t = k / 5 - 1; row.push([xAt(u, 1), deckY(u, t), t * hb * 1.0]); }
      G.push(row);
    }
    grid(hull, G, C.wood, 5, p => [p[0], p[1] - 1, p[2]]);
  }
  // toe rail along the deck edge
  for (const side of [1, -1]) {
    const G = [];
    for (let i = 0; i <= NI; i++) { const u = station(i), hb = halfB(u); G.push([[xAt(u, 1), sheer(u), side * hb], [xAt(u, 1), sheer(u) + 0.09, side * hb * 0.99]]); }
    grid(hull, G, C.wood, 0, p => [p[0], p[1], 0]);
  }
  // coachroof: a lofted cabin with a raked front, rounded roof edges and long windows
  const cabX0 = -1.5, cabX1 = 2.1;
  const cabW = x => Math.min(halfB((x + L / 2) / L) - 0.5, 1.05);
  const cabBase = x => deckY((x + L / 2) / L, cabW(x) / halfB((x + L / 2) / L));
  const cabTop = x => 1.92 - 0.06 * (x - cabX0) / (cabX1 - cabX0);
  {
    const NS = 10, prof = [];
    const sec = (x, w, b, t, rake) => {
      const pts = [[w, b], [w, t - 0.14], [w - 0.06, t - 0.04], [w - 0.18, t], [0, t + 0.05]];
      const full = pts.concat(pts.slice(0, -1).reverse().map(([z, y]) => [-z, y]));
      return full.map(([z, y]) => [x - rake * Math.max(0, (y - b) / (t - b)), y, z]);
    };
    for (let i = 0; i <= NS; i++) {
      const x = cabX0 + (cabX1 - cabX0) * i / NS;
      prof.push(sec(x, cabW(x), cabBase(x) - 0.02, cabTop(x), i === NS ? 0.45 : i === NS - 1 ? 0.22 : 0));
    }
    // sides and roof in two materials: the roof (top three points of each half) is non-slip grey
    const G = prof;
    const side = G.map(r => r.slice(0, 3)), side2 = G.map(r => r.slice(6, 9));
    const roof = G.map(r => r.slice(2, 7));
    const inside = p => [Math.min(Math.max(p[0], cabX0 + 0.3), cabX1 - 0.6), 1.3, 0];
    grid(hull, side, C.white, 1, inside); grid(hull, side2, C.white, 1, inside); grid(hull, roof, C.off, 0, inside);
    // end caps
    for (const r of [G[0], G[NS]]) {
      const ctr = [r[0][0] + (r === G[NS] ? -0.2 : 0), (r[0][1] + r[4][1]) / 2, 0];
      for (let k = 0; k < r.length - 1; k++) tri(hull, ctr, r[k], r[k + 1], C.white, 1, inside(ctr));
      tri(hull, ctr, r[r.length - 1], r[0], C.white, 1, inside(ctr));
    }
    // windows: dark glass set just proud of the cabin sides, and two in the raked front
    for (const s of [1, -1]) for (const [a, b] of [[-1.15, -0.3], [-0.1, 0.75], [0.95, 1.55]]) {
      const ya = cabBase(a), yb = cabBase(b);
      quad(hull, [a, ya + 0.24, s * (cabW(a) + 0.012)], [b, yb + 0.24, s * (cabW(b) + 0.012)], [b, yb + 0.45, s * (cabW(b) + 0.012)], [a, ya + 0.45, s * (cabW(a) + 0.012)], C.glass, 4, [(a + b) / 2, 1.2, 0]);
    }
  }
  // cockpit coaming and seats, wheel on a pedestal
  for (const s of [1, -1]) {
    box(hull, [-3.05, sheer(0.2) + 0.2, s * 1.0], [2.9, 0.32, 0.06], C.white, 1);
    box(hull, [-3.05, sheer(0.2) + 0.25, s * 0.82], [2.6, 0.06, 0.32], C.wood, 0);
  }
  {
    const cx = -3.75, cy = sheer(0.13) + 0.75, R = 0.48, rim = [];
    box(hull, [cx + 0.18, sheer(0.13) + 0.38, 0], [0.12, 0.7, 0.12], C.metal, 6);
    for (let k = 0; k <= 20; k++) { const a = k / 20 * Math.PI * 2; rim.push([cx, cy + Math.cos(a) * R, Math.sin(a) * R]); }
    for (let k = 0; k < 20; k++) rod(hull, rim[k], rim[k + 1], 0.03, C.rim, 0);
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; rod(hull, [cx + 0.1, cy, 0], [cx, cy + Math.cos(a) * R, Math.sin(a) * R], 0.015, C.metal, 6); }
    rod(hull, [cx + 0.1, cy, 0], [cx + 0.2, cy, 0], 0.05, C.metal, 6);
  }
  // stanchions, lifelines, pulpit and pushpit
  for (const s of [1, -1]) {
    const tops = [], mids = [];
    for (let x = -4.7; x <= 3.7; x += 1.05) {
      const u = (x + L / 2) / L, z = s * (halfB(u) - 0.08), y = sheer(u) + 0.08;
      rod(hull, [x, y, z], [x, y + 0.66, z], 0.022, C.metal, 6);
      tops.push([x, y + 0.66, z]); mids.push([x, y + 0.34, z]);
    }
    const bow = [4.55, sheer(0.96) + 0.7, s * 0.12], bowM = [4.55, sheer(0.96) + 0.38, s * 0.14];
    tops.push(bow); mids.push(bowM);
    rod(hull, [4.55, sheer(0.96) + 0.05, s * 0.14], bow, 0.022, C.metal, 6);
    for (let k = 0; k < tops.length - 1; k++) { rod(hull, tops[k], tops[k + 1], 0.012, C.metal, 6); rod(hull, mids[k], mids[k + 1], 0.01, C.metal, 6); }
  }
  rod(hull, [-4.7, sheer(0.03) + 0.74, 1.15], [-4.7, sheer(0.03) + 0.74, -1.15], 0.022, C.metal, 6);
  // keel fin with a bulb, and the rudder
  {
    const t = 0.1;
    const fin = (x0, x1, y0, x2, x3, y1, th, col) => {
      for (const s of [1, -1]) quad(hull, [x0, y0, s * th], [x1, y0, s * th], [x3, y1, s * th * 0.7], [x2, y1, s * th * 0.7], col, 0, [(x0 + x1) / 2, (y0 + y1) / 2, 0]);
      quad(hull, [x0, y0, th], [x0, y0, -th], [x2, y1, -th * 0.7], [x2, y1, th * 0.7], col, 0, [(x0 + x1) / 2, (y0 + y1) / 2, 0]);
      quad(hull, [x1, y0, th], [x1, y0, -th], [x3, y1, -th * 0.7], [x3, y1, th * 0.7], col, 0, [(x0 + x1) / 2, (y0 + y1) / 2, 0]);
      quad(hull, [x2, y1, th * 0.7], [x3, y1, th * 0.7], [x3, y1, -th * 0.7], [x2, y1, -th * 0.7], col, 0, [(x0 + x1) / 2, y1 + 1, 0]);
    };
    fin(-0.9, 0.9, -0.55, -0.55, 0.45, -2.0, t, C.keel);
    box(hull, [-0.1, -2.05, 0], [1.6, 0.28, 0.36], C.keel, 0);
    fin(-4.35, -3.65, -0.15, -4.25, -3.75, -1.55, 0.06, C.keel);
  }
  // mast, spreaders, standing rigging, lights
  const MX = 1.0, MTOP = 13.2, deckM = cabTop(MX) + 0.04;
  spar(hull, MX, 0, deckM, MTOP, 0.095, 0.06, C.metal, 6);
  for (const s of [1, -1]) rod(hull, [MX, 8.2, 0], [MX, 8.2, s * 0.95], 0.03, C.metal, 6);
  const wire = (p, q) => rod(hull, p, q, 0.012, C.dark, 6);
  const tack = [4.95, sheer(0.995) + 0.02, 0];
  wire(tack, [MX + 0.05, 11.4, 0]);
  wire([-4.95, sheer(0) + 0.05, 0], [MX - 0.05, MTOP, 0]);
  for (const s of [1, -1]) {
    const chain = [MX - 0.1, sheer(0.6) + 0.05, s * (halfB(0.6) - 0.1)];
    wire(chain, [MX, 8.2, s * 0.95]); wire([MX, 8.2, s * 0.95], [MX, 12.6, s * 0.06]);
    wire([MX - 1.2, sheer(0.48) + 0.05, s * (halfB(0.48) - 0.12)], [MX, 8.0, s * 0.05]);
  }
  box(hull, [MX, MTOP + 0.06, 0], [0.12, 0.1, 0.12], [1, 0.97, 0.9], 7);
  box(hull, [4.45, sheer(0.95) + 0.16, -0.3], [0.1, 0.08, 0.05], [1, 0.1, 0.06], 7);
  box(hull, [4.45, sheer(0.95) + 0.16, 0.3], [0.1, 0.08, 0.05], [0.1, 1, 0.3], 7);
  box(hull, [-5.02, sheer(0) + 0.12, 0], [0.04, 0.08, 0.1], [1, 0.97, 0.9], 7);

  // the swinging mainsail and boom (pivot on the mast axis), in two cambers: belly to starboard
  // or to port, picked by which side the wind fills it from
  const BOOMY = deckM + 0.75, CLEW = -3.4;
  function mainRig(bs) {
    const m = Mesh();
    rod(m, [MX - 0.1, BOOMY - 0.05, 0], [CLEW - 0.1, BOOMY - 0.05, 0], 0.075, C.metal, 6);
    const G = [], tk = [MX - 0.12, BOOMY + 0.05], hd = [MX - 0.12, MTOP - 0.5], cl = [CLEW, BOOMY + 0.05];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, row = [];
      for (let j = 0; j <= 8; j++) {
        const s = j / 8;
        const x = tk[0] + (cl[0] - tk[0]) * s * (1 - t) + (hd[0] - tk[0]) * t;
        const y = tk[1] + (cl[1] - tk[1]) * s * (1 - t) + (hd[1] - tk[1]) * t + 0.35 * Math.sin(Math.PI * s) * t * (1 - t) * 0; // straight leech
        const roach = 0.25 * Math.sin(Math.PI * t) * s;
        row.push([x - roach, y, bs * 0.42 * Math.sin(Math.PI * s) * Math.pow(1 - t, 0.8)]);
      }
      G.push(row);
    }
    grid(m, G, C.sail, 3, null);
    return m;
  }
  function jibRig(bs) {
    const m = Mesh(), G = [], tk = [tack[0] - 0.1, tack[1] + 0.25], hd = [MX + 0.15, 11.0], cl = [-0.2, sheer(0.5) + 0.75];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, row = [];
      for (let j = 0; j <= 8; j++) {
        const s = j / 8;
        const x = tk[0] + (cl[0] - tk[0]) * s * (1 - t) + (hd[0] - tk[0]) * t;
        const y = tk[1] + (cl[1] - tk[1]) * s * (1 - t) + (hd[1] - tk[1]) * t;
        row.push([x, y, bs * 0.35 * Math.sin(Math.PI * s) * Math.pow(1 - t, 0.8)]);
      }
      G.push(row);
    }
    grid(m, G, C.sail, 3, null);
    return m;
  }

  function upload(m) {
    const n = m.p.length / 3;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const put = (arr, loc, size) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    put(m.p, 0, 3); put(m.n, 1, 3); put(m.c, 2, 4);
    gl.bindVertexArray(null);
    return { vao, n };
  }
  const meshes = { hull: upload(hull), main: [upload(mainRig(1)), upload(mainRig(-1))], jib: [upload(jibRig(1)), upload(jibRig(-1))] };
  const prog = program(VS_BOAT, FS_BOAT), shadowProg = program(VS_BOAT_SHADOW, FS_EMPTY);

  // ---------- the sea, on the CPU ----------
  // line-for-line seaWave() from shaders.js (fp = 0): returns the surface offset of rest point p
  const LW = [21.0, 8.5, 16.0, 11.0, 19.0, 7.0, 13.5, 9.5], BL = [88.0, 64.0, 47.0, 76.0, 55.0, 38.0], SL = [118.0, 152.0], SA = [0, 0.14];
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function seaWaveJS(px, pz, t, s, deep, wind) {
    const [wx, wz, ws] = wind;
    const A = [], B = [];
    let S = 0;
    for (let i = 0; i < 8; i++) {
      const ang = i * 0.7854 + 0.3, al = Math.max(Math.cos(ang) * wx + Math.sin(ang) * wz, 0), k = 6.2831 / LW[i];
      A[i] = Math.min((0.05 + 0.55 * al * al) * 0.03 * LW[i] * Math.pow(ws, 1.4), 0.11 / k) * s;
      S += k * A[i];
    }
    for (let i = 0; i < 6; i++) {
      const ang = i * 1.0472 + 0.13, al = Math.max(Math.cos(ang) * wx + Math.sin(ang) * wz, 0), k = 6.2831 / BL[i];
      const grow = smoothstep(BL[i] / 110, BL[i] / 110 + 0.8, ws);
      B[i] = Math.min(0.03 * BL[i] * Math.pow(al, 1.5) * Math.pow(ws, 1.5), 0.12 / k) * grow * deep;
      S += k * B[i];
    }
    // storm swell (wind.swell: direction x, z and height), shoaling toward the shore as in the shader
    const sw = wind.swell || [1, 0, 0], sl = Math.hypot(sw[0], sw[1]) || 1, sdx = sw[0] / sl, sdz = sw[1] / sl;
    const shoal = deep + (1 - deep) * (1 + 0.7 * (1 - s)) * smoothstep(0, 0.3, s), C = [];
    for (let i = 0; i < 2; i++) {
      const k = 6.2831 / SL[i];
      C[i] = Math.min(sw[2] * (i ? 0.22 : 0.32) * shoal, Math.min(0.1 / k, 1.35 * s + 0.05 + (9 - 1.35 * s - 0.05) * deep));
      S += k * C[i];
    }
    const Q = Math.min(0.5 + 0.35 * Math.min(1, Math.max(0, (ws - 0.5) / 1.5)), 0.8 / Math.max(S, 1e-3));
    const off = [0, 0, 0];
    const add = (a, L, ang, ph) => {
      const Dx = Math.cos(ang), Dz = Math.sin(ang), k = 6.2831 / L, c = Math.sqrt(9.8 / k) * 0.55;
      const f = k * (Dx * px + Dz * pz) - k * c * t + ph;
      off[0] += Q * a * Dx * Math.cos(f); off[2] += Q * a * Dz * Math.cos(f); off[1] += a * Math.sin(f);
    };
    for (let i = 0; i < 8; i++) add(A[i], LW[i], i * 0.7854 + 0.3, 0);
    for (let i = 0; i < 6; i++) add(B[i], BL[i], i * 1.0472 + 0.13, i * 1.7);
    for (let i = 0; i < 2; i++) add(C[i], SL[i], Math.atan2(sdz, sdx) + SA[i], i * 2.3);
    return off;
  }
  const SEA_Y = 30.88; // the sea's top face (y 31) lowered to its full water level, as in VS_TERRAIN
  // water depth below the surface at a world column (blocks); -1 for land at sea level
  function depthAt(getBlock, isW, x, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    const top = getBlock(bx, 30, bz);
    if (top < 0) return 30; // not loaded yet: assume open water
    if (!isW(top)) return -1;
    let n = 0;
    while (n < 30 && isW(getBlock(bx, 30 - n, bz))) n++;
    return n;
  }
  // surface height at world (x, z): the Gerstner surface moves points sideways, so step back to the
  // rest point that lands here, as the GPU mesh would
  function seaHeight(x, z, t, wind, getBlock, isW) {
    const d = depthAt(getBlock, isW, x, z);
    if (d < 0) return { h: SEA_Y, d };
    const s = Math.min(d, 3) / 3, deep = smoothstep(4, 16, d);
    let px = x, pz = z, o = [0, 0, 0];
    for (let it = 0; it < 3; it++) { o = seaWaveJS(px, pz, t, s, deep, wind); px = x - o[0]; pz = z - o[2]; }
    return { h: SEA_Y + o[1], d };
  }

  // ---------- state and physics ----------
  const b = {
    active: false, aboard: false, pos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, vy: 0, vp: 0, vr: 0,
    speed: 0, side: 0, yawRate: 0, rudder: 0, sail: 0.6, sailV: 0, jib: 0.5, wake: [], wakeT: 0, aground: 0,
  };
  const basis = yaw => ({ f: [-Math.sin(yaw), -Math.cos(yaw)], r: [Math.cos(yaw), -Math.sin(yaw)] });

  function place(x, z, yaw) {
    b.active = true; b.pos = [x, SEA_Y, z]; b.yaw = yaw; b.pitch = b.roll = b.vy = b.vp = b.vr = 0;
    b.speed = 0; b.side = 0; b.yawRate = 0; b.rudder = 0; b.wake = [];
  }
  // can a 10 x 3.4 m hull sit here? every probe over water at least 1.5 blocks deep
  function fits(x, z, yaw, getBlock, isW) {
    const { f, r } = basis(yaw);
    for (const [a, c] of [[0, 0], [4.6, 0], [-4.8, 0], [-4.5, 1.4], [-4.5, -1.4], [0, 1.7], [0, -1.7], [2.8, 1.2], [2.8, -1.2]]) {
      const d = depthAt(getBlock, isW, x + f[0] * a + r[0] * c, z + f[1] * a + r[1] * c);
      if (d < 2) return false;
    }
    return true;
  }

  function update(dt, t, input, wind, getBlock, isW) {
    if (!b.active) return;
    b.t = t;
    const { f, r } = basis(b.yaw);
    // throttle and helm (only while aboard)
    const thrust = b.aboard ? input.fwd * (input.boost ? 1.5 : 1) : 0;
    const vmax = thrust >= 0 ? 8.5 : 3;
    b.speed += (thrust * vmax - b.speed) * dt * (thrust ? 0.28 : 0.12);
    b.rudder += ((b.aboard ? input.turn : 0) - b.rudder) * Math.min(1, dt * 3);
    const steer = Math.min(1, Math.abs(b.speed) / 2.5) * Math.sign(b.speed || 1);
    b.yawRate += (-b.rudder * 0.55 * steer - b.yawRate) * Math.min(1, dt * 2.2);
    b.yaw += b.yawRate * dt;
    // the sea: heights under the bow, stern and both sides
    const P = (a, c) => [b.pos[0] + f[0] * a + r[0] * c, b.pos[2] + f[1] * a + r[1] * c];
    const pts = [P(4.2, 0), P(-4.2, 0), P(0, -1.6), P(0, 1.6), P(0, 0)];
    const H = pts.map(([x, z]) => seaHeight(x, z, t, wind, getBlock, isW));
    // running down the face of a swell speeds her up, climbing one slows her
    const slope = (H[0].h - H[1].h) / 8.4;
    b.speed -= slope * 2.2 * dt;
    // wind drift and leeway
    const ws = wind[2];
    b.pos[0] += (f[0] * b.speed + wind[0] * ws * 0.25) * dt;
    b.pos[2] += (f[1] * b.speed + wind[1] * ws * 0.25) * dt;
    // running aground: shallow water or land under the bow or stern pushes her back and stops her
    const bowD = depthAt(getBlock, isW, ...P(4.9 * Math.sign(b.speed || 1), 0));
    if (bowD < 1.2 || H[2].d < 0.8 || H[3].d < 0.8) {
      b.pos[0] -= (f[0] * b.speed + wind[0] * ws * 0.25) * dt * 1.5;
      b.pos[2] -= (f[1] * b.speed + wind[1] * ws * 0.25) * dt * 1.5;
      if (Math.abs(b.speed) > 1 && b.aground <= 0) b.aground = 0.6;
      b.speed *= -0.2;
    }
    b.aground -= dt;
    // buoyancy on springs: she settles to the mean of the surface and tilts with it
    const mean = H[4].h * 0.5 + (H[0].h + H[1].h + H[2].h + H[3].h) / 8;
    const draft = 0.02 + 0.04 * Math.min(1, Math.abs(b.speed) / 6); // squats a little at speed
    b.vy += ((mean - draft - b.pos[1]) * 30 - b.vy * 9) * dt;
    b.pos[1] += b.vy * dt;
    // sails: the boom swings to leeward of the apparent wind, sheeted in close-hauled, out running
    const A = [wind[0] * ws * 4 - f[0] * b.speed, wind[1] * ws * 4 - f[1] * b.speed];
    const aF = A[0] * f[0] + A[1] * f[1], aR = A[0] * r[0] + A[1] * r[1], aL = Math.hypot(aF, aR) || 1;
    const lee = aR >= 0 ? 1 : -1, open = 0.18 + 1.15 * (1 + aF / aL) / 2;
    const target = lee * open;
    b.sailV += ((target - b.sail) * 6 - b.sailV * 3) * dt;
    b.sail += b.sailV * dt;
    // heel: leeward under the wind in the sails, outward in a turn
    const heel = lee * Math.min(1, ws / 2) * Math.abs(aR / aL) * 0.2 + b.yawRate * b.speed * 0.03;
    const tp = Math.atan2(H[0].h - H[1].h, 8.4), tr = Math.atan2(H[2].h - H[3].h, 3.2) * 0.8 + heel;
    b.vp += ((tp - b.pitch) * 16 - b.vp * 6) * dt; b.pitch += b.vp * dt;
    b.vr += ((tr - b.roll) * 9 - b.vr * 2.6) * dt; b.roll += b.vr * dt;
    // wake: a trail of points behind the stern, aging, for the water shader
    for (const w of b.wake) w[2] += dt;
    b.wakeT -= dt;
    const stern = P(-4.8, 0);
    if (b.wakeT <= 0) { b.wakeT = 0.35; b.wake.unshift([stern[0], stern[1], 0, Math.abs(b.speed)]); if (b.wake.length > 16) b.wake.pop(); }
    if (b.wake.length) { b.wake[0][0] = stern[0]; b.wake[0][1] = stern[1]; b.wake[0][3] = Math.abs(b.speed); }
    while (b.wake.length && b.wake[b.wake.length - 1][2] > 9) b.wake.pop();
  }

  // ---------- matrices ----------
  function model() {
    const { f, r } = basis(b.yaw);
    const F = [f[0], 0, f[1]], U = [0, 1, 0], R = [r[0], 0, r[1]];
    const cp = Math.cos(b.pitch), sp = Math.sin(b.pitch), cr = Math.cos(b.roll), sr = Math.sin(b.roll);
    const F1 = F.map((v, i) => v * cp + U[i] * sp), U1 = F.map((v, i) => -v * sp + U[i] * cp);
    const R2 = R.map((v, i) => v * cr - U1[i] * sr), U2 = U1.map((v, i) => v * cr + R[i] * sr);
    return new Float32Array([F1[0], F1[1], F1[2], 0, U2[0], U2[1], U2[2], 0, R2[0], R2[1], R2[2], 0, b.pos[0], b.pos[1], b.pos[2], 1]);
  }
  const mul = (a, c) => { const o = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * c[i * 4 + k]; o[i * 4 + j] = s; } return o; };
  // rotation by angle a about the axis through p with direction d (local boat coordinates)
  function rotAbout(p, d, a) {
    d = norm(d);
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c, [x, y, z] = d;
    const R = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1], Ti = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1];
    return mul(mul(T, R), Ti);
  }
  function parts() {
    const M = model();
    // the boom swings about the mast: angle > 0 puts it out to starboard (+z)
    const main = mul(M, rotAbout([MX, 0, 0], [0, 1, 0], b.sail));
    const jib = mul(M, rotAbout(tack, [MX + 0.15 - tack[0], 11.0 - tack[1], 0], b.sail * 0.7));
    const side = b.sail >= 0 ? 0 : 1;
    return [[meshes.hull, M], [meshes.main[side], main], [meshes.jib[side], jib]];
  }

  function draw(vp, lightVP, setCommonFn, shadowTex, shadowsOn) {
    if (!b.active) return;
    gl.useProgram(prog.p);
    setCommonFn(prog);
    setU(prog, 'uVP', vp); setU(prog, 'uLightVP', lightVP); setU(prog, 'uShadowOn', shadowsOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    const l = prog.u.uShadow; if (l) gl.uniform1i(l, 0);
    gl.disable(gl.CULL_FACE);
    for (const [m, M] of parts()) { setU(prog, 'uModel', M); gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.n); }
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
  function drawShadow(lightVP) {
    if (!b.active) return;
    gl.useProgram(shadowProg.p);
    setU(shadowProg, 'uLightVP', lightVP);
    gl.disable(gl.CULL_FACE);
    for (const [m, M] of parts()) { setU(shadowProg, 'uModel', M); gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.n); }
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }
  // wake points for the water shader: x, z, age (s), speed then (m/s)
  const wakeBuf = new Float32Array(64);
  function wakeUniform() {
    wakeBuf.fill(0);
    const n = b.active ? b.wake.length : 0;
    for (let i = 0; i < n; i++) wakeBuf.set(b.wake[i], i * 4);
    return { buf: wakeBuf, n };
  }
  return { state: b, place, fits, update, draw, drawShadow, wakeUniform, seaHeight, depthAt, basis, SEA_Y };
}

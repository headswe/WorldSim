// Emberwood open-sea detail: an FFT ocean patch (after Tessendorf 2001, "Simulating Ocean Water").
// A wind-driven Phillips spectrum is built on the CPU; each frame the GPU advances it in time
// (deep-water dispersion, w = sqrt(g k)) and inverse-transforms it with a radix-2 Stockham FFT,
// 7 horizontal and 7 vertical passes over a 128x128 grid. The result is one tiling, mipmapped
// texture: R/G the surface slope, B the Jacobian of the choppy displacement (folding -> foam),
// A the height. The water shader samples it at two scales for ripples and whitecaps; the big
// swells stay Gerstner waves in the vertex shader. Needs float render targets; without them the
// water shader falls back to analytic chop.
const OCEAN_N = 128, OCEAN_L = 96; // grid size, patch size in blocks (1 block = 1 m)

const FS_OCEAN_SPEC = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
uniform sampler2D uH0; uniform float uTime; uniform float uL; uniform float uN;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
void main(){
  ivec2 ij=ivec2(gl_FragCoord.xy);
  vec2 n=vec2(ij); n=mix(n,n-uN,step(uN*0.5,n));
  vec2 k=6.2831853*n/uL;
  float kl=max(length(k),1e-5);
  vec4 h0=texelFetch(uH0,ij,0);
  float w=sqrt(9.81*kl), c=cos(w*uTime), s=sin(w*uTime);
  // h(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
  vec2 h=cmul(h0.xy,vec2(c,s))+cmul(h0.zw,vec2(c,-s));
  vec2 ih=vec2(-h.y,h.x); // i*h
  // two real fields share each complex transform: A + iB
  vec2 sx=ih*k.x, sz=ih*k.y;                 // slopes dh/dx, dh/dz
  vec2 dx=-ih*k.x/kl, dz=-ih*k.y/kl;         // choppy displacement
  vec2 dxx=h*k.x*k.x/kl, dzz=h*k.y*k.y/kl, dxz=h*k.x*k.y/kl; // its derivatives
  if(ij==ivec2(0)){ sx=sz=dx=dz=dxx=dzz=dxz=h=vec2(0.0); }
  o0=vec4(sx+vec2(-sz.y,sz.x), dx+vec2(-dz.y,dz.x));
  o1=vec4(dxx+vec2(-dzz.y,dzz.x), dxz+vec2(-h.y,h.x));
}`;
// one radix-2 Stockham pass: output index i combines elements i0 and i0+N/2 of the input with a
// twiddle e^{+2 pi i (i/span)} (inverse transform); after log2(N) passes the order is natural
const FS_OCEAN_FFT = `#version 300 es
precision highp float;
in vec2 vUV;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
uniform sampler2D uA; uniform sampler2D uB; uniform float uSpan; uniform float uN; uniform int uVert;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  float i=float(uVert==1 ? p.y : p.x), hs=uSpan*0.5;
  float e=floor(i/uSpan)*hs+mod(i,hs);
  ivec2 pe=p, po=p;
  if(uVert==1){ pe.y=int(e); po.y=int(e+uN*0.5); } else { pe.x=int(e); po.x=int(e+uN*0.5); }
  float a=6.2831853*i/uSpan;
  vec2 tw=vec2(cos(a),sin(a));
  vec4 ae=texelFetch(uA,pe,0), ao=texelFetch(uA,po,0), be=texelFetch(uB,pe,0), bo=texelFetch(uB,po,0);
  o0=vec4(ae.xy+cmul(tw,ao.xy), ae.zw+cmul(tw,ao.zw));
  o1=vec4(be.xy+cmul(tw,bo.xy), be.zw+cmul(tw,bo.zw));
}`;
const FS_OCEAN_OUT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uA; uniform sampler2D uB; uniform float uChop;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  // the (-1)^(x+y) sign of a centred spectrum is not needed: frequencies are stored wrapped
  vec4 a=texelFetch(uA,p,0), b=texelFetch(uB,p,0);
  float jxx=1.0+uChop*b.x, jzz=1.0+uChop*b.y, jxz=uChop*b.z;
  o=vec4(a.x, a.y, jxx*jzz-jxz*jxz, b.w);
}`;

function createOcean(gl, program, setU, setI, hasFloat) {
  const N = OCEAN_N, L = OCEAN_L;
  if (!hasFloat) return { ok: false, tex: null, update() {} };
  const progs = { spec: program(VS_QUAD, FS_OCEAN_SPEC), fft: program(VS_QUAD, FS_OCEAN_FFT), out: program(VS_QUAD, FS_OCEAN_OUT) };
  const mk = (fmt, type, filter, wrap) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, filter === gl.LINEAR_MIPMAP_LINEAR ? Math.log2(N) + 1 : 1, fmt, N, N);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  };
  const h0 = mk(gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.CLAMP_TO_EDGE);
  // ping-pong pairs of two-attachment targets (32-bit floats: the FFT sums 16k terms)
  const pair = () => {
    const a = mk(gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.CLAMP_TO_EDGE), b = mk(gl.RGBA32F, gl.FLOAT, gl.NEAREST, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    return { a, b, fbo };
  };
  const P = [pair(), pair()];
  const tex = mk(gl.RGBA16F, gl.HALF_FLOAT, gl.LINEAR_MIPMAP_LINEAR, gl.REPEAT);
  const outFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, P[0].fbo);
  const ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok || !ok2) return { ok: false, tex: null, update() {} };
  const vao = gl.createVertexArray();

  // fixed Gaussian noise, so a change of wind reshapes the same sea instead of rolling a new one
  const gauss = new Float32Array(N * N * 2);
  {
    let s = 0x9e3779b9;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
    for (let i = 0; i < gauss.length; i += 2) {
      const r = Math.sqrt(-2 * Math.log(rnd())), a = 6.2831853 * rnd();
      gauss[i] = r * Math.cos(a); gauss[i + 1] = r * Math.sin(a);
    }
  }
  let built = null;
  const data = new Float32Array(N * N * 4);
  // Phillips spectrum: P(k) = A exp(-1/(k Lw)^2) / k^4 * (k^.w)^2, Lw = V^2/g the largest wave
  // the wind raises; waves against the wind are damped, the tiniest ones suppressed
  // The long swells are the Gerstner waves already, so wavelengths over ~12 blocks are faded out
  // here (they would also show the patch tiling). Short waves grow with the wind too.
  function build(wx, wz, V) {
    const Lw = V * V / 9.81, A = 0.00045 * 0.0225 * Math.max(0.05, (V - 2) / 5), small = 0.12, k0 = 6.2831853 / 12;
    const phil = (kx, kz) => {
      const k2 = kx * kx + kz * kz;
      if (k2 < 1e-8) return 0;
      const kl = Math.sqrt(k2), d = (kx * wx + kz * wz) / kl;
      let p = A * Math.exp(-1 / (k2 * Lw * Lw)) / (k2 * k2) * d * d * Math.exp(-k2 * small * small) * (1 - Math.exp(-k2 / (k0 * k0)));
      if (d < 0) p *= 0.07;
      return p;
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const ni = i < N / 2 ? i : i - N, nj = j < N / 2 ? j : j - N;
      const kx = 6.2831853 * ni / L, kz = 6.2831853 * nj / L;
      const a = Math.sqrt(phil(kx, kz) / 2), b = Math.sqrt(phil(-kx, -kz) / 2);
      const n = j * N + i, m = (((N - j) % N) * N + ((N - i) % N));
      // h0(k) and conj(h0(-k))
      data[n * 4] = gauss[n * 2] * a; data[n * 4 + 1] = gauss[n * 2 + 1] * a;
      data[n * 4 + 2] = gauss[m * 2] * b; data[n * 4 + 3] = -gauss[m * 2 + 1] * b;
    }
    gl.bindTexture(gl.TEXTURE_2D, h0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
    built = { wx, wz, V };
  }

  function update(time, wind) {
    // wind = [dirx, dirz, strength 0..2.2] from the weather; strength 1 is a fresh breeze (~7 m/s)
    const V = 2 + 5 * Math.max(0.1, wind[2]);
    if (!built || Math.abs(V - built.V) > 0.25 || wind[0] * built.wx + wind[1] * built.wz < 0.985) build(wind[0], wind[1], V);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, N, N);
    gl.bindVertexArray(vao);
    let pr = progs.spec;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, P[0].fbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, h0); setI(pr, 'uH0', 0);
    setU(pr, 'uTime', time); setU(pr, 'uL', L); setU(pr, 'uN', N);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pr = progs.fft;
    gl.useProgram(pr.p);
    setU(pr, 'uN', N); setI(pr, 'uA', 0); setI(pr, 'uB', 1);
    let cur = 0;
    for (const vert of [0, 1]) for (let span = 2; span <= N; span *= 2) {
      const src = P[cur], dst = P[cur ^ 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.a);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, src.b);
      gl.uniform1i(pr.u.uVert, vert); setU(pr, 'uSpan', span);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur ^= 1;
    }
    pr = progs.out;
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P[cur].a); setI(pr, 'uA', 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, P[cur].b); setI(pr, 'uB', 1);
    setU(pr, 'uChop', -1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
  }
  // Some phone GPUs accept the float targets but return garbage from these passes (a sea of
  // folding foam everywhere), so the first result is checked once: the Jacobian must average
  // near 1 and every value must be finite, otherwise the ocean switches itself off and the
  // water uses the analytic chop instead.
  let checked = false;
  function update2(time, wind) {
    update(time, wind);
    if (checked) return;
    checked = true;
    let good = false;
    try {
      while (gl.getError() !== gl.NO_ERROR) {}
      const r = api.readback();
      const fin = r.r.every(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      good = fin && gl.getError() === gl.NO_ERROR && r.meanJ > 0.85 && r.meanJ < 1.15 && r.foamFrac < 0.6 &&
        Math.abs(r.r[0][0]) < 4 && Math.abs(r.r[0][1]) < 4 && Math.abs(r.r[1][0]) < 4 && Math.abs(r.r[1][1]) < 4;
    } catch (e) { good = false; }
    if (!good) { api.ok = false; console.warn('ocean: FFT result looks wrong on this GPU, using the analytic chop'); }
  }
  const api = { ok: true, tex, update: update2, L, readback() {
    // for tests: min/max of each channel of the result
    const px = new Float32Array(N * N * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const r = [[1e9, -1e9], [1e9, -1e9], [1e9, -1e9], [1e9, -1e9]];
    let neg = 0, sj = 0;
    for (let i = 0; i < N * N; i++) { for (let c = 0; c < 4; c++) { r[c][0] = Math.min(r[c][0], px[i * 4 + c]); r[c][1] = Math.max(r[c][1], px[i * 4 + c]); } if (px[i * 4 + 2] < 0.5) neg++; sj += px[i * 4 + 2]; }
    return { r, foamFrac: neg / (N * N), meanJ: sj / (N * N) };
  } };
  return api;
}

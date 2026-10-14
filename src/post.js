// Emberwood post-processing: HDR scene target, SSAO, god rays, bloom, lens flare,
// depth of field, motion blur, grading, FXAA and stylised looks.
const VS_QUAD = `#version 300 es
out vec2 vUV;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); vUV=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const POST_COMMON = `#version 300 es
precision highp float; precision highp int;
in vec2 vUV; out vec4 o;
uniform vec2 uNearFar;
float linDepth(float d){ float z=d*2.0-1.0; return 2.0*uNearFar.x*uNearFar.y/(uNearFar.y+uNearFar.x-z*(uNearFar.y-uNearFar.x)); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
`;

const FS_AO = POST_COMMON + `
uniform sampler2D uDepth; uniform vec2 uTexel;
void main(){
  float d0=texture(uDepth,vUV).r;
  if(d0>=1.0){ o=vec4(1.0); return; }
  float z0=linDepth(d0);
  float rad=clamp(22.0/z0,2.0,48.0);
  float ang=hash12(gl_FragCoord.xy)*6.2831;
  // the surface's own depth slope (per pixel), from whichever neighbour is closer in depth so
  // edges don't skew it; samples are compared with that plane, so a flat floor or the sea seen
  // at a grazing angle doesn't occlude itself in horizontal bands
  float zr=linDepth(texture(uDepth,vUV+vec2(uTexel.x,0.0)).r), zl=linDepth(texture(uDepth,vUV-vec2(uTexel.x,0.0)).r);
  float zu=linDepth(texture(uDepth,vUV+vec2(0.0,uTexel.y)).r), zd=linDepth(texture(uDepth,vUV-vec2(0.0,uTexel.y)).r);
  vec2 g=vec2(abs(zr-z0)<abs(z0-zl) ? zr-z0 : z0-zl, abs(zu-z0)<abs(z0-zd) ? zu-z0 : z0-zd);
  float occ=0.0;
  for(int i=0;i<14;i++){
    float a=ang+float(i)*2.39996, r=rad*(float(i)+0.5)/14.0;
    vec2 off=vec2(cos(a),sin(a))*r;
    float z=linDepth(texture(uDepth,vUV+off*uTexel).r);
    float dz=z0+dot(g,off)-z;
    occ+=clamp(dz/(0.35+z0*0.015),0.0,1.0)*(1.0-smoothstep(1.2,3.5,dz));
  }
  o=vec4(vec3(clamp(1.0-occ/14.0*1.3,0.0,1.0)),1.0);
}`;

const FS_RAYS = POST_COMMON + `
uniform sampler2D uDepth; uniform vec2 uSun; uniform float uSunVis; uniform vec3 uSunCol; uniform float uAspect;
void main(){
  vec2 dlt=(vUV-uSun)/56.0;
  vec2 p=vUV; float illum=1.0, acc=0.0;
  float j=hash12(gl_FragCoord.xy);
  p-=dlt*j;
  for(int i=0;i<56;i++){
    p-=dlt;
    float sky=step(1.0,texture(uDepth,p).r);
    float fall=1.0-smoothstep(0.0,0.6,length((p-uSun)*vec2(uAspect,1.0)));
    acc+=sky*fall*illum;
    illum*=0.97;
  }
  o=vec4(uSunCol*acc/56.0*uSunVis,1.0);
}`;

const FS_BRIGHT = POST_COMMON + `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh; uniform float uEnc;
void main(){
  vec3 c=(texture(uSrc,vUV+vec2(-1,-1)*uTexel).rgb+texture(uSrc,vUV+vec2(1,-1)*uTexel).rgb+
          texture(uSrc,vUV+vec2(-1,1)*uTexel).rgb+texture(uSrc,vUV+vec2(1,1)*uTexel).rgb)*0.25/uEnc;
  c=min(c,vec3(64.0));
  float l=max(c.r,max(c.g,c.b));
  float knee=0.5, s=clamp(l-uThresh+knee,0.0,2.0*knee); s=s*s/(4.0*knee+1e-4);
  o=vec4(c*max(s,l-uThresh)/max(l,1e-4),1.0);
}`;

const FS_DOWN = POST_COMMON + `
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 c=texture(uSrc,vUV).rgb*4.0;
  c+=texture(uSrc,vUV+vec2(-1,-1)*uTexel).rgb+texture(uSrc,vUV+vec2(1,-1)*uTexel).rgb;
  c+=texture(uSrc,vUV+vec2(-1,1)*uTexel).rgb+texture(uSrc,vUV+vec2(1,1)*uTexel).rgb;
  o=vec4(c/8.0,1.0);
}`;

const FS_UP = POST_COMMON + `
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec2 t=uTexel*1.5;
  vec3 c=texture(uSrc,vUV).rgb*4.0;
  c+=(texture(uSrc,vUV+vec2(-t.x,0)).rgb+texture(uSrc,vUV+vec2(t.x,0)).rgb+texture(uSrc,vUV+vec2(0,-t.y)).rgb+texture(uSrc,vUV+vec2(0,t.y)).rgb)*2.0;
  c+=texture(uSrc,vUV-t).rgb+texture(uSrc,vUV+t).rgb+texture(uSrc,vUV+vec2(t.x,-t.y)).rgb+texture(uSrc,vUV+vec2(-t.x,t.y)).rgb;
  o=vec4(c/16.0,1.0);
}`;

const FS_DOF = POST_COMMON + `
uniform sampler2D uSrc; uniform sampler2D uDepth; uniform vec2 uTexel; uniform float uFocus; uniform float uAperture;
float coc(float z){ return clamp(abs(z-uFocus)/max(z,0.1)*uAperture,0.0,1.0); }
void main(){
  float z0=linDepth(texture(uDepth,vUV).r), c0=coc(z0);
  vec3 acc=texture(uSrc,vUV).rgb; float w=1.0;
  const float MAXR=8.0;
  for(int i=0;i<28;i++){
    float a=float(i)*2.39996, r=sqrt((float(i)+0.5)/28.0);
    vec2 uv=vUV+vec2(cos(a),sin(a))*r*MAXR*uTexel;
    float zs=linDepth(texture(uDepth,uv).r);
    float cs=zs<z0 ? coc(zs) : min(coc(zs),c0);
    float wt=smoothstep(r-0.15,r,cs);
    acc+=texture(uSrc,uv).rgb*wt; w+=wt;
  }
  o=vec4(acc/w,1.0);
}`;

const FS_COMPOSITE = POST_COMMON + `
uniform sampler2D uSrc, uDepth, uBloom, uRays, uAO, uFlare, uDepthO;
uniform mat4 uInvVP, uPrevVP;
uniform float uMotion, uBloomAmt, uRaysAmt, uAOAmt, uFlareAmt, uExposure, uUnder, uTime, uEnc, uSat, uGrade, uSunVis;
uniform vec2 uSun; uniform vec3 uSunCol;
vec3 aces(vec3 c){ return clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),0.0,1.0); }
void main(){
  vec2 uv=vUV;
  if(uUnder>0.5) uv+=vec2(sin(uv.y*24.0+uTime*2.1),cos(uv.x*19.0+uTime*1.7))*0.0035;
  float d=texture(uDepth,uv).r;
  vec3 c=texture(uSrc,uv).rgb;
  if(uMotion>0.0){
    vec4 wp=uInvVP*vec4(uv*2.0-1.0,d*2.0-1.0,1.0); wp/=wp.w;
    vec4 pp=uPrevVP*wp;
    vec2 vel=(uv-(pp.xy/pp.w*0.5+0.5))*uMotion;
    float l=length(vel); if(l>0.04) vel*=0.04/l;
    if(pp.w>0.0 && l>0.0005){
      float jit=hash12(gl_FragCoord.xy);
      for(int i=1;i<10;i++) c+=texture(uSrc,uv-vel*((float(i)+jit)/10.0)).rgb;
      c/=10.0;
    }
  }
  c/=uEnc;
  float lz=linDepth(d);
  // no ambient occlusion on water: the opaque depth (copied before the water pass) lies behind it,
  // and a wide flat surface at a grazing angle only picks up depth-precision bands
  bool wet=texture(uDepthO,uv).r>d+1e-6;
  if(uAOAmt>0.0 && !wet) c*=mix(1.0,texture(uAO,uv).r,uAOAmt*(1.0-smoothstep(50.0,140.0,lz)));
  c+=texture(uBloom,uv).rgb*uBloomAmt;
  c+=texture(uRays,uv).rgb*uRaysAmt;
  if(uFlareAmt>0.0){
    vec2 g=vec2(1.0)-uv, gv=(vec2(0.5)-g)*0.42;
    vec3 fl=vec3(0.0);
    for(int i=0;i<6;i++){
      vec2 s=g+gv*float(i);
      float w=pow(max(1.0-length(vec2(0.5)-s)/0.7071,0.0),8.0);
      fl+=texture(uFlare,s).rgb*w*vec3(1.0,0.85-0.1*float(i),0.55+0.12*float(i));
    }
    vec2 hv=normalize(vec2(0.5)-g+1e-5)*0.46;
    float hw=pow(max(1.0-length(vec2(0.5)-fract(g+hv))/0.7071,0.0),6.0);
    fl+=texture(uFlare,g+hv).rgb*hw*vec3(0.6,0.8,1.0);
    vec2 sd=(uv-uSun)*vec2(1.6,1.0);
    float star=pow(max(0.0,1.0-abs(sd.x*sd.y)*900.0),6.0)*exp(-length(sd)*5.0);
    c+=fl*uFlareAmt+uSunCol*star*uSunVis*0.25*uFlareAmt;
  }
  if(uUnder>0.5){
    c=c*vec3(0.32,0.62,0.66)+vec3(0.006,0.03,0.035);
    c=mix(c,vec3(0.012,0.05,0.055),1.0-exp(-lz*0.09));
  }
  c*=uExposure;
  c=aces(c);
  float L=dot(c,vec3(0.2126,0.7152,0.0722));
  c=mix(vec3(L),c,uSat);
  c+=uGrade*((1.0-L)*vec3(-0.006,0.0,0.012)+L*vec3(0.025,0.008,-0.02));
  c=mix(c,c*c*(3.0-2.0*c),0.25*uGrade);
  c=pow(clamp(c,0.0,1.0),vec3(1.0/2.2));
  o=vec4(c,1.0);
}`;

const FS_FINAL = POST_COMMON + `
uniform sampler2D uSrc, uDepth; uniform vec2 uTexel, uRes;
uniform int uLook; uniform float uCA, uVig, uFXAA, uTime;
const vec3 LUMA=vec3(0.299,0.587,0.114);
vec3 tex(vec2 uv){ return texture(uSrc,uv).rgb; }
vec3 fxaa(vec2 uv){
  vec2 t=uTexel;
  vec3 nw=tex(uv+vec2(-1,-1)*t), ne=tex(uv+vec2(1,-1)*t), sw=tex(uv+vec2(-1,1)*t), se=tex(uv+vec2(1,1)*t), m=tex(uv);
  float lNW=dot(nw,LUMA), lNE=dot(ne,LUMA), lSW=dot(sw,LUMA), lSE=dot(se,LUMA), lM=dot(m,LUMA);
  float lMin=min(lM,min(min(lNW,lNE),min(lSW,lSE))), lMax=max(lM,max(max(lNW,lNE),max(lSW,lSE)));
  vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));
  float red=max((lNW+lNE+lSW+lSE)*0.03125,1.0/128.0);
  float rcp=1.0/(min(abs(dir.x),abs(dir.y))+red);
  dir=clamp(dir*rcp,-8.0,8.0)*t;
  vec3 A=0.5*(tex(uv+dir*(1.0/3.0-0.5))+tex(uv+dir*(2.0/3.0-0.5)));
  vec3 B=A*0.5+0.25*(tex(uv-dir*0.5)+tex(uv+dir*0.5));
  float lB=dot(B,LUMA);
  return (lB<lMin||lB>lMax)?A:B;
}
vec3 kuwahara(vec2 uv){
  vec3 m0=vec3(0),m1=vec3(0),m2=vec3(0),m3=vec3(0),s0=vec3(0),s1=vec3(0),s2=vec3(0),s3=vec3(0);
  for(int j=0;j<=3;j++) for(int i=0;i<=3;i++){
    vec3 c;
    c=tex(uv+vec2(-i,-j)*uTexel); m0+=c; s0+=c*c;
    c=tex(uv+vec2( i,-j)*uTexel); m1+=c; s1+=c*c;
    c=tex(uv+vec2( i, j)*uTexel); m2+=c; s2+=c*c;
    c=tex(uv+vec2(-i, j)*uTexel); m3+=c; s3+=c*c;
  }
  m0/=16.0; m1/=16.0; m2/=16.0; m3/=16.0;
  float v0=dot(s0/16.0-m0*m0,vec3(1)), v1=dot(s1/16.0-m1*m1,vec3(1)), v2=dot(s2/16.0-m2*m2,vec3(1)), v3=dot(s3/16.0-m3*m3,vec3(1));
  vec3 r=m0; float v=v0;
  if(v1<v){v=v1;r=m1;} if(v2<v){v=v2;r=m2;} if(v3<v){v=v3;r=m3;}
  return r;
}
float bayer4(vec2 p){
  ivec2 q=ivec2(mod(p,4.0));
  int i=q.x+q.y*4;
  int b[16]=int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
  return (float(b[i])+0.5)/16.0;
}
void main(){
  vec2 uv=vUV;
  vec3 c;
  if(uLook==3){
    vec2 cell=vec2(3.0);
    vec2 px=floor(uv*uRes/cell)*cell+cell*0.5;
    c=tex(px/uRes);
    float th=bayer4(floor(uv*uRes/cell))-0.5;
    c=floor(c*7.0+th*0.7+0.5)/7.0;
    c=mix(c,c*vec3(1.05,0.95,0.85),0.5);
  } else if(uLook==1){
    c=kuwahara(uv);
    float paper=hash12(floor(uv*uRes/2.0))*0.06+hash12(floor(uv*uRes/9.0))*0.05;
    c=c*(0.94+paper);
    c=mix(vec3(dot(c,LUMA)),c,1.15);
  } else {
    c=uFXAA>0.5?fxaa(uv):tex(uv);
    if(uCA>0.0){
      vec2 dir=(uv-0.5)*uCA*0.006;
      c.r=mix(c.r,tex(uv+dir).r,0.85);
      c.b=mix(c.b,tex(uv-dir).b,0.85);
    }
  }
  if(uLook==2){
    float L=dot(c,LUMA);
    float q=floor(L*4.0+0.6)/4.0;
    c=c*(q+0.08)/max(L,0.02);
    float z=linDepth(texture(uDepth,uv).r), e=0.0;
    for(int i=0;i<4;i++){
      vec2 o2=vec2(i==0?1.0:i==1?-1.0:0.0, i==2?1.0:i==3?-1.0:0.0)*uTexel*1.5;
      float zn=linDepth(texture(uDepth,uv+o2).r);
      e+=step(0.08,abs(zn-z)/z);
      e+=step(0.25,abs(dot(tex(uv+o2),LUMA)-L));
    }
    c=mix(c*vec3(1.04,0.98,0.9),vec3(0.09,0.05,0.04),clamp(e*0.5,0.0,1.0));
  }
  vec2 vc=(uv-0.5)*vec2(uRes.x/uRes.y,1.0);
  c*=mix(1.0,smoothstep(1.15,0.25,length(vc)),uVig);
  o=vec4(c,1.0);
}`;

function createPost(gl, program, setU, setI) {
  const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
  const enc = hasFloat ? 1 : 0.25;
  const P = {
    ao: program(VS_QUAD, FS_AO), rays: program(VS_QUAD, FS_RAYS), bright: program(VS_QUAD, FS_BRIGHT),
    down: program(VS_QUAD, FS_DOWN), up: program(VS_QUAD, FS_UP), dof: program(VS_QUAD, FS_DOF),
    comp: program(VS_QUAD, FS_COMPOSITE), final: program(VS_QUAD, FS_FINAL),
  };
  const vao = gl.createVertexArray();
  let W = 0, H = 0, T = null;

  function mkTex(w, h, kind) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (kind === 'depth') gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    else if (kind === 'hdr' && hasFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = kind === 'depth' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h, kind, withDepth) {
    const color = mkTex(w, h, kind), depth = withDepth ? mkTex(w, h, 'depth') : null;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w, h, color, depth, fbo };
  }
  function free(t) { gl.deleteTexture(t.color); if (t.depth) gl.deleteTexture(t.depth); gl.deleteFramebuffer(t.fbo); }
  function all() { return [T.scene, T.copy, T.dof, T.ldr, T.ao, T.rays, ...T.bloom]; }
  function resize(w, h) {
    if (w === W && h === H) return;
    if (T) all().forEach(free);
    W = w; H = h;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    T = {
      scene: target(w, h, 'hdr', true), copy: target(w, h, 'hdr', true), dof: target(w, h, 'hdr'),
      ldr: target(w, h, 'ldr'), ao: target(hw, hh, 'ldr'), rays: target(hw, hh, 'hdr'), bloom: [],
    };
    for (let i = 0; i < 6; i++) T.bloom.push(target(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)), 'hdr'));
    // clear so disabled effects read black, not garbage
    for (const t of all()) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.ao.fbo); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 1);
  }
  function pass(prog, tgt, setup) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fbo : null);
    gl.viewport(0, 0, tgt ? tgt.w : W, tgt ? tgt.h : H);
    gl.useProgram(prog.p);
    setup(prog);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function tex(prog, name, unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); setI(prog, name, unit); }

  return {
    enc,
    hasFloat,
    get scene() { return T.scene; },
    get copy() { return T.copy; },
    resize,
    beginScene() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fbo);
      gl.viewport(0, 0, W, H);
    },
    copyScene() {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.scene.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.copy.fbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fbo);
    },
    run(o) {
      const fx = o.fx, nf = o.nearFar;
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(false);
      if (fx.ssao) pass(P.ao, T.ao, p => {
        tex(p, 'uDepth', 0, T.scene.depth); setU(p, 'uNearFar', nf); setU(p, 'uTexel', [1 / W, 1 / H]);
      });
      const raysOn = fx.rays && o.sunVis > 0.001;
      if (raysOn) pass(P.rays, T.rays, p => {
        tex(p, 'uDepth', 0, T.scene.depth); setU(p, 'uSun', o.sunUV); setU(p, 'uSunVis', o.sunVis);
        setU(p, 'uSunCol', o.sunCol); setU(p, 'uAspect', W / H); setU(p, 'uNearFar', nf);
      });
      const bloomOn = fx.bloom || fx.flare;
      if (bloomOn) {
        pass(P.bright, T.bloom[0], p => {
          tex(p, 'uSrc', 0, T.scene.color); setU(p, 'uTexel', [1 / W, 1 / H]); setU(p, 'uThresh', 1.5); setU(p, 'uEnc', enc);
        });
        for (let i = 1; i < T.bloom.length; i++) pass(P.down, T.bloom[i], p => {
          const s = T.bloom[i - 1]; tex(p, 'uSrc', 0, s.color); setU(p, 'uTexel', [1 / s.w, 1 / s.h]);
        });
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        for (let i = T.bloom.length - 2; i >= 0; i--) pass(P.up, T.bloom[i], p => {
          const s = T.bloom[i + 1]; tex(p, 'uSrc', 0, s.color); setU(p, 'uTexel', [1 / s.w, 1 / s.h]);
        });
        gl.disable(gl.BLEND);
      }
      let src = T.scene.color;
      if (fx.dof) {
        pass(P.dof, T.dof, p => {
          tex(p, 'uSrc', 0, T.scene.color); tex(p, 'uDepth', 1, T.scene.depth);
          setU(p, 'uTexel', [1 / W, 1 / H]); setU(p, 'uNearFar', nf);
          setU(p, 'uFocus', o.focus); setU(p, 'uAperture', o.aperture);
        });
        src = T.dof.color;
      }
      pass(P.comp, T.ldr, p => {
        tex(p, 'uSrc', 0, src); tex(p, 'uDepth', 1, T.scene.depth); tex(p, 'uBloom', 2, T.bloom[0].color);
        tex(p, 'uRays', 3, T.rays.color); tex(p, 'uAO', 4, T.ao.color); tex(p, 'uFlare', 5, T.bloom[2].color); tex(p, 'uDepthO', 6, T.copy.depth);
        setU(p, 'uNearFar', nf);
        setU(p, 'uInvVP', o.invVP); setU(p, 'uPrevVP', o.prevVP);
        setU(p, 'uMotion', fx.motion ? 0.6 : 0);
        setU(p, 'uBloomAmt', fx.bloom ? 0.05 : 0);
        setU(p, 'uRaysAmt', raysOn ? 0.22 : 0);
        setU(p, 'uAOAmt', fx.ssao ? 1 : 0);
        setU(p, 'uFlareAmt', fx.flare ? 0.06 : 0);
        setU(p, 'uExposure', o.exposure); setU(p, 'uUnder', o.underwater ? 1 : 0);
        setU(p, 'uTime', o.time); setU(p, 'uEnc', enc);
        setU(p, 'uSat', 1.12); setU(p, 'uGrade', 1);
        setU(p, 'uSun', o.sunUV); setU(p, 'uSunVis', o.sunVis); setU(p, 'uSunCol', o.sunCol);
      });
      pass(P.final, null, p => {
        tex(p, 'uSrc', 0, T.ldr.color); tex(p, 'uDepth', 1, T.scene.depth);
        setU(p, 'uTexel', [1 / W, 1 / H]); setU(p, 'uRes', [W, H]); setU(p, 'uNearFar', nf);
        gl.uniform1i(p.u.uLook, fx.look | 0);
        setU(p, 'uCA', fx.ca ? 1 : 0); setU(p, 'uVig', 0.55);
        setU(p, 'uFXAA', fx.fxaa ? 1 : 0); setU(p, 'uTime', o.time);
      });
      gl.depthMask(true);
      gl.bindVertexArray(null);
    },
  };
}

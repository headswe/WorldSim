// Emberwood GLSL sources.
const GLSL_HASH = `
uint ih(uint x){ x^=x>>16; x*=0x7feb352dU; x^=x>>15; x*=0x846ca68bU; x^=x>>16; return x; }
float h1(uint x){ return float(ih(x))*(1.0/4294967295.0); }
// Gerstner swell for the open sea. s scales it: 0 on the shore, 1 over deep water. Returns the
// vertex offset; nrm gets the surface normal. Eight wave trains run in fixed compass directions;
// the simulated wind (uSeaWind.xy direction, .z strength) decides how tall each one is, so the sea
// builds up downwind and rises with storms without the wave phases ever jumping.
// seaJ is the Jacobian of the horizontal displacement (Tessendorf 2001): 1 on flat water, below 1
// where crests are squeezed together, below 0 where the surface folds over. Whitecaps form there.
uniform vec3 uSeaWind;
float seaJ;
vec3 seaWave(vec2 p, float t, float s, float fp, out vec3 nrm){
  float Lw[8]=float[8](21.0,8.5,16.0,11.0,19.0,7.0,13.5,9.5);
  vec3 off=vec3(0.0); vec3 n=vec3(0.0,1.0,0.0);
  vec2 wd=uSeaWind.xy;
  float jxx=1.0, jzz=1.0, jxz=0.0;
  // Amplitudes: each train grows with the wind, but no wave gets steeper than real breaking
  // seas (k*a <= 0.11). Waves only a few pixels long are faded out (they'd alias into shimmer).
  float A[8]; float S=0.0;
  for(int i=0;i<8;i++){
    float ang=float(i)*0.7854+0.3;
    float al=max(dot(vec2(cos(ang),sin(ang)),wd),0.0);
    float k=6.2831/Lw[i];
    A[i]=min((0.05+0.55*al*al)*0.03*Lw[i]*pow(uSeaWind.z,1.4),0.11/k)*s*(1.0-smoothstep(Lw[i]*0.12,Lw[i]*0.4,fp));
    S+=k*A[i];
  }
  // sharper crests in stronger wind, but the summed steepness stays below 0.8 so the surface never
  // loops over itself (that drew long white ribbons in a gale)
  float Q=min(mix(0.5,0.85,clamp((uSeaWind.z-0.5)/1.5,0.0,1.0)),0.8/max(S,1e-3));
  for(int i=0;i<8;i++){
    float ang=float(i)*0.7854+0.3;
    vec2 D=vec2(cos(ang),sin(ang));
    float a=A[i];
    float k=6.2831/Lw[i], c=sqrt(9.8/k)*0.55, f=k*dot(D,p)-k*c*t;
    float cf=cos(f), sf=sin(f), qk=Q*a*k*sf;
    off.xz+=Q*a*D*cf; off.y+=a*sf;
    n.xz-=D*k*a*cf; n.y-=Q*k*a*sf;
    jxx-=qk*D.x*D.x; jzz-=qk*D.y*D.y; jxz-=qk*D.x*D.y;
  }
  seaJ=jxx*jzz-jxz*jxz;
  nrm=normalize(n);
  return off;
}
// season weights (spring, summer, autumn, winter) for a cyclic uSeason in 0..4
vec4 seasonW(float s){ s=mod(s,4.0); vec4 d=abs(vec4(0.0,1.0,2.0,3.0)-s); d=min(d,4.0-d); return max(1.0-d,0.0); }
// Crossed-quad plants (27 reeds and cattails, 28 grass tufts) are cut out of their quads as
// pixel stalks: u runs along the plane, t from foot (0) to tip (1). Returns 0 for empty,
// 1 for a stalk or blade, 2 for a cattail head.
int plantHit(uint b, ivec2 cell, int pl, float u, float t){
  uint base=ih(uint(cell.x)*73856093u ^ uint(cell.y)*83492791u ^ uint(pl)*19349663u);
  bool reed=b==27u;
  float rows=reed?32.0:16.0;
  float ty=(floor(t*rows)+0.5)/rows, px=floor(u*16.0)+0.5;
  int c0=int(floor(u*16.0));
  for(int k=c0-3;k<=c0+3;k++){
    if(k<1||k>14) continue;
    uint kh=base+uint(k)*7u;
    if(h1(kh)>(reed?0.40:0.55)) continue;
    float hs=reed ? 0.5+0.5*h1(kh+1u) : 0.35+0.6*h1(kh+1u);
    if(ty>hs) continue;
    float f=ty/hs;
    float cx=float(k)+0.5+(h1(kh+2u)-0.5)*(reed?4.0:7.0)*f*f;
    bool head=reed && h1(kh+3u)<0.4 && f>0.7 && f<0.88;
    float w=head ? 1.2 : reed ? 0.55 : 0.75*(1.0-f*0.5);
    if(abs(px-cx)<w) return head?2:1;
  }
  return 0;
}
`;
const GLSL_COMMON = `
precision highp float; precision highp int; precision highp sampler2DShadow;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uZenith; uniform vec3 uHorizon;
uniform vec3 uCam; uniform float uFogDen; uniform float uTime; uniform float uEnc; uniform float uMist; uniform float uSeason; uniform float uNight; uniform float uRain;
${GLSL_HASH}
vec3 skyCol(vec3 d){
  float h=clamp(d.y,0.0,1.0);
  vec3 c=mix(uHorizon,uZenith,pow(h,0.5));
  float s=max(dot(d,uSunDir),0.0);
  c+=uSunCol*(pow(s,6.0)*0.12+pow(s,48.0)*0.35);
  if(d.y<0.0) c=mix(uHorizon,uHorizon*0.7,clamp(-d.y*2.5,0.0,1.0));
  return c;
}
// shadow of the simulated clouds: look up the cloud map where the sun ray through p meets the cloud layer
uniform sampler2D uCloudMap; uniform vec2 uCloudO; uniform float uCloudOn; uniform float uCloudSim;
// the previous simulation step's map, its origin, and how far the fade to the newer map has got
uniform sampler2D uCloudMapP; uniform vec2 uCloudOP; uniform float uCloudF;
vec2 cloudUV(vec2 xz){ return (xz/16.0-uCloudO)/128.0; }
vec4 cloudMap(vec2 xz){ return mix(texture(uCloudMapP,(xz/16.0-uCloudOP)/128.0),texture(uCloudMap,cloudUV(xz)),uCloudF); }
// smooth version for the cloud shapes: a cubic B-spline over the 128-texel map (4 bilinear taps),
// because a steep density ramp over plain bilinear filtering shows the map's texels as
// staircase edges
vec4 bspl(sampler2D s, vec2 uv){
  vec2 p=uv*128.0-0.5, i=floor(p), f=p-i, f2=f*f, f3=f2*f;
  vec2 w0=(1.0-3.0*f+3.0*f2-f3)/6.0, w1=(4.0-6.0*f2+3.0*f3)/6.0, w2=(1.0+3.0*f+3.0*f2-3.0*f3)/6.0, w3=f3/6.0;
  vec2 g0=w0+w1, g1=w2+w3;
  vec2 c0=(i-0.5+w1/g0)/128.0, c1=(i+1.5+w3/g1)/128.0;
  return g0.y*(g0.x*texture(s,vec2(c0.x,c0.y))+g1.x*texture(s,vec2(c1.x,c0.y)))+g1.y*(g0.x*texture(s,vec2(c0.x,c1.y))+g1.x*texture(s,vec2(c1.x,c1.y)));
}
vec4 bsplL(sampler2D s, vec2 uv){
  vec2 p=uv*128.0-0.5, i=floor(p), f=p-i, f2=f*f, f3=f2*f;
  vec2 w0=(1.0-3.0*f+3.0*f2-f3)/6.0, w1=(4.0-6.0*f2+3.0*f3)/6.0, w2=(1.0+3.0*f+3.0*f2-3.0*f3)/6.0, w3=f3/6.0;
  vec2 g0=w0+w1, g1=w2+w3;
  vec2 c0=(i-0.5+w1/g0)/128.0, c1=(i+1.5+w3/g1)/128.0;
  return g0.y*(g0.x*textureLod(s,vec2(c0.x,c0.y),0.0)+g1.x*textureLod(s,vec2(c1.x,c0.y),0.0))+g1.y*(g0.x*textureLod(s,vec2(c0.x,c1.y),0.0)+g1.x*textureLod(s,vec2(c1.x,c1.y),0.0));
}
vec4 cloudMapS(vec2 xz){ return mix(bspl(uCloudMapP,(xz/16.0-uCloudOP)/128.0),bspl(uCloudMap,cloudUV(xz)),uCloudF); }
vec4 cloudMapLod(vec2 xz, vec2 du, float l){ return mix(textureLod(uCloudMapP,(xz/16.0-uCloudOP)/128.0+du,l),textureLod(uCloudMap,cloudUV(xz)+du,l),uCloudF); }
// ---- sky cloud layer ----
// Clouds are a single layer at CLY, evaluated where each view ray (or sun ray) meets it: thickness
// comes from the simulated cover and a tiling 2D noise that drifts with the wind. There is no
// raymarch, no per-pixel random offset and no blending with earlier frames, so the result is a
// smooth function of the camera and time and cannot shimmer or crawl while moving. The noise is
// mipmapped, so distant cloud is filtered instead of aliasing.
uniform sampler2D uCloud2D; uniform vec2 uCloudWind; uniform float uCloudMean;
const float CLY=420.0;
float cloudCover(vec2 xz){
  // test switch: an even, fair-weather cover everywhere instead of the simulated weather
  if(uCloudSim<0.5) return 0.42;
  vec2 uv=cloudUV(xz);
  vec2 ee=smoothstep(vec2(0.0),vec2(0.2),uv)*smoothstep(vec2(1.0),vec2(0.8),uv);
  float m=cloudMapS(xz).r;
  return mix(uCloudMean,m*m,ee.x*ee.y);
}
// cloud thickness 0..1 at a point of the layer for a given cover (no branches, so texture
// filtering stays well defined at cloud edges)
// x: with the small billows on the edges, y: the broad body (smooth, used for shading)
vec2 cloudShape(vec4 A, vec4 B, vec4 C, float cov){
  float base=A.r*0.4+B.g*0.6;
  float c=clamp(cov*1.15,0.0,1.0);
  float h=clamp((base-(1.0-c))/max(c,0.08),0.0,1.0);
  // near full cover (storm cores, fronts) the gaps close into one solid, lumpy deck
  h=mix(h,0.5+0.5*base,smoothstep(0.75,1.0,cov));
  float det=C.g*0.7+C.a*0.3;
  return vec2(clamp((h-(1.0-det)*0.22)/0.78,0.0,1.0),h);
}
vec2 cloudThick2(vec2 xz, float cov){
  vec2 w=xz+uCloudWind;
  return cloudShape(texture(uCloud2D,w*(1.0/3200.0)),texture(uCloud2D,w*(1.0/950.0)+vec2(0.37,0.11)),
    texture(uCloud2D,w*(1.0/330.0)+vec2(0.71,0.53)),cov);
}
// the same with the mip level chosen from foot (world size of one pixel or sample), for use
// inside loops where automatic texture derivatives are not defined
vec2 cloudThickL(vec2 xz, float cov, float foot){
  vec2 w=xz+uCloudWind;
  float l=log2(max(foot,1e-3)*256.0);
  return cloudShape(textureLod(uCloud2D,w*(1.0/3200.0),max(0.0,l-log2(3200.0))),
    textureLod(uCloud2D,w*(1.0/950.0)+vec2(0.37,0.11),max(0.0,l-log2(950.0))),
    textureLod(uCloud2D,w*(1.0/330.0)+vec2(0.71,0.53),max(0.0,l-log2(330.0))),cov);
}
float cloudCoverL(vec2 xz){
  if(uCloudSim<0.5) return 0.42;
  vec2 uv=cloudUV(xz);
  vec2 ee=smoothstep(vec2(0.0),vec2(0.2),uv)*smoothstep(vec2(1.0),vec2(0.8),uv);
  float m=cloudMapLod(xz,vec2(0.0),0.0).r;
  return mix(uCloudMean,m*m,ee.x*ee.y);
}
float cloudThick(vec2 xz, float cov){ return cloudThick2(xz,cov).x; }
// how much sunlight reaches p past the cloud layer
float cloudShade(vec3 p){
  if(uCloudOn<0.5) return 1.0;
  vec3 q=p+uSunDir*(CLY-p.y)/max(uSunDir.y,0.12);
  float h=cloudThick(q.xz,cloudCover(q.xz));
  return 1.0-0.6*smoothstep(0.0,0.5,h);
}
// scene passes write linear HDR; tonemapping happens in the post stack
vec3 outHDR(vec3 c){ return max(c,vec3(0.0))*uEnc; }
vec3 applyFog(vec3 c, vec3 wp){
  vec3 dv=wp-uCam; float dist=length(dv); vec3 dir=dv/max(dist,1e-4);
  float f=1.0-exp(-pow(dist*uFogDen,2.0));
  c=mix(c, skyCol(dir), clamp(f,0.0,1.0));
  if(uMist>0.0){
    // analytic exponential height fog pooling in the valleys, lit by the low sun
    const float K=0.11;
    float y0=uCam.y-30.0, dy=dir.y;
    float amt=0.008*uMist*exp(-K*y0)*(abs(dy)>1e-3 ? (1.0-exp(-K*dist*dy))/(K*dy) : dist);
    amt=1.0-exp(-max(amt,0.0));
    float sa=pow(max(dot(dir,uSunDir),0.0),5.0);
    vec3 mc=mix(uHorizon*0.85+uZenith*0.15, uSunCol*0.5, sa);
    c=mix(c,mc,amt*0.75);
  }
  return c;
}
`;

const VS_TERRAIN = `#version 300 es
${GLSL_COMMON}
layout(location=0) in uint aData;
uniform mat4 uVP; uniform mat4 uLightVP; uniform vec3 uOrigin; uniform float uWind;
out vec3 vWorld; out vec3 vPos; out vec4 vLP; out float vAO; flat out uint vBlock; flat out int vN;
const vec3 NRM[6]=vec3[6](vec3(1,0,0),vec3(-1,0,0),vec3(0,1,0),vec3(0,-1,0),vec3(0,0,1),vec3(0,0,-1));
vec3 windOff(vec3 p){
  return vec3(sin(uTime*1.9+p.x*0.7+p.z*0.4), sin(uTime*1.3+p.x*0.5)*0.4, cos(uTime*1.5+p.z*0.6+p.y*0.3))*0.06*uWind;
}
void main(){
  uint d=aData;
  vec3 p=vec3(float(d&63u), float((d>>6u)&127u), float((d>>13u)&63u));
  int n=int((d>>19u)&7u); uint b=d>>24u;
  vec3 w=uOrigin+p, wv=w;
  // water: block byte is 64 + level*9 + dir; lower surface vertices to the water level
  if(b>=64u){
    float lv=float((b-64u)/9u);
    bool topV = n==2 || (n!=3 && ((d>>22u)&3u)==1u);
    if(topV) wv.y-=0.12+(8.0-lv)/8.0*0.85;
    if(n==2 && lv>7.5 && abs(w.y-31.0)<0.01){
      vec3 nn; float s=float((d>>22u)&3u)/3.0;
      wv+=seaWave(w.xz,uTime,s,0.0,nn);
    }
  }
  if(b>=9u && b<=13u) wv+=windOff(w);
  if(b==27u||b==28u){
    float t=float((d>>22u)&3u)/3.0;
    wv+=vec3(sin(uTime*2.1+w.x*0.9+w.z*0.6),0.0,cos(uTime*1.7+w.z*0.8+w.x*0.3))*(0.09+0.05*sin(uTime*0.6+w.x*0.13))*uWind*t*(b==27u?2.0:1.0);
  }
  vWorld=w; vPos=wv; vN=n; vBlock=b; vAO=float((d>>22u)&3u)/3.0;
  vLP=uLightVP*vec4(wv+NRM[n]*0.06,1.0);
  gl_Position=uVP*vec4(wv,1.0);
}`;

const FS_LIGHTING = `
uniform sampler2DShadow uShadow; uniform float uShadowOn; uniform vec3 uAmbSky; uniform vec3 uAmbGround; uniform float uCaustics;
const vec2 PD[12]=vec2[12](vec2(-0.326,-0.406),vec2(-0.840,-0.074),vec2(-0.696,0.457),vec2(-0.203,0.621),vec2(0.962,-0.195),vec2(0.473,-0.480),
  vec2(0.519,0.767),vec2(0.185,-0.893),vec2(0.507,0.064),vec2(0.896,0.412),vec2(-0.322,-0.933),vec2(-0.792,-0.598));
const vec3 NRM[6]=vec3[6](vec3(1,0,0),vec3(-1,0,0),vec3(0,1,0),vec3(0,-1,0),vec3(0,0,1),vec3(0,0,-1));
float shadowF(vec4 lp){
  if(uShadowOn<0.5) return 1.0;
  vec3 c=lp.xyz/lp.w*0.5+0.5;
  vec2 e=min(c.xy,1.0-c.xy);
  if(e.x<0.0||e.y<0.0||c.z>1.0) return 1.0;
  vec2 ts=1.8/vec2(textureSize(uShadow,0));
  float a=h1(uint(gl_FragCoord.x)*1973u+uint(gl_FragCoord.y)*9277u)*6.2831;
  mat2 rot=mat2(cos(a),sin(a),-sin(a),cos(a));
  float s=0.0;
  for(int i=0;i<12;i++) s+=texture(uShadow,vec3(c.xy+rot*PD[i]*ts,c.z-0.0006));
  s/=12.0;
  return mix(1.0,s,smoothstep(0.0,0.06,min(e.x,e.y)));
}
`;

const FS_TERRAIN = `#version 300 es
${GLSL_COMMON}
${FS_LIGHTING}
in vec3 vWorld; in vec4 vLP; in float vAO; flat in uint vBlock; flat in int vN;
out vec4 o;
uint cellHash(ivec3 c){ return ih(uint(c.x)*73856093u ^ uint(c.y)*19349663u ^ uint(c.z)*83492791u); }
float th(uint ch, ivec2 t){ return h1(ch ^ ih(uint(t.x)*2654435761u + uint(t.y)*40503u + 17u)); }
// each leaf block keeps its autumn colour and has a spring, summer and winter one:
// maples (9) blossom pink in spring, everything greens up in summer, oaks (12) hold dry leaves in winter
vec3 leafTint(uint b, float bh, vec4 W){
  vec3 au, sp, su, wi;
  if(b==9u){ au=mix(vec3(0.70,0.08,0.05),vec3(0.86,0.24,0.06),bh); sp=mix(vec3(0.92,0.62,0.70),vec3(0.99,0.84,0.88),bh); su=mix(vec3(0.17,0.34,0.10),vec3(0.24,0.42,0.13),bh); wi=au*0.6; }
  else if(b==10u){ au=mix(vec3(0.90,0.38,0.06),vec3(0.95,0.55,0.10),bh); sp=mix(vec3(0.40,0.62,0.18),vec3(0.54,0.72,0.24),bh); su=mix(vec3(0.20,0.38,0.11),vec3(0.28,0.45,0.15),bh); wi=au*0.6; }
  else if(b==11u){ au=mix(vec3(0.93,0.68,0.12),vec3(0.98,0.80,0.25),bh); sp=mix(vec3(0.56,0.75,0.26),vec3(0.70,0.84,0.36),bh); su=mix(vec3(0.30,0.48,0.14),vec3(0.38,0.56,0.19),bh); wi=au*0.6; }
  else if(b==12u){ au=mix(vec3(0.52,0.26,0.10),vec3(0.68,0.38,0.12),bh); sp=mix(vec3(0.36,0.54,0.16),vec3(0.46,0.62,0.20),bh); su=mix(vec3(0.16,0.31,0.09),vec3(0.22,0.37,0.11),bh); wi=mix(vec3(0.48,0.33,0.19),vec3(0.58,0.42,0.25),bh); }
  else { au=mix(vec3(0.13,0.24,0.11),vec3(0.18,0.30,0.13),bh); sp=mix(au,vec3(0.32,0.50,0.18),0.3*bh); su=au; wi=au*vec3(0.9,0.95,1.0); }
  return W.x*sp+W.y*su+W.z*au+W.w*wi;
}
vec3 litterCol(float a){
  if(a<0.28) return vec3(0.66,0.13,0.06);
  if(a<0.58) return vec3(0.82,0.40,0.08);
  if(a<0.78) return vec3(0.78,0.58,0.18);
  return vec3(0.40,0.23,0.11);
}
const vec3 SNOWC=vec3(0.90,0.93,0.97);
void main(){
  uint b=vBlock;
  vec4 W=seasonW(uSeason);
  if(b==27u||b==28u){
    float t=clamp(vAO,0.0,1.0);
    int hit=plantHit(b,ivec2(floor(vWorld.xz)),vN,fract(vWorld.x),t);
    if(hit==0) discard;
    vec3 st = b==27u ? W.x*vec3(0.42,0.60,0.20)+W.y*vec3(0.30,0.50,0.16)+W.z*vec3(0.66,0.56,0.28)+W.w*vec3(0.72,0.64,0.46)
                     : W.x*vec3(0.46,0.68,0.22)+W.y*vec3(0.38,0.56,0.18)+W.z*vec3(0.74,0.60,0.30)+W.w*vec3(0.68,0.62,0.44);
    vec3 c = hit==2 ? vec3(0.33,0.19,0.10)*(1.0-0.3*W.x) : st*(0.55+0.55*t);
    c=mix(c,SNOWC,W.w*0.5*smoothstep(0.55,1.0,t));
    vec3 alb=pow(c,vec3(2.2));
    // thin stalks catch light from every side; soften the shadow so they don't self-shadow
    float sh=mix(1.0,shadowF(vLP),0.7)*cloudShade(vWorld);
    vec3 amb=mix(uAmbGround,uAmbSky,0.6+0.4*t);
    vec3 lit=alb*(amb*(0.7+0.5*t)+uSunCol*sh*(0.45+0.5*max(uSunDir.y,0.0)+0.2*t));
    o=vec4(outHDR(applyFog(lit,vWorld)),1.0);
    return;
  }
  vec3 N=NRM[vN];
  ivec3 cell=ivec3(floor(vWorld-N*0.5));
  vec3 lp=vWorld-vec3(cell);
  vec2 uv = abs(N.y)>0.5 ? lp.xz : abs(N.x)>0.5 ? vec2(lp.z,lp.y) : lp.xy;
  uint ch=cellHash(cell);
  float bh=h1(ch);
  bool leaf = b>=9u && b<=13u;
  ivec2 tx=ivec2(floor(uv*(leaf?8.0:16.0)));
  float n=th(ch,tx);
  bool top=N.y>0.5, side=abs(N.y)<0.5;
  vec3 c;
  vec3 dirt=vec3(0.44,0.30,0.19)*(0.82+0.3*n);
  if(b==1u||b==14u){
    vec3 g;
    vec3 gsp=mix(vec3(0.36,0.56,0.16),vec3(0.48,0.64,0.22),n), gsu=mix(vec3(0.29,0.45,0.13),vec3(0.41,0.53,0.18),n);
    vec3 grass=(W.x*gsp+W.y*gsu+W.z*mix(vec3(0.42,0.48,0.20),vec3(0.58,0.52,0.24),n)+W.w*mix(vec3(0.46,0.44,0.30),vec3(0.56,0.52,0.36),n))*(0.9+0.15*bh);
    if(b==1u) g=grass;
    else {
      float a=th(ch,tx/2+ivec2(7,3));
      vec3 lit = n<0.12 ? vec3(0.45,0.47,0.21) : litterCol(a)*(0.8+0.35*n);
      // last year's leaves only show through the new grass in patches
      vec3 old = a<0.12 ? vec3(0.40,0.32,0.20)*(0.8+0.3*n) : grass*0.88;
      g=W.z*lit+(W.x+W.y)*old+W.w*vec3(0.40,0.28,0.17)*(0.8+0.3*n);
    }
    // meadow flowers in spring and summer
    float fp=0.035*(W.x*1.3+W.y*0.8)*(b==1u?1.0:0.3);
    if(top && th(ch,tx+ivec2(31,7))<fp){
      float fk=th(ch,tx+ivec2(5,19));
      vec3 fl = fk<0.4 ? vec3(0.98,0.86,0.22) : fk<0.7 ? vec3(0.97,0.96,0.92) : fk<0.85 ? vec3(0.62,0.42,0.86) : vec3(0.92,0.36,0.46);
      g=fl;
    }
    if(top) c=g;
    else if(side && lp.y>0.80-n*0.14) c=g;
    else c=dirt;
  } else if(b==2u) c=dirt;
  else if(b==3u) c=vec3(0.50,0.49,0.47)*(0.8+0.3*th(ch,tx/2));
  else if(b==4u) c=vec3(0.80,0.71,0.50)*(0.88+0.2*n);
  else if(b==6u||b==8u){
    vec3 bark = b==6u ? vec3(0.36,0.25,0.16) : vec3(0.26,0.17,0.11);
    if(side){ float st=th(ch,ivec2(tx.x,tx.y/5)); c=bark*(0.7+0.5*st); }
    else { float r=length(lp.xz-0.5); c=mix(vec3(0.66,0.50,0.32),bark,step(0.42,r))*(0.85+0.25*step(0.5,fract(r*7.0))); }
  } else if(b==7u){
    if(side){ float m=th(ch,ivec2(tx.x/5,tx.y)); c = m<0.12 ? vec3(0.13,0.12,0.11) : vec3(0.88,0.86,0.80)*(0.92+0.1*n); }
    else { float r=length(lp.xz-0.5); c=mix(vec3(0.80,0.70,0.52),vec3(0.88,0.86,0.80),step(0.42,r)); }
  } else if(leaf){
    c=leafTint(b,bh,W);
    if(n<0.22) c*=0.45; else if(n>0.86) c*=1.18;
  } else if(b==15u){
    float m=th(ch,tx/3);
    c=vec3(0.48,0.48,0.45)*(0.8+0.3*n);
    if(m<(top?0.65:0.35)) c=vec3(0.30,0.40,0.16)*(0.8+0.4*n);
  } else if(b==16u){
    c=vec3(0.66,0.48,0.29)*(0.85+0.2*th(ch,ivec2(tx.x/6,tx.y/4)));
    if(tx.y%4==0) c*=0.7;
  } else if(b==29u){
    // winter twigs: dark grey-brown with gaps of sky-coloured shade
    c=vec3(0.27,0.21,0.17)*(0.7+0.5*n);
    if(n<0.3) c*=0.55;
  } else if(b==25u){
    c=vec3(0.92,0.94,0.97)*(0.93+0.07*th(ch,tx/2));
  } else if(b==26u){
    c=mix(vec3(0.62,0.78,0.88),vec3(0.80,0.90,0.96),th(ch,tx/3));
  } else c=vec3(1.0,0.0,1.0);
  // winter: snow settles on every upward face and creeps over the top edge of sides
  if(W.w>0.0 && b!=25u && b!=26u){
    float spot=th(ch,tx/4+ivec2(3,11));
    // sides only creep on ground blocks; logs and leaves would show a band on every block
    bool ground = b==1u||b==2u||b==4u||b==14u||b==15u;
    float cover = top ? 1.0 : side && ground && lp.y>0.86-0.12*n ? 0.85 : 0.0;
    float amt=smoothstep(0.25,0.75,W.w*cover*(0.75+0.45*spot));
    c=mix(c,SNOWC*(0.93+0.07*n),amt);
  }
  vec3 alb=pow(c,vec3(2.2));
  float sh=shadowF(vLP)*cloudShade(vWorld);
  float ndl=max(dot(N,uSunDir),0.0);
  float ao=0.3+0.7*vAO;
  vec3 amb=mix(uAmbGround,uAmbSky,N.y*0.5+0.5);
  vec3 lit=alb*(amb*ao + uSunCol*ndl*sh*(0.55+0.45*vAO));
  if(leaf) lit+=alb*uSunCol*0.18*sh*max(dot(-N,uSunDir)*0.5+0.5,0.0)*ao;
  if(uCaustics>0.0 && vWorld.y<30.6){
    vec2 q=(vWorld.xz+vWorld.y*0.3)*1.4; float t=uTime*1.1;
    float w1=sin(q.x*1.7+sin(q.y*1.3+t))+sin(q.y*1.9+sin(q.x*1.1-t*1.3));
    float w2=sin((q.x+q.y)*1.2+sin(q.x*0.7-t*0.9)*1.5)+sin((q.x-q.y)*1.4-t);
    float ca=pow(max(0.0,1.0-abs(w1)*0.6),5.0)+pow(max(0.0,1.0-abs(w2)*0.6),5.0);
    float depth=31.0-vWorld.y;
    lit+=alb*uSunCol*ca*0.55*sh*exp(-depth*0.25)*max(N.y,0.3);
  }
  lit=applyFog(lit,vWorld);
  o=vec4(outHDR(lit),1.0);
}`;

const FS_WATER = `#version 300 es
${GLSL_COMMON}
${FS_LIGHTING}
uniform highp sampler3D uNoise3;
in vec3 vWorld; in vec3 vPos; in vec4 vLP; in float vAO; flat in uint vBlock; flat in int vN;
uniform sampler2D uSceneColor; uniform sampler2D uSceneDepth; uniform vec2 uRes; uniform vec2 uNearFar; uniform mat4 uVP; uniform float uSSR;
uniform sampler2D uOcean; uniform float uOceanOn; uniform float uOceanL;
out vec4 o;
float linD(float d){ float z=d*2.0-1.0; return 2.0*uNearFar.x*uNearFar.y/(uNearFar.y+uNearFar.x-z*(uNearFar.y-uNearFar.x)); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=h1(uint(int(i.x)*7919+int(i.y)*104729)), b=h1(uint(int(i.x+1.0)*7919+int(i.y)*104729));
  float c=h1(uint(int(i.x)*7919+int(i.y+1.0)*104729)), d=h1(uint(int(i.x+1.0)*7919+int(i.y+1.0)*104729));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
float waveH(vec2 q){
  float t=uTime;
  return sin(q.x*1.3+t*1.1)*0.05+sin(q.x*3.1+q.y*1.7+t*2.1)*0.03+cos(q.y*1.1+t*0.9)*0.05+cos(q.y*2.7-q.x*1.9+t*1.7)*0.03
        +vnoise(q*2.5+vec2(t*0.6,t*0.4))*0.04+vnoise(q*6.0-vec2(t*0.9,-t*0.5))*0.015;
}
// Fallback sea chop for GPUs without float render targets: a few octaves of sharp-crested
// ridges (a folded sine, 1-|sin|, blended toward |cos| and raised to a power so crests peak and
// troughs flatten), each octave turned and running with the wind, smaller and less peaked.
float chopRidge(vec2 p, float peak){
  vec2 r=1.0-abs(sin(p)), t=abs(cos(p));
  r=mix(r,t,r*0.5);
  return pow(r.x*r.y,peak);
}
float seaChop(vec2 p, float t){
  vec2 wd=normalize(uSeaWind.xy+vec2(1e-4,0.0));
  mat2 face=mat2(wd.x,wd.y,-wd.y,wd.x);
  p=face*p;
  float h=0.0, f=0.42, a=0.22, peak=0.55;
  for(int i=0;i<4;i++){
    float sp=sqrt(9.81/f)*0.35;
    h+=(chopRidge(p*f+vec2(t*sp*f,0.0),peak)+chopRidge(p*f*vec2(0.9,1.1)+vec2(t*sp*f*0.8,1.7),peak))*a;
    p=mat2(0.8,0.6,-0.6,0.8)*p+vec2(3.1,-1.3);
    f*=1.85; a*=0.42; peak=mix(peak,0.25,0.35);
  }
  return h*uSeaWind.z;
}
void main(){
  vec3 wp=vPos;
  uint code=vBlock-64u;
  float lv=float(code/9u);
  int dir=int(code%9u);
  float fl=dir<8 ? 1.0 : 0.0;
  vec2 flow=fl*vec2(cos(float(dir)*0.785398),sin(float(dir)*0.785398));
  if(vN!=2){
    // waterfall sheet: streaks sliding down the face
    vec3 Nf=NRM[vN];
    float across=dot(wp.xz,vec2(-Nf.z,Nf.x));
    float s1=vnoise(vec2(across*7.0,wp.y*0.45+uTime*2.2)), s2=vnoise(vec2(across*16.0+3.0,wp.y*0.9+uTime*3.4));
    float streak=smoothstep(0.5,0.95,s1*0.6+s2*0.4);
    float shf=shadowF(vLP);
    vec3 lit=uAmbSky*1.3+uSunCol*(max(dot(Nf,uSunDir),0.0)*0.6+0.15)*shf;
    vec3 col=mix(vec3(0.03,0.10,0.12)*lit,vec3(0.80,0.88,0.90)*lit,streak*0.8);
    col+=skyCol(reflect(normalize(wp-uCam),Nf))*0.12;
    col=applyFog(col,wp);
    o=vec4(outHDR(col),1.0);
    return;
  }
  vec2 q=wp.xz-flow*uTime*1.8;
  float e=0.06, h0=waveH(q), amp=0.6+fl*0.9;
  vec3 N=normalize(vec3(-(waveH(q+vec2(e,0))-h0)/e*amp, 1.0, -(waveH(q+vec2(0,e))-h0)/e*amp));
  // the open sea rolls with long swells from two directions
  bool sea = fl==0.0 && lv>7.5 && abs(vWorld.y-31.0)<0.01;
  // how much water one pixel covers: drives the wave level of detail
  float fpx=length(fwidth(vWorld.xz));
  float crest=0.0, swell=clamp(vAO,0.0,1.0);
  if(sea){
    vec3 sn; vec3 off=seaWave(vWorld.xz,uTime,swell,fpx,sn);
    // short chop on top of the swells: an FFT ocean patch where the GPU can render floats (two
    // scales so the tiling doesn't show), analytic sharp-crested ridges otherwise; both build
    // with the wind. Its folding adds to the swells' for whitecaps.
    vec2 sl; float jf=1.0;
    if(uOceanOn>0.5){
      vec2 p1=vWorld.xz/uOceanL, p2=mat2(0.8,-0.6,0.6,0.8)*vWorld.xz/(uOceanL*0.37)+0.31;
      vec4 o1=texture(uOcean,p1), o2=texture(uOcean,p2);
      sl=o1.xy+o2.xy*0.45;
      jf=clamp(min(o1.z,1.0-(1.0-o2.z)*0.5),0.0,1.0);
      if(isnan(jf)||isnan(sl.x)||isnan(sl.y)){ jf=1.0; sl=vec2(0.0); }
    } else {
      float ce=0.08, c0=seaChop(vWorld.xz,uTime);
      sl=vec2(seaChop(vWorld.xz+vec2(ce,0.0),uTime)-c0,seaChop(vWorld.xz+vec2(0.0,ce),uTime)-c0)/ce;
    }
    sl*=(swell*0.8+0.2)*(1.0-smoothstep(0.3,1.5,fpx));
    N=normalize(vec3(sn.x-sl.x*sn.y,sn.y,sn.z-sl.y*sn.y));
    seaJ+=(jf-1.0)*swell;
    crest=off.y/max(0.9*swell*min(pow(uSeaWind.z,1.4),1.6),0.05);
  }
  // raindrops ring the surface
  if(uRain>0.02){
    vec2 rq=wp.xz*1.6; vec2 rc=floor(rq);
    vec2 rn=vec2(0.0);
    for(int k=0;k<4;k++){
      vec2 c=rc+vec2(float(k&1),float(k>>1))-0.5;
      float h=h1(uint(int(c.x)*7919+int(c.y)*104729+40000000));
      float ph=fract(uTime*0.9+h), r=ph*0.75;
      vec2 dv=rq-(c+0.5+vec2(h,fract(h*7.3))*0.6-0.3);
      float dl=length(dv);
      float ring=sin((dl-r)*28.0)*exp(-abs(dl-r)*14.0)*(1.0-ph)*step(h,uRain*1.1);
      rn+=dv/max(dl,1e-3)*ring;
    }
    N=normalize(N+vec3(rn.x,0.0,rn.y)*0.35);
  }
  vec3 V=normalize(wp-uCam);
  // a steep wave face seen at a grazing angle can tilt the normal away from the camera; that
  // pushed the fresnel to a full mirror and the reflection down into the seabed (white blades and
  // sandy smears), so keep the normal facing the viewer
  float nv=dot(-V,N);
  if(nv<0.03) N=normalize(N-V*(0.03-nv));
  float fres=0.03+0.97*pow(1.0-max(dot(-V,N),0.0),5.0);
  float sh=shadowF(vLP)*cloudShade(wp);
  // refraction with depth-based absorption
  vec2 suv=gl_FragCoord.xy/uRes;
  float zw=linD(gl_FragCoord.z);
  vec2 ruv=suv+N.xz*0.05/max(zw*0.08,1.0);
  float zs=linD(texture(uSceneDepth,ruv).r);
  if(zs<zw){ ruv=suv; zs=linD(texture(uSceneDepth,suv).r); }
  float thick=max(zs-zw,0.0)*max(-V.y,0.15);
  // the sea knows its own depth from the mesh (0..3 blocks, 3 = deeper); that is steadier than the
  // depth buffer, which some phone GPUs read too coarsely and turn into stripes
  if(sea) thick=swell>0.99 ? 6.0 : swell*3.0;
  vec3 refr=texture(uSceneColor,ruv).rgb/uEnc;
  vec3 tint=vec3(0.03,0.085,0.085)*(uAmbSky*1.4+uSunCol*0.35*sh);
  vec3 absorb=exp(-thick*vec3(1.1,0.45,0.36));
  vec3 under=mix(tint,refr,absorb);
  // screen-space reflections, sky as fallback
  vec3 R=reflect(V,N);
  R.y=abs(R.y);
  vec3 refl=skyCol(R);
  if(uSSR>0.5){
    vec3 p=wp; float stp=0.4;
    float jit=h1(uint(gl_FragCoord.x)*3187u+uint(gl_FragCoord.y)*7919u);
    p+=R*stp*jit;
    for(int i=0;i<32;i++){
      p+=R*stp; stp*=1.13;
      vec4 cp=uVP*vec4(p,1.0);
      if(cp.w<=0.0) break;
      vec3 nd=cp.xyz/cp.w; vec2 uv=nd.xy*0.5+0.5;
      if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
      float sd=texture(uSceneDepth,uv).r;
      if(sd<1.0 && nd.z*0.5+0.5>sd){
        float dz=linD(nd.z*0.5+0.5)-linD(sd);
        if(dz<stp*2.5+0.5){
          vec2 ed=min(uv,1.0-uv);
          float fade=smoothstep(0.0,0.08,min(ed.x,ed.y));
          refl=mix(refl,texture(uSceneColor,uv).rgb/uEnc,fade);
        }
        break;
      }
    }
  }
  float gl=sea ? mix(220.0,40.0,smoothstep(0.05,0.8,fpx)) : 220.0;
  float spec=pow(max(dot(R,uSunDir),0.0),gl)*sh*(gl/220.0*0.6+0.4);
  vec3 col=mix(under,refl,fres)+uSunCol*spec*2.0;
  // light shining through the thin water of a crest: raised water glows brighter and greener
  if(sea) col+=vec3(0.035,0.12,0.09)*(uAmbSky*1.2+uSunCol*0.45*sh)*max(crest,0.0)*(1.0-fres)*min(1.0,0.4+0.5*uSeaWind.z);
  // shoreline foam
  float fn=vnoise(q*3.0+vec2(uTime*0.3,-uTime*0.2));
  float foam=(1.0-smoothstep(0.0,0.35+0.25*sin(uTime*1.6+q.x*0.8+q.y*0.6),thick))*smoothstep(0.35,0.65,fn);
  if(sea){
    // the sea's foam is driven by the real water depth carried on the mesh (0..3 blocks), not
    // by the depth buffer, so it reads the same on every GPU
    // whitecaps on the highest crests out at sea
    float gale=clamp((uSeaWind.z-0.7)/1.3,0.0,1.0);
    // where the surface is squeezed toward folding the crest breaks; the threshold rises with the
    // wind so a breeze only whitens the sharpest crests and a gale whitens most of them
    float thr=0.3+0.35*gale;
    // a crest line runs across the wind and its folding is a long thin dip in the Jacobian, which
    // drew white ribbons; real whitecaps break in short pieces along a crest, so the mask varies
    // fast across the wind (cutting each crest into dashes) and slowly along it, inside larger
    // patches where the sea happens to be breaking
    vec2 cw=uSeaWind.xy;
    vec2 cq=vec2(dot(vWorld.xz,cw)*0.45, dot(vWorld.xz,vec2(-cw.y,cw.x))*1.1)+vec2(-uTime*0.5,uTime*0.2);
    float patchy=smoothstep(0.45,0.7,vnoise(vWorld.xz*0.17+cw*uTime*0.35))*smoothstep(0.38,0.66,vnoise(cq));
    float cap=smoothstep(thr+0.1,thr-0.45,seaJ)*patchy;
    // surf: lines of white water roll in and break on the beach. Depth comes in whole blocks, so
    // only the strip touching land has a depth between 0 and 1 block; over a wide 1-block shelf
    // the depth is flat, the phase came from noise alone and the whole shelf flashed with blotches
    float ph=swell*9.0+uTime*1.6+fn*1.3;
    float band=smoothstep(0.82,0.98,sin(ph))*smoothstep(0.05,0.2,swell)*(1.0-smoothstep(0.24,0.32,swell))*smoothstep(0.2,0.55,vnoise(q*1.7-vec2(uTime*0.2,0.0))+0.15);
    float shore=(1.0-smoothstep(0.0,0.18,swell))*smoothstep(0.25,0.6,vnoise(vWorld.xz*2.2-vec2(uTime*0.5,0.0))+0.25*sin(uTime*1.5+dot(vWorld.xz,vec2(0.27,0.2))));
    // f is how much foam there is; what it looks like comes from a bubble pattern (cellular noise,
    // two sizes, drifting downwind): thick foam is solid white, thinning foam breaks into lace and
    // separate bubbles instead of fading as a flat grey sheet. Beneath it the water is milky.
    float f=max(band*0.75,max(cap,shore));
    vec2 fq=vWorld.xz+cw*uTime*0.6;
    vec2 b1=texture(uNoise3,vec3(fq*0.11,uTime*0.015)).rg;
    float b2=texture(uNoise3,vec3(fq*0.29+0.37,uTime*0.03+0.5)).g;
    float pat=b1.g*0.55+b2*0.3+b1.r*0.15;
    float fv=smoothstep(1.0-f,1.15-f*0.8,pat+0.2*f)*smoothstep(0.0,0.08,f);
    // far away the bubbles are smaller than a pixel: use their average instead
    fv=mix(fv,f*0.6,smoothstep(0.15,0.7,fpx));
    col+=vec3(0.03,0.08,0.08)*(uAmbSky+uSunCol*0.3*sh)*f*(1.0-fv);
    foam=fv;
  }
  if(fl>0.0){
    // white water streaks stretched along the current, stronger where the level drops
    vec2 pr=vec2(-flow.y,flow.x);
    float sn=vnoise(vec2(dot(wp.xz,flow)*0.9-uTime*2.6,dot(wp.xz,pr)*3.2))*0.7+vnoise(vec2(dot(wp.xz,flow)*2.1-uTime*3.4,dot(wp.xz,pr)*7.0))*0.3;
    foam=max(foam,smoothstep(0.66,0.9,sn)*(0.2+(8.0-lv)/8.0*0.6));
  }
  col=mix(col,vec3(0.95,0.94,0.9)*(uAmbSky*1.5+uSunCol*0.75*sh+0.08),foam*0.92);
  col=applyFog(col,wp);
  o=vec4(outHDR(col),1.0);
}`;

const VS_SHADOW = `#version 300 es
precision highp float; precision highp int;
layout(location=0) in uint aData;
uniform mat4 uLightVP; uniform vec3 uOrigin; uniform float uTime; uniform float uWind;
out vec3 vW; out float vT; flat out uint vB; flat out int vN;
void main(){
  uint d=aData;
  vec3 p=vec3(float(d&63u), float((d>>6u)&127u), float((d>>13u)&63u));
  uint b=d>>24u;
  vec3 w=uOrigin+p, wv=w;
  float t=float((d>>22u)&3u)/3.0;
  if(b>=9u && b<=13u) wv+=vec3(sin(uTime*1.9+w.x*0.7+w.z*0.4), sin(uTime*1.3+w.x*0.5)*0.4, cos(uTime*1.5+w.z*0.6+w.y*0.3))*0.06*uWind;
  if(b==27u||b==28u) wv+=vec3(sin(uTime*2.1+w.x*0.9+w.z*0.6),0.0,cos(uTime*1.7+w.z*0.8+w.x*0.3))*(0.09+0.05*sin(uTime*0.6+w.x*0.13))*uWind*t*(b==27u?2.0:1.0);
  vW=w; vT=t; vB=b; vN=int((d>>19u)&7u);
  gl_Position=uLightVP*vec4(wv,1.0);
}`;
const FS_SHADOW = `#version 300 es
precision highp float; precision highp int;
${GLSL_HASH}
in vec3 vW; in float vT; flat in uint vB; flat in int vN; out vec4 o;
void main(){
  if((vB==27u||vB==28u) && plantHit(vB,ivec2(floor(vW.xz)),vN,fract(vW.x),clamp(vT,0.0,1.0))==0) discard;
  o=vec4(1.0);
}`;
const FS_EMPTY = `#version 300 es
precision mediump float; out vec4 o; void main(){ o=vec4(1.0); }`;

const VS_SKY = `#version 300 es
precision highp float;
out vec2 vP;
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2))*2.0-1.0; vP=p; gl_Position=vec4(p,0.0,1.0); }`;
const FS_SKY = `#version 300 es
${GLSL_COMMON}
in vec2 vP; out vec4 o;
uniform vec3 uFwd; uniform vec3 uRight; uniform vec3 uUp; uniform vec2 uTan;
uniform vec3 uStarP; uniform vec3 uStarM; uniform vec3 uStarE; uniform vec3 uMoonDir; uniform float uSunTrue;
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=h1(uint(int(i.x)*7919+int(i.y)*104729)), b=h1(uint(int(i.x+1.0)*7919+int(i.y)*104729));
  float c=h1(uint(int(i.x)*7919+int(i.y+1.0)*104729)), d=h1(uint(int(i.x+1.0)*7919+int(i.y+1.0)*104729));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
// stars fixed on the celestial sphere (q is the direction in the sky's own frame), with a
// faint Milky Way along one great circle
vec3 starField(vec3 d){
  vec3 q=vec3(dot(d,uStarM),dot(d,uStarE),dot(d,uStarP));
  const float SC=150.0;
  vec3 g=q*SC, cell=floor(g);
  ivec3 ic=ivec3(cell)+ivec3(512);
  uint hh=ih(uint(ic.x)*73856093u ^ uint(ic.y)*19349663u ^ uint(ic.z)*83492791u);
  float r=float(hh&65535u)/65535.0;
  vec3 col=vec3(0.0);
  if(r>0.988){
    vec3 j=vec3(float((hh>>16)&255u),float((hh>>24)&255u),float(ih(hh)&255u))/255.0-0.5;
    vec3 sp=normalize(cell+0.5+j*0.5)*SC;
    float dd=length(g-sp);
    float k=(r-0.988)/0.012;
    float b=0.25+5.0*pow(fract(k*37.13),7.0);
    vec3 tint=mix(vec3(1.0,0.78,0.58),vec3(0.72,0.82,1.0),fract(k*91.7));
    float tw=0.75+0.25*sin(uTime*(2.0+3.0*fract(k*13.3))+k*100.0);
    col=tint*b*tw*exp(-dd*dd/0.035);
  }
  vec3 B=normalize(vec3(0.35,0.42,0.84));
  float band=exp(-pow(dot(q,B),2.0)*22.0);
  float cl=vn(q.xy*9.0+q.z*3.0)*0.6+vn(q.yz*23.0)*0.4;
  col+=vec3(0.55,0.6,0.8)*band*smoothstep(0.25,0.85,cl)*0.07;
  return col;
}
uniform vec4 uFlash; uniform float uPixAng; uniform highp sampler3D uNoise3; uniform float uCloudQ;
// ---- clouds ----
// Volumetric clouds: every sky pixel raymarches a 3D density through the cloud layer at full
// resolution, marches toward the sun from each sample for self-shadowing, and scatters light with
// Beer's law, a powder term and a two-lobe phase function. The samples sit on horizontal slices at
// fixed heights, so they do not slide through the clouds as the camera moves or turns, and every
// noise lookup is filtered for the larger of the pixel and the gap between samples, so detail too
// small to be sampled reliably is blurred instead of popping. No random offsets, no lower
// resolution buffer and no blending with earlier frames: each frame is the same smooth function of
// camera and time, which is what keeps clouds still on fast machines.
const float CB=420.0, CHT=260.0;
// density at p, 0..1; top gets the height of this column's cloud top. full adds the detailed
// outline and 3D billows; without it, a smooth body for the light march.
float cDen(vec3 p, float foot, bool full, out float top){
  top=CB;
  float cov=cloudCoverL(p.xz);
  // the column's height comes from a blurred copy of the field, so towers grow from broad bodies
  // and a narrow peak in the noise cannot rise into a fin
  float hb=cloudThickL(p.xz,cov,max(foot,70.0)).y;
  if(hb<=0.0) return 0.0;
  // even small clouds are puffs, not flat lenses that look like dark strips edge-on
  top=CB+40.0+(CHT-40.0)*pow(hb,1.1);
  float v=(p.y-CB)/(top-CB);
  if(v<0.0||v>1.0) return 0.0;
  // flat bases, rounded tops: the higher up, the thicker the column must be to still be cloud
  float d=(full?cloudThickL(p.xz,cov,foot).x*0.6+hb*0.4:hb)-v*v*0.75-0.04;
  if(full && d>-0.35){
    // 3D billows and wisps drifting with the wind, so the sides are lumpy and soft, not walls
    vec3 w=p+vec3(uCloudWind.x,0.0,uCloudWind.y);
    float l=log2(max(foot,1e-3)*64.0);
    vec2 n=textureLod(uNoise3,w*(1.0/210.0),max(0.0,l-log2(210.0))).rg;
    float n2=textureLod(uNoise3,w*(1.0/62.0)+0.31,max(0.0,l-log2(62.0))).g;
    d-=(1.0-mix(n.r,n.g,0.6))*0.32+(1.0-n2)*0.13*(1.0-v*0.5);
    // small cauliflower billows that only eat into the outer shell, where the cloud is thin
    if(d>-0.12 && d<0.3){
      float n3=textureLod(uNoise3,w*(1.0/19.0)+0.67,max(0.0,l-log2(19.0))).g;
      d-=(1.0-n3)*0.06*(1.0-smoothstep(0.0,0.3,d));
    }
  }
  return clamp(d*4.0,0.0,1.0)*smoothstep(0.0,0.08,v);
}
float hgP(float c, float g){ float g2=g*g; return (1.0-g2)/pow(1.0+g2-2.0*g*c,1.5)*0.0796; }
vec4 skyClouds(vec3 d){
  if(uCloudOn<0.5 || d.y<0.015 || uCam.y>=CB) return vec4(0.0);
  // quality: Low/Medium/High/Ultra sets the slice count and light steps; always full resolution
  int nsl=uCloudQ<0.5?32:uCloudQ<1.5?48:uCloudQ<2.5?64:96, nl=uCloudQ<0.5?3:uCloudQ<2.5?4:5;
  float DY=CHT/float(nsl), stp=DY/d.y;
  float tb=(CB-uCam.y)/d.y;
  if(tb>9000.0) return vec4(0.0);
  float mu=dot(d,uSunDir);
  const float g1=0.6, g2=-0.2;
  float ph=mix((1.0-g1*g1)/pow(1.0+g1*g1-2.0*g1*mu,1.5),(1.0-g2*g2)/pow(1.0+g2*g2-2.0*g2*mu,1.5),0.3)*0.25;
  vec3 sunL=uSunCol*max(uSunDir.y*1.6,0.9);
  // moonlight is faint: clouds at night are grey shapes against the sky, not lit-up white
  sunL*=mix(1.0,0.3,uNight);
  vec3 amb0=uZenith*0.65+uHorizon*0.6;
  amb0=mix(vec3(dot(amb0,vec3(0.3,0.5,0.2))),amb0,0.85);
  float rain=cloudMapLod(uCam.xz+d.xz*(tb+60.0),vec2(0.0),1.0).b*uCloudSim;
  sunL*=1.0-0.7*rain;
  vec3 col=vec3(0.0); float T=1.0, tsum=0.0, wsum=0.0;
  for(int i=0;i<96;i++){
    if(i>=nsl) break;
    float t=(CB+(float(i)+0.5)*DY-uCam.y)/d.y;
    if(t>tb+9000.0) break;
    vec3 p=uCam+d*t;
    float foot=max(t*uPixAng,stp*0.5), top;
    float den=cDen(p,foot,true,top);
    if(den<=0.002) continue;
    // light: growing steps toward the sun through the smooth body, plus the rest of the column
    // above, so the base of a thick cloud or a storm deck is in its own shade
    float ls=0.0, ds=12.0, tq; vec3 lp=p;
    for(int j=0;j<5;j++){
      if(j>=nl) break;
      lp+=uSunDir*ds; ls+=cDen(lp,foot+ds,false,tq)*ds; ds*=2.1;
    }
    float above=max(top-p.y,0.0);
    ls=max(ls,above/max(uSunDir.y,0.25)*0.35);
    float sigma=den*0.055*(1.0+1.5*rain);
    // multiple scattering, approximated with octaves: each one lets light through more easily and
    // scatters it more evenly, which is what makes thick cloud glow softly all through instead of
    // going black beyond the first few metres
    float sun=0.0, oa=1.0, ob=1.0, oc=1.0;
    for(int k=0;k<4;k++){
      sun+=ob*mix(hgP(mu,0.6*oc),hgP(mu,-0.2*oc),0.3)*exp(-ls*0.035*oa);
      oa*=0.4; ob*=0.6; oc*=0.5;
    }
    float powder=1.0-exp(-den*6.0);
    sun*=mix(1.0,powder,0.4)*11.0;
    float h=clamp((p.y-CB)/CHT,0.0,1.0);
    vec3 amb=amb0*mix(0.7,1.3,h)*(1.0-0.4*rain)*mix(1.0,0.8,smoothstep(20.0,180.0,above));
    vec3 S=(sunL*sun+amb)*sigma;
    if(uFlash.w>0.0) S+=vec3(0.7,0.75,1.0)*uFlash.w*6.0*exp(-length(p.xz-uFlash.xz)/450.0)*sigma;
    float tr=exp(-sigma*stp);
    col+=T*(S-S*tr)/max(sigma,1e-5);
    tsum+=T*(1.0-tr)*t; wsum+=T*(1.0-tr);
    T*=tr;
    if(T<0.01) break;
  }
  float a=1.0-T;
  if(a<0.002) return vec4(0.0);
  col*=mix(1.0,0.4,rain);
  // distant cloud sinks into the haze of the horizon
  float tc=tsum/max(wsum,1e-4);
  float f=exp(-max(tc-1800.0,0.0)*0.0005)*smoothstep(0.02,0.12,d.y);
  col*=f; a*=f;
  return vec4(col/max(a,1e-4),a);
}
void main(){
  vec3 d=normalize(uFwd+vP.x*uRight*uTan.x+vP.y*uUp*uTan.y);
  vec3 c=skyCol(d);
  float s=dot(d,uSunDir);
  if(uSunTrue>0.5) c+=uSunCol*smoothstep(0.9993,0.9997,s)*4.0;
  if(d.y>0.0 && uNight>0.0) c+=starField(d)*uNight*smoothstep(0.0,0.15,d.y);
  // the moon: a pale disc with darker seas, faint by day
  float ms=dot(d,uMoonDir);
  if(ms>0.99945){
    vec3 mt=cross(uMoonDir,vec3(0.0,1.0,0.0)); mt=normalize(mt+vec3(1e-4)); vec3 mb=cross(mt,uMoonDir);
    vec2 mp=vec2(dot(d,mt),dot(d,mb))*900.0;
    float mare=vn(mp*0.5+3.0)*0.6+vn(mp*1.3)*0.4;
    float disc=smoothstep(0.99945,0.99965,ms);
    c=mix(c,vec3(0.86,0.88,0.94)*(0.75+0.35*mare)*(0.35+2.2*uNight),disc*smoothstep(-0.02,0.02,uMoonDir.y));
  }
  vec4 cl=skyClouds(d);
  c=mix(c,cl.rgb,cl.a);
  o=vec4(outHDR(c),1.0);
}`;


const VS_LEAF = `#version 300 es
${GLSL_COMMON}
uniform mat4 uVP; uniform sampler2D uHeight; uniform sampler2D uEmit; uniform int uEmitCount; uniform int uEmitBase; uniform float uWind; uniform float uSnow; uniform float uFoam; uniform float uRainMode;
out vec2 vUV; out vec3 vCol; out float vLight; out vec3 vWorld;
// Each instance belongs to one leaf block (an "emitter" with open air below), detaches,
// tumbles down with the wind, settles flat on the ground or water, then fades and respawns.
float groundAt(vec2 xz){ return texture(uHeight,(floor(xz)+0.5)/512.0).r*255.0; }
void main(){
  uint id=uint(gl_InstanceID);
  float a=h1(id*8u), b=h1(id*8u+1u), c=h1(id*8u+2u), e=h1(id*8u+3u), f=h1(id*8u+4u), g=h1(id*8u+5u), k=h1(id*8u+6u);
  vec2 cn=vec2(float(gl_VertexID&1),float(gl_VertexID>>1))*2.0-1.0;
  if(uFoam>0.5){
    // spray: droplets thrown up from the foot of a waterfall (60) or off the surf on a shore (61)
    int ei=uEmitBase+int(ih(id*7u+3u)%uint(max(uEmitCount,1)));
    vec4 E=texelFetch(uEmit,ivec2(ei%512,ei/512),0);
    bool surf=E.w>60.5;
    float life=surf ? 0.9+0.5*k : 0.6+0.5*k;
    float period=life+(surf ? 2.0+3.0*e : 0.15*e);
    float t=mod(uTime+c*97.0,period), tt=min(t,life);
    vec3 p0=vec3(E.x+0.5+(f-0.5)*0.9, E.y+(surf?0.86:-0.1), E.z+0.5+(g-0.5)*0.9);
    vec3 v0=surf ? vec3((a-0.5)*1.4+0.3*uWind,1.0+1.6*e,(b-0.5)*1.4) : vec3((a-0.5)*3.2,1.8+3.2*e,(b-0.5)*3.2);
    vec3 wp=p0+v0*tt-vec3(0.0,4.9*tt*tt,0.0);
    float sz=(surf ? 0.07+0.09*k : 0.05+0.08*k)*(1.0-smoothstep(life*0.55,life,tt))*step(t,life)*step(p0.y-0.25,wp.y);
    sz*=smoothstep(0.8,2.0,length(wp-uCam));
    vec3 V0=normalize(wp-uCam), U=normalize(cross(V0,vec3(0.0,1.0,0.0))), V=cross(U,V0);
    vUV=cn; wp+=(U*cn.x+V*cn.y)*sz; vWorld=wp;
    vLight=1.0; vCol=vec3(0.90,0.95,0.97);
    gl_Position=uVP*vec4(wp,1.0);
    return;
  }
  if(uRainMode>0.5){
    // rain: fast streaks slanted by the wind, wrapped around a box that follows the camera
    vec3 box=vec3(44.0,30.0,44.0);
    vec3 vel=vec3(uSeaWind.x*uSeaWind.z*3.5,-24.0-6.0*e,uSeaWind.y*uSeaWind.z*3.5);
    vec3 p=vec3(a,c,b)*box+vel*uTime;
    vec3 lo=uCam-box*vec3(0.5,0.4,0.5);
    vec3 wp=lo+mod(p-lo,box);
    float gr=groundAt(wp.xz);
    float on=step(gr,wp.y)*smoothstep(0.8,3.0,length(wp-uCam));
    vec3 A=normalize(vel)*(0.55+0.4*k), V0=normalize(wp-uCam), U=normalize(cross(V0,A))*0.018*on;
    vUV=cn; wp+=U*cn.x+A*cn.y*on; vWorld=wp;
    vLight=1.0; vCol=vec3(0.72,0.78,0.85);
    gl_Position=uVP*vec4(wp,1.0);
    return;
  }
  if(uSnow>0.5){
    // snowfall: flakes wrap around a box that follows the camera
    vec3 box=vec3(56.0,34.0,56.0);
    vec3 p=vec3(a,c,b)*box;
    p.y-=uTime*(0.8+e*0.7);
    p.x+=uTime*0.6*uWind*uSeaWind.x+sin(uTime*(0.4+f)+g*6.283)*0.7;
    p.z+=uTime*0.6*uWind*uSeaWind.y+cos(uTime*(0.3+g*0.6)+f*6.283)*0.6;
    vec3 lo=uCam-box*vec3(0.5,0.35,0.5);
    vec3 wp=lo+mod(p-lo,box);
    float gr=groundAt(wp.xz);
    float sz=(0.03+0.03*k)*step(gr,wp.y)*smoothstep(1.5,4.0,length(wp-uCam));
    vec3 V0=normalize(wp-uCam), U=normalize(cross(V0,vec3(0.0,1.0,0.0))), V=cross(U,V0);
    vUV=cn; wp+=(U*cn.x+V*cn.y)*sz; vWorld=wp;
    vLight=1.0; vCol=vec3(0.95,0.97,1.0);
    gl_Position=uVP*vec4(wp,1.0);
    return;
  }
  int ei=uEmitBase+int(ih(id*7u+3u)%uint(max(uEmitCount,1)));
  vec4 E=texelFetch(uEmit,ivec2(ei%512,ei/512),0);
  vec3 ep=vec3(E.x+0.15+a*0.7, E.y-0.05, E.z+0.15+b*0.7);
  float speed=0.7+e*0.6;
  // where the leaf has drifted after falling for time tf: flutter plus the local wind (uSeaWind.xy is
  // its direction; it used to always blow toward +x)
  #define LDRIFT(tf) (vec2((sin((tf)*(0.6+f)+g*6.283)-sin(g*6.283))*1.2*min(tf,1.5)/1.5+(tf)*0.6*uWind*uSeaWind.x,(cos((tf)*(0.5+g*0.8)+f*6.283)-cos(f*6.283))*1.0*min(tf,1.5)/1.5+(tf)*0.6*uWind*uSeaWind.y))
  // the landing time is found against the ground where the leaf actually comes down, not the
  // ground under its branch: drifting over a drop or out over water it used to stop at branch-
  // foot height and hang flat in the air
  float tland=max(ep.y-groundAt(ep.xz),0.3)/speed;
  for(int it=0;it<3;it++) tland=max(ep.y-groundAt(ep.xz+LDRIFT(tland)),0.3)/speed;
  float rest=5.0+k*7.0, period=tland+rest;
  float t=mod(uTime+c*97.0,period);
  float tf=min(t,tland);
  vec3 wp=ep;
  wp.y-=tf*speed;
  wp.xz+=LDRIFT(tf);
  float gr=groundAt(wp.xz);
  bool landed=t>=tland || wp.y<=gr+0.03;
  // a landed leaf lies on the ground under it (the wind can change after it lands)
  wp.y=landed ? gr+0.03 : max(wp.y,gr+0.03);
  float life=landed ? 1.0-smoothstep(rest*0.55,rest,t-tland) : 1.0;
  float sz=(0.13+0.1*k)*life*smoothstep(0.0,0.5,t)*(1.0-0.45*seasonW(uSeason).x);
  sz*=smoothstep(1.2,2.5,length(wp-uCam));
  if(uEmitCount==0) sz=0.0;
  vec3 U,V;
  if(landed){
    float r=g*6.283;
    U=vec3(cos(r),0.0,sin(r)); V=vec3(-sin(r),0.0,cos(r));
  } else {
    float ax=t*(1.2+e*2.5)+g*6.283, ay=t*(0.8+f*1.8)+a*6.283;
    U=vec3(cos(ay),0.0,sin(ay));
    V=vec3(-sin(ay)*sin(ax),cos(ax),cos(ay)*sin(ax));
  }
  vUV=cn;
  wp+=(U*cn.x+V*cn.y)*sz;
  vWorld=wp;
  vec3 N=normalize(cross(U,V));
  vLight=landed ? 0.35+0.85*max(uSunDir.y,0.0) : 0.35+0.85*abs(dot(N,uSunDir));
  int ty=int(E.w+0.5);
  vec3 base = ty==9 ? vec3(0.70,0.10,0.05) : ty==10 ? vec3(0.88,0.40,0.06) : ty==11 ? vec3(0.92,0.70,0.14) : vec3(0.52,0.28,0.10);
  vec4 W=seasonW(uSeason);
  // spring sheds blossom petals, summer the odd green leaf
  base=W.x*mix(vec3(0.88,0.55,0.64),vec3(0.95,0.75,0.80),a)+W.y*vec3(0.26,0.44,0.14)+(W.z+W.w)*base;
  vCol=base*(0.85+0.3*k);
  if(landed) vCol*=0.85;
  gl_Position=uVP*vec4(wp,1.0);
}`;
const FS_LEAF = `#version 300 es
${GLSL_COMMON}
uniform vec3 uAmbSky; uniform float uSnow; uniform float uFoam; uniform float uRainMode;
in vec2 vUV; in vec3 vCol; in float vLight; in vec3 vWorld; out vec4 o;
void main(){
  vec2 p=vUV;
  if(uRainMode>0.5){
    vec3 lit=pow(vCol,vec3(2.2))*(uAmbSky*1.6+uSunCol*0.25+uZenith*0.4);
    o=vec4(outHDR(applyFog(lit,vWorld)),(1.0-abs(p.x))*(0.55-0.35*abs(p.y))*0.6);
    return;
  }
  if(uSnow>0.5||uFoam>0.5){
    if(dot(p,p)>1.0) discard;
    vec3 lit=pow(vCol,vec3(2.2))*(uAmbSky*1.3+uSunCol*0.5);
    o=vec4(outHDR(applyFog(lit,vWorld)),1.0);
    return;
  }
  float ang=atan(p.y,p.x);
  float r=0.62+0.3*pow(abs(cos(ang*2.5)),2.0);
  float stem=step(abs(p.x),0.07)*step(p.y,-0.4);
  if(length(p)>r && stem<0.5) discard;
  vec3 alb=pow(vCol*(0.85+0.2*step(abs(p.x),0.05)),vec3(2.2));
  vec3 lit=alb*(uAmbSky*0.9+uSunCol*vLight*0.65);
  lit=applyFog(lit,vWorld);
  o=vec4(outHDR(lit),1.0);
}`;

const VS_LINE = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uVP; uniform vec3 uPos;
void main(){ gl_Position=uVP*vec4(uPos+(aPos-0.5)*1.004+0.5,1.0); }`;
const FS_LINE = `#version 300 es
precision mediump float; out vec4 o; void main(){ o=vec4(0.08,0.05,0.03,0.85); }`;

const VS_BOLT = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;
uniform mat4 uVP; out float vW;
void main(){
  vW=aPos.w; gl_Position=uVP*vec4(aPos.xyz,1.0);
  // strikes beyond the far plane are pinned to it, so terrain in range still hides them
  gl_Position.z=min(gl_Position.z,gl_Position.w*0.99999);
}`;
const FS_BOLT = `#version 300 es
precision highp float;
in float vW; out vec4 o; uniform float uI; uniform float uEnc;
void main(){ o=vec4(vec3(5.0,5.4,7.0)*uI*vW*uEnc,1.0); }`;


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
// deep is 0..1, how deep the water is under this point (0 within ~4 blocks of the sea floor, 1 past
// ~16): only there do the long storm swells run, 30..90 blocks long and up to a few blocks high,
// growing with the wind like a real sea (longer waves need a stronger, longer-blowing wind).
// seaAmp is the summed amplitude, so the shader can tell how high a point sits on the waves.
uniform vec3 uSeaWind;
float seaJ, seaAmp;
vec3 seaWave(vec2 p, float t, float s, float deep, float fp, out vec3 nrm){
  float Lw[8]=float[8](21.0,8.5,16.0,11.0,19.0,7.0,13.5,9.5);
  vec3 off=vec3(0.0); vec3 n=vec3(0.0,1.0,0.0);
  vec2 wd=uSeaWind.xy;
  float jxx=1.0, jzz=1.0, jxz=0.0; seaAmp=0.0;
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
  float BL[6]=float[6](88.0,64.0,47.0,76.0,55.0,38.0);
  float B[6];
  for(int i=0;i<6;i++){
    float ang=float(i)*1.0472+0.13;
    float al=max(dot(vec2(cos(ang),sin(ang)),wd),0.0);
    float k=6.2831/BL[i];
    // fully grown only when the wind is strong enough for this wavelength
    float grow=smoothstep(BL[i]/110.0,BL[i]/110.0+0.8,uSeaWind.z);
    B[i]=min(0.03*BL[i]*pow(al,1.5)*pow(uSeaWind.z,1.5),0.12/k)*grow*deep*(1.0-smoothstep(BL[i]*0.12,BL[i]*0.4,fp));
    S+=k*B[i];
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
    seaAmp+=a;
  }
  for(int i=0;i<6;i++){
    float ang=float(i)*1.0472+0.13;
    vec2 D=vec2(cos(ang),sin(ang));
    float a=B[i];
    float k=6.2831/BL[i], c=sqrt(9.8/k)*0.55, f=k*dot(D,p)-k*c*t+float(i)*1.7;
    float cf=cos(f), sf=sin(f), qk=Q*a*k*sf;
    off.xz+=Q*a*D*cf; off.y+=a*sf;
    n.xz-=D*k*a*cf; n.y-=Q*k*a*sf;
    jxx-=qk*D.x*D.x; jzz-=qk*D.y*D.y; jxz-=qk*D.x*D.y;
    seaAmp+=a;
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
// weather on the ground: uWet how wet surfaces are (0..1); uSnowMap the snow lying on the land
// around the player, per weather cell (origin uSnowO): R the height (/2) above which the season's
// snow lies, G the lower edge (/2) of fresh snow, B how much fresh snow there is; uFog2 low fog
// (x density at its base, y base height, z how fast it thins upward); uRainVeil 1 when rain anywhere
// on the cloud map is heavy enough to see from afar
uniform float uWet; uniform sampler2D uSnowMap; uniform vec2 uSnowO; uniform vec4 uFog2; uniform float uRainVeil;
${GLSL_HASH}
float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  uint a=uint(int(i.x)*7919+int(i.y)*104729+977);
  return mix(mix(h1(a),h1(a+7919u),f.x),mix(h1(a+104729u),h1(a+112648u),f.x),f.y); }
// how much snow lies on an upward face at p: it belongs to the land, so it stays where it fell
// (the edges are roughened a little so they don't follow the contour lines exactly)
float snowCover(vec3 p){
  vec4 m=texture(uSnowMap,(p.xz/16.0-uSnowO)/128.0);
  float y=p.y+(vn2(p.xz/9.0)-0.5)*5.0, lc=m.r*510.0, fe=m.g*510.0;
  return clamp(max(m.b*smoothstep(fe-2.0,fe+4.0,y), smoothstep(lc,lc+12.0,y)),0.0,1.0);
}
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
// how stormy it is right around the player (0..1): rain falling here or close by. Rain on you means
// cloud over you, so the sky closes into a dark deck out to a couple of km whatever the blurred map says
uniform float uOvercast;
float overcastAt(vec2 xz){ return uOvercast*uCloudSim*(1.0-smoothstep(1500.0,4500.0,length(xz-uCam.xz))); }
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
// uCloud2D: tiling 2D noise (cirrus); uCloudWind: how far the wind has carried the clouds
uniform sampler2D uCloud2D; uniform vec2 uCloudWind; uniform float uCloudMean;
// How much of the sky is cloud at xz. The weather sim only steers the amount, smoothly over a
// few hundred blocks: fair weather keeps separate puffs (the noise makes the shapes), wetter air
// packs them closer, and only where it really rains do they merge into a deck. Feeding the sim's
// cell-by-cell cover straight in merged clouds into big shapeless masses.
float cloudCover(vec2 xz){
  if(uCloudSim<0.5) return 0.42;
  vec2 uv=cloudUV(xz);
  float e=smoothstep(0.0,0.2,uv.x)*smoothstep(1.0,0.8,uv.x)*smoothstep(0.0,0.2,uv.y)*smoothstep(1.0,0.8,uv.y);
  vec4 m=cloudMapLod(xz,vec2(0.0),3.0);
  float sim=mix(uCloudMean,m.r*m.r,e);
  float cov=0.28+0.36*smoothstep(0.05,0.85,sim);
  // where it rains the cloud closes into a solid deck: read less blurred than the cover, so a storm
  // or a front's rain band isn't averaged away into the fair-weather puffs around it
  float rn=cloudMapLod(xz,vec2(0.0),2.0).b*e;
  return max(max(cov,smoothstep(0.08,0.5,rn)*0.93),overcastAt(xz)*0.97);
}
// cloud thickness used to come from 2D noise here; since v65 the clouds are a 3D Nubis-style
// volume (cDen below) and the terrain's cloud shadows read the same density.
// ---- volumetric cloud shapes (after Schneider's Nubis, Horizon Zero Dawn; written from the talks) ----
// The weather never draws a cloud. It says how likely cloud is (coverage) and which kind (type:
// stratus .. cumulonimbus, each with its own height profile); a tiling 3D Perlin-Worley noise makes
// the individual clouds, and coverage only moves the threshold on that noise. Low coverage leaves
// separate puffs, more coverage grows and joins them. Tried and tuned in the Cloud Lab page.
uniform highp sampler3D uCloudBase; uniform highp sampler3D uCloudDetail;
uniform sampler2D uCloudMap2; uniform sampler2D uCloudMap2P;
const float CB=420.0, CHT=1500.0, CBT=3600.0, CDT=420.0;
float cRemap(float v,float l,float h,float a,float b){ return a+(v-l)*(b-a)/(h-l); }
// type 0..1 -> where the column rises (x..y) and falls (z..w), in fractions of CHT
vec4 cProfile(float t){
  const vec4 st=vec4(0.0,0.015,0.04,0.075), cu=vec4(0.0,0.035,0.11,0.21), cg=vec4(0.0,0.05,0.3,0.5), cb=vec4(0.0,0.05,0.82,1.0);
  t*=3.0; return t<1.0?mix(st,cu,t):t<2.0?mix(cu,cg,t-1.0):mix(cg,cb,t-2.0);
}
// cloud type from the sim: gentle widespread lift (low cvt) gives stratus sheets, convective air
// cumulus, and convective air with high tops towers into cumulonimbus. Fair weather when the sim is off.
float cloudType(vec2 xz){
  if(uCloudSim<0.5) return 0.36;
  vec2 uv=cloudUV(xz);
  float e=smoothstep(0.0,0.2,uv.x)*smoothstep(1.0,0.8,uv.x)*smoothstep(0.0,0.2,uv.y)*smoothstep(1.0,0.8,uv.y);
  // blurred like the cover, so cloud heights change smoothly instead of in steps from cell to cell
  vec4 m=cloudMapLod(xz,vec2(0.0),3.0);
  float cvt=mix(textureLod(uCloudMap2P,(xz/16.0-uCloudOP)/128.0,3.0).g,textureLod(uCloudMap2,uv,3.0).g,uCloudF);
  float t=mix(0.14,0.38,smoothstep(0.15,0.55,cvt))+0.6*smoothstep(0.45,0.9,m.g)*smoothstep(0.35,0.75,cvt);
  // a rain deck is thick nimbostratus, not a thin sheet with sky light coming through
  t=max(t,0.55*max(smoothstep(0.1,0.5,cloudMapLod(xz,vec2(0.0),2.0).b),overcastAt(xz)));
  return mix(0.36,clamp(t,0.0,1.0),e);
}
// density 0..1 at p; full adds the detail erosion of the edges. hT: height within this cloud
// type's column (0 base .. 1 top), for the sky light.
float cDen(vec3 p, float foot, bool full, out float hT){
  hT=0.0;
  float hf=(p.y-CB)/CHT;
  if(hf<0.0||hf>1.0) return 0.0;
  float cov=cloudCover(p.xz), typ=cloudType(p.xz);
  vec4 pr=cProfile(typ);
  float g=smoothstep(pr.x,pr.y,hf)*(1.0-smoothstep(pr.z,pr.w,hf));
  hT=clamp(hf/pr.w,0.0,1.0);
  if(g<=0.0) return 0.0;
  vec3 q=p+vec3(uCloudWind.x,0.0,uCloudWind.y);
  vec4 b=textureLod(uCloudBase,q/CBT,max(0.0,log2(foot*128.0/CBT)));
  float lf=b.g*0.625+b.b*0.25+b.a*0.125;
  // the remapped noise only spans about 0.6..0.83; stretch it to 0..1 so coverage is roughly
  // the share of sky that is cloud
  float base=clamp((cRemap(b.r,lf-1.0,1.0,0.0,1.0)-0.6)/0.23,0.0,1.0)*g;
  // anvils: a cumulonimbus top spreads out, but only where the storm itself is
  float ca=mix(cov,pow(cov,cRemap(clamp(hf,0.62,0.85),0.62,0.85,1.0,0.3)),smoothstep(0.8,1.0,typ)*smoothstep(0.35,0.6,cov));
  float c=clamp(cRemap(base,1.0-ca,1.0,0.0,1.0),0.0,1.0)*ca;
  if(full && c>0.0){
    vec3 dn=textureLod(uCloudDetail,q/CDT+vec3(0.0,uTime*0.002,0.0),max(0.0,log2(foot*64.0/CDT))).rgb;
    float df=dn.r*0.625+dn.g*0.25+dn.b*0.125;
    // wispy near the base, billowy higher up
    c=clamp(cRemap(c,mix(df,1.0-df,clamp(hT*3.0,0.0,1.0))*0.38,1.0,0.0,1.0),0.0,1.0);
  }
  return c;
}
// how much sunlight reaches p past the clouds: two looks at the smooth cloud body along the sun ray
float cloudShade(vec3 p){
  if(uCloudOn<0.5 || p.y>=CB) return 1.0;
  float sy=max(uSunDir.y,0.12), od=0.0, hT;
  for(int k=0;k<2;k++){
    float y=CB+CHT*(k==0?0.06:0.2);
    vec3 q=p+uSunDir*(y-p.y)/sy;
    od+=cDen(q,120.0,false,hT)*(k==0?200.0:400.0);
  }
  // forward scattering lets a lot of light through, so shadows are softer than the cloud is opaque
  return mix(0.35,1.0,exp(-od*0.012));
}
// scene passes write linear HDR; tonemapping happens in the post stack
vec3 outHDR(vec3 c){ return max(c,vec3(0.0))*uEnc; }
// Distant rain: grey shafts under raining cloud, so a shower can be seen coming across the land.
// Six looks at the blurred rain map at fixed distances along the view ray (the rain right around
// the player is drawn as streaks). Returns the opacity of the rain in front of a point dist away.
float rainVeil(vec3 dir, float dist){
  if(uRainVeil<0.5 || uCloudSim<0.5 || uCloudOn<0.5) return 0.0;
  float od=0.0, t=110.0;
  for(int i=0;i<9;i++){
    if(t>dist) break;
    vec3 p=uCam+dir*t;
    if(p.y>CB) break;
    vec2 uv=cloudUV(p.xz);
    float e=smoothstep(0.0,0.15,uv.x)*smoothstep(1.0,0.85,uv.x)*smoothstep(0.0,0.15,uv.y)*smoothstep(1.0,0.85,uv.y);
    // (well blurred, so a shaft has soft sides instead of a straight wall where the rain stops)
    float r=smoothstep(0.08,0.5,cloudMapLod(p.xz,vec2(0.0),3.5).b)*e;
    od+=r*min(t*0.35,dist-t)*0.0022;
    t*=1.35;
  }
  return 1.0-exp(-od);
}
vec3 veilCol(){ return vec3(dot(uHorizon,vec3(0.3,0.5,0.2)))*0.32+uZenith*0.1+uSunCol*0.03; }
// analytic exponential height fog: density k0 at height base, thinning by K per block upward
float heightFog(vec3 dir, float dist, float k0, float base, float K){
  float y0=max(uCam.y-base,-25.0), dy=dir.y;
  float amt=k0*exp(-K*y0)*(abs(dy)>1e-3 ? (1.0-exp(-K*dist*dy))/(K*dy) : dist);
  return 1.0-exp(-max(amt,0.0));
}
vec3 fogCol(vec3 dir){
  float sa=pow(max(dot(dir,uSunDir),0.0),6.0);
  vec3 g=vec3(dot(uHorizon,vec3(0.3,0.5,0.2)));
  return mix(uHorizon,g,0.55)*1.05+uZenith*0.1+uSunCol*0.18*sa;
}
vec3 applyFog(vec3 c, vec3 wp){
  vec3 dv=wp-uCam; float dist=length(dv); vec3 dir=dv/max(dist,1e-4);
  float f=1.0-exp(-pow(dist*uFogDen,2.0));
  c=mix(c, skyCol(dir), clamp(f,0.0,1.0));
  float rv=rainVeil(dir,dist);
  if(rv>0.0) c=mix(c,veilCol(),rv*0.85);
  // low fog: sea fog rolling in, or fog pooled in the valleys after a clear calm night
  if(uFog2.x>0.0) c=mix(c,fogCol(dir),heightFog(dir,dist,uFog2.x,uFog2.y,uFog2.z));
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
out vec3 vWorld; out vec3 vPos; out vec4 vLP; out float vAO; out float vSeaD; flat out uint vBlock; flat out int vN;
const vec3 NRM[6]=vec3[6](vec3(1,0,0),vec3(-1,0,0),vec3(0,1,0),vec3(0,-1,0),vec3(0,0,1),vec3(0,0,-1));
vec3 windOff(vec3 p){
  return vec3(sin(uTime*1.9+p.x*0.7+p.z*0.4), sin(uTime*1.3+p.x*0.5)*0.4, cos(uTime*1.5+p.z*0.6+p.y*0.3))*0.06*uWind;
}
void main(){
  uint d=aData;
  vec3 p=vec3(float(d&63u), float((d>>6u)&127u), float((d>>13u)&63u));
  int n=int((d>>19u)&7u); uint b=d>>24u;
  vec3 w=uOrigin+p, wv=w;
  // open-sea surface vertices carry the full water depth as 145+depth in the block byte
  vSeaD=0.0;
  if(b>=145u){ vSeaD=smoothstep(4.0,16.0,float(b-145u)); b=144u; }
  // water: block byte is 64 + level*9 + dir; lower surface vertices to the water level
  if(b>=64u){
    float lv=float((b-64u)/9u);
    bool topV = n==2 || (n!=3 && ((d>>22u)&3u)==1u);
    if(topV) wv.y-=0.12+(8.0-lv)/8.0*0.85;
    if(n==2 && lv>7.5 && abs(w.y-31.0)<0.01){
      vec3 nn; float s=float((d>>22u)&3u)/3.0;
      wv+=seaWave(w.xz,uTime,s,vSeaD,0.0,nn);
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
    c=mix(c,SNOWC,snowCover(vWorld)*0.5*smoothstep(0.55,1.0,t));
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
  // snow settles on every upward face and creeps over the top edge of sides: the season's lasting
  // snow above the snow line, and fresh snow wherever it has been snowing until it melts
  float snowA=0.0, sc=snowCover(vWorld);
  if(sc>0.0 && b!=25u && b!=26u){
    float spot=th(ch,tx/4+ivec2(3,11));
    // sides only creep on ground blocks; logs and leaves would show a band on every block
    bool ground = b==1u||b==2u||b==4u||b==14u||b==15u;
    float cover = top ? 1.0 : side && ground && lp.y>0.86-0.12*n ? 0.85 : 0.0;
    snowA=smoothstep(0.25,0.75,sc*cover*(0.75+0.45*spot));
    c=mix(c,SNOWC*(0.93+0.07*n),snowA);
  }
  vec3 alb=pow(c,vec3(2.2));
  // rain wets the world: soil, sand and bark darken, leaves a little, and in flat low spots of
  // open ground water stands in puddles
  float wetA=0.0, pud=0.0;
  if(uWet>0.0 && b!=25u && b!=26u){
    wetA=uWet*(1.0-snowA)*(top?1.0:0.65);
    if(top && (b==1u||b==2u||b==3u||b==4u||b==14u||b==15u||b==16u)){
      float pn=vn2(vWorld.xz*0.08)*0.65+vn2(vWorld.xz*0.27+17.0)*0.35;
      pud=smoothstep(0.5,0.54,pn+0.1*(uWet-1.0))*smoothstep(0.35,0.8,uWet)*(1.0-snowA);
    }
    alb*=mix(1.0,leaf?0.82:b==4u?0.7:0.6,wetA);
  }
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
  if(wetA>0.0){
    // a wet sheen: the sky and sun reflected, strongest at grazing angles; puddles are mirrors,
    // pocked by raindrops while it rains
    vec3 V=normalize(vWorld-uCam), Nw=N;
    if(pud>0.0 && uRain>0.02){
      vec2 rq=vWorld.xz*2.2, rc=floor(rq);
      float hh=h1(uint(int(rc.x)*7919+int(rc.y)*104729+51)), ph=fract(uTime*1.3+hh);
      float dl=length(rq-rc-0.5), ring=sin((dl-ph*0.6)*30.0)*exp(-abs(dl-ph*0.6)*12.0)*(1.0-ph);
      Nw=normalize(N+vec3(rq-rc-0.5,0.0).xzy*ring*0.5*step(hh,uRain*1.2));
    }
    vec3 R=reflect(V,Nw);
    float fr=0.03+0.97*pow(1.0-max(dot(-V,Nw),0.0),5.0);
    vec3 refl=skyCol(R)*mix(0.35,1.0,sh)+uSunCol*sh*pow(max(dot(R,uSunDir),0.0),pud>0.0?600.0:90.0)*(pud>0.0?6.0:1.5);
    float k=wetA*0.3*(top?1.0:0.4)+pud;
    lit=mix(lit*mix(1.0,0.55,pud),refl,clamp(fr*k,0.0,1.0));
  }
  lit=applyFog(lit,vWorld);
  o=vec4(outHDR(lit),1.0);
}`;

const FS_WATER = `#version 300 es
${GLSL_COMMON}
${FS_LIGHTING}
uniform highp sampler3D uNoise3;
in vec3 vWorld; in vec3 vPos; in vec4 vLP; in float vAO; in float vSeaD; flat in uint vBlock; flat in int vN;
uniform sampler2D uSceneColor; uniform sampler2D uSceneDepth; uniform vec2 uRes; uniform vec2 uNearFar; uniform mat4 uVP; uniform float uSSR;
// the boat: its wake as a trail of stern positions (x, z, age s, speed m/s), newest first, and
// where it is now (x, z, heading x, z) with its speed, for the white water around the hull
uniform vec4 uWake[16]; uniform int uWakeN; uniform vec4 uBoat; uniform float uBoatS;
float boatFoam(vec2 p){
  if(uWakeN<=0) return 0.0;
  float wk=0.0;
  for(int i=0;i<15;i++){
    if(i>=uWakeN-1) break;
    vec4 a=uWake[i], c=uWake[i+1];
    vec2 ab=c.xy-a.xy; float l2=max(dot(ab,ab),1e-4);
    float h=clamp(dot(p-a.xy,ab)/l2,0.0,1.0);
    float d=length(p-a.xy-ab*h), age=mix(a.z,c.z,h), sp=mix(a.w,c.w,h);
    // churned water straight behind, and the two arms of the V spreading at the Kelvin angle
    float core=1.0-smoothstep(0.5+age*0.35,1.2+age*0.7,d);
    float arm=1.0-smoothstep(0.0,0.45+age*0.25,abs(d-(1.3+age*sp*0.34)));
    wk=max(wk,(core*0.85+arm*0.55)*exp(-age*0.33)*smoothstep(0.4,2.5,sp));
  }
  // bow wave and the white water hugging the hull
  vec2 q=p-uBoat.xy, F=uBoat.zw;
  float al=dot(q,F), ac=dot(q,vec2(-F.y,F.x));
  float e=length(vec2(al/5.2,ac/1.85));
  float hullF=(1.0-smoothstep(0.0,0.22,abs(e-1.04)))*smoothstep(0.3,3.0,uBoatS)*(0.45+0.55*smoothstep(-2.0,4.0,al));
  return max(wk,hullF);
}
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
    vec3 sn; vec3 off=seaWave(vWorld.xz,uTime,swell,vSeaD,fpx,sn);
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
    crest=off.y/max(0.9*seaAmp,0.05);
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
  // out over deep water the bottom is lost entirely: open ocean is a dark blue, not a lagoon
  if(sea) thick=swell>0.99 ? mix(6.0,30.0,vSeaD) : swell*3.0;
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
    f=max(f,boatFoam(vWorld.xz));
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
uniform vec4 uFlash; uniform float uPixAng; uniform highp sampler3D uNoise3; uniform float uCloudQ; uniform float uBow;
// A rainbow: sunlight turned back by raindrops in a ring round the point opposite the sun, red
// outside at about 42 degrees, violet inside; a fainter second bow at about 51 degrees with the
// colours the other way round, and the sky between the two darker (Alexander's band).
vec3 bowHue(float x){ float h=(1.0-clamp(x,0.0,1.0))*0.78; return clamp(abs(fract(h+vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0)-1.0,0.0,1.0); }
vec3 rainbow(vec3 d, out float dark){
  float a=degrees(acos(clamp(dot(d,-uSunDir),-1.0,1.0)));
  float x=(a-40.3)/2.2, y=(53.8-a)/3.4;
  vec3 c=bowHue(x)*smoothstep(-0.25,0.1,x)*smoothstep(1.25,0.9,x);
  c+=bowHue(y)*smoothstep(-0.25,0.1,y)*smoothstep(1.25,0.9,y)*0.4;
  dark=smoothstep(41.0,42.5,a)*smoothstep(51.5,50.0,a);
  // the sky inside the bow is a little brighter
  c+=vec3(0.18)*smoothstep(40.5,25.0,a)*smoothstep(10.0,30.0,a);
  return c;
}
// ---- clouds ----
// Volumetric clouds: every sky pixel raymarches a 3D density through the cloud layer at full
// resolution, marches toward the sun from each sample for self-shadowing, and scatters light with
// Beer's law, a powder term and a two-lobe phase function. The samples sit on horizontal slices at
// fixed heights, so they do not slide through the clouds as the camera moves or turns, and every
// noise lookup is filtered for the larger of the pixel and the gap between samples, so detail too
// small to be sampled reliably is blurred instead of popping. No random offsets, no lower
// resolution buffer and no blending with earlier frames: each frame is the same smooth function of
// camera and time, which is what keeps clouds still on fast machines.
float hgP(float c, float g){ float g2=g*g; return (1.0-g2)/pow(1.0+g2-2.0*g*c,1.5)*0.0796; }
// High cirrus: thin streaky ice cloud on one plane far above the cumulus, as much as the weather
// sim's cirrus field says (anvils blowing off, storm outflow), a light veil in fair weather. The
// idea of a separate cirrus plane is after Mirai (MIT, bambosan); this is our own code. One
// filtered lookup per pixel, so it cannot shimmer.
const float CIH=2600.0;
vec4 skyCirrus(vec3 d){
  if(uCloudOn<0.5 || d.y<0.02 || uCam.y>=CIH) return vec4(0.0);
  float t=(CIH-uCam.y)/d.y;
  vec2 xz=uCam.xz+d.xz*t;
  vec2 w=xz+uCloudWind*1.7;
  // stretched along one direction, so it reads as wisps and mares' tails, not as blotches
  vec2 q=vec2(dot(w,vec2(0.92,0.39)),dot(w,vec2(-0.39,0.92)));
  // broad soft veils: a big, gently stretched pattern decides where, finer streaks only shade it
  float n=texture(uCloud2D,q*vec2(1.0/9000.0,1.0/3500.0),1.5).r*0.7+texture(uCloud2D,q*vec2(1.0/3000.0,1.0/1100.0)+0.3,1.0).r*0.3;
  float st=texture(uCloud2D,q*vec2(1.0/1600.0,1.0/400.0)+0.7).b;
  float amt=0.3;
  if(uCloudSim>0.5){
    vec2 uv=cloudUV(xz);
    float e=smoothstep(0.0,0.2,uv.x)*smoothstep(1.0,0.8,uv.x)*smoothstep(0.0,0.2,uv.y)*smoothstep(1.0,0.8,uv.y);
    float ci=mix(texture(uCloudMap2P,(xz/16.0-uCloudOP)/128.0).r,texture(uCloudMap2,uv).r,uCloudF);
    amt=mix(0.3,max(ci,0.15),e);
  }
  float dens=smoothstep(0.62-0.3*amt,0.95-0.2*amt,n)*mix(0.6,1.0,st)*0.4;
  dens*=smoothstep(0.02,0.18,d.y)*exp(-max(t-9000.0,0.0)*0.0002);
  if(dens<=0.001) return vec4(0.0);
  float mu=dot(d,uSunDir);
  vec3 sunL=uSunCol*max(uSunDir.y*1.6,0.9)*mix(1.0,0.3,uNight);
  vec3 amb=uZenith*0.7+uHorizon*0.5;
  vec3 col=sunL*(hgP(mu,0.7)*2.5+0.25)+amb;
  return vec4(col,dens);
}
vec4 skyClouds(vec3 d){
  if(uCloudOn<0.5 || d.y<0.015 || uCam.y>=CB) return vec4(0.0);
  // quality: Low/Medium/High/Ultra sets the slice count and light steps; always full resolution.
  // Slices sit at fixed heights, closer together near the base where most cloud is, so samples
  // never slide through the clouds as the camera moves.
  int nsl=uCloudQ<0.5?32:uCloudQ<1.5?48:uCloudQ<2.5?64:96, nl=uCloudQ<0.5?4:uCloudQ<2.5?5:6;
  float tb=(CB-uCam.y)/d.y;
  if(tb>9000.0) return vec4(0.0);
  float mu=dot(d,uSunDir);
  vec3 sunL=uSunCol*max(uSunDir.y*1.6,0.9);
  // moonlight is faint: clouds at night are grey shapes against the sky, not lit-up white
  sunL*=mix(1.0,0.3,uNight);
  // skylight from above is blue; shaded sides take on the sky colour, not a flat grey
  vec3 amb0=uZenith*0.55+uHorizon*0.3;
  vec3 col=vec3(0.0); float T=1.0, tsum=0.0, wsum=0.0, n=float(nsl);
  for(int i=0;i<96;i++){
    if(i>=nsl) break;
    float y0=CHT*pow(float(i)/n,1.4), y1=CHT*pow(float(i+1)/n,1.4);
    float t=(CB+0.5*(y0+y1)-uCam.y)/d.y, stp=(y1-y0)/d.y;
    if(t>tb+9000.0) break;
    vec3 p=uCam+d*t;
    float foot=max(t*uPixAng,stp*0.5), hT;
    // density: the mean of three looks spread through the slice at fixed fractions of its height.
    // One look per slice drew the side of a tall cloud as stacked stripes, one per slice, wherever
    // the ray crosses a slice in a long slanted step. Light is still worked out once, at the middle.
    float den=0.0, hq2;
    for(int k=0;k<3;k++){
      vec3 q=uCam+d*(t+stp*(float(k)-1.0)/3.0);
      float dk=cDen(q,foot,false,hq2);
      if(dk>0.0) den+=cDen(q,foot,true,hq2);
    }
    den/=3.0;
    if(den<=0.003) continue;
    cDen(p,foot,false,hT);
    // light: growing steps toward the sun through the smooth body, then one far look, so the base
    // of a tall cloud is in its own shade
    float ls=0.0, ds=18.0, s=0.0, hq; vec3 lp=p;
    for(int j=0;j<6;j++){
      if(j>=nl) break;
      lp+=uSunDir*ds; s+=ds; ls+=cDen(lp,foot+s*0.25,false,hq)*ds; ds*=1.65;
    }
    ls+=cDen(p+uSunDir*(s+700.0),foot+300.0,false,hq)*450.0;
    // rain darkens only the cloud it falls from: sampled where this sample is, blurred so a sharp
    // rain band in the sim cannot cut a hard-edged dark sheet across the sky
    float rain=max(smoothstep(0.08,0.6,cloudMapLod(p.xz,vec2(0.0),2.0).b)*uCloudSim,overcastAt(p.xz));
    float sigma=den*0.07*(1.0+1.5*rain), od=ls*0.07*(1.0+1.5*rain);
    // multiple scattering as octaves (Wrenninge 2013, Hillaire 2016): each one lets light through
    // more easily and scatters it more evenly, so thick cloud glows instead of going black
    float sun=0.0, oa=1.0, ob=1.0, oc=1.0;
    for(int k=0;k<4;k++){
      sun+=ob*mix(hgP(mu,0.8*oc),hgP(mu,-0.3*oc),0.25)*exp(-od*oa);
      oa*=0.4; ob*=0.55; oc*=0.55;
    }
    // powder: sun-facing edges that light has barely entered look darker when seen from the side
    sun*=mix(1.0,1.0-exp(-od*2.5-den*1.5),0.6*(0.55-0.45*mu))*11.0;
    vec3 amb=amb0*mix(0.45,1.25,hT)*(1.0-0.4*rain);
    vec3 S=(sunL*(1.0-0.7*rain)*sun+amb)*mix(1.0,0.4,rain)*sigma;
    if(uFlash.w>0.0) S+=vec3(0.7,0.75,1.0)*uFlash.w*6.0*exp(-length(p.xz-uFlash.xz)/450.0)*sigma;
    float tr=exp(-sigma*stp);
    col+=T*(S-S*tr)/max(sigma,1e-5);
    tsum+=T*(1.0-tr)*t; wsum+=T*(1.0-tr);
    T*=tr;
    if(T<0.01) break;
  }
  float a=1.0-T;
  if(a<0.002) return vec4(0.0);
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
  vec4 ci=skyCirrus(d);
  c=mix(c,ci.rgb,ci.a);
  vec4 cl=skyClouds(d);
  c=mix(c,cl.rgb,cl.a);
  // rain in the distance, rainbows in the rain, and low fog in front of it all
  float rv=rainVeil(d,4000.0);
  if(rv>0.0) c=mix(c,veilCol(),rv*0.85);
  if(uBow>0.0 && d.y>-0.02){
    float dk; vec3 rb=rainbow(d,dk);
    float L=dot(uSunCol,vec3(0.3,0.5,0.2));
    c=c*(1.0-0.12*dk*uBow)+rb*uBow*L*0.1*smoothstep(-0.02,0.04,d.y);
  }
  if(uFog2.x>0.0) c=mix(c,fogCol(d),heightFog(d,6000.0,uFog2.x,uFog2.y,uFog2.z));
  o=vec4(outHDR(c),1.0);
}`;


const VS_LEAF = `#version 300 es
${GLSL_COMMON}
uniform mat4 uVP; uniform sampler2D uHeight; uniform sampler2D uEmit; uniform int uEmitCount; uniform int uEmitBase; uniform float uWind; uniform float uSnowMode; uniform float uFoam; uniform float uRainMode;
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
  if(uSnowMode>0.5){
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
uniform vec3 uAmbSky; uniform float uSnowMode; uniform float uFoam; uniform float uRainMode;
in vec2 vUV; in vec3 vCol; in float vLight; in vec3 vWorld; out vec4 o;
void main(){
  vec2 p=vUV;
  if(uRainMode>0.5){
    vec3 lit=pow(vCol,vec3(2.2))*(uAmbSky*1.6+uSunCol*0.25+uZenith*0.4);
    o=vec4(outHDR(applyFog(lit,vWorld)),(1.0-abs(p.x))*(0.55-0.35*abs(p.y))*0.6);
    return;
  }
  if(uSnowMode>0.5||uFoam>0.5){
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


// Emberwood global atmosphere: a layered weather model for the whole planet, run on the GPU.
//
// The planet grid (or a finer one) is stacked in K layers of air from the ground to the top of the
// weather (about 12 km). Every column carries wind (u, v), potential temperature and water vapour
// in each layer, plus cloud water. Each step the GPU:
//   1. moves everything with the wind (semi-Lagrangian, in 3D), pushes the air down the pressure
//      slope and lets the planet's spin turn it (Coriolis), with friction near the ground. Pressure
//      is hydrostatic: a surface value plus the weight of the warm or cold air above, so warm columns
//      make low pressure at the ground and high pressure aloft (thermal wind, jet streams).
//      The sun warms the tropics and the ground more than the poles and the air aloft (radiative
//      relaxation toward a climate that follows latitude, season, land and sea, and the time of day
//      at each longitude); the sea and wet ground evaporate into the lowest layer.
//   2. condenses vapour into cloud where the air is saturated (releasing latent heat), runs a moist
//      convection scheme (a surface parcel buoyant through the column builds a thunderstorm: heats
//      the air it rises through, rains, leaves an anvil of cloud at its top and a cold downdraft at
//      its foot), turns thick cloud into rain that falls through the layers below and partly
//      evaporates there, and works out how fast the air rises or sinks from where it converges.
//   3. updates the surface: pressure from the column's net convergence, rain, soil moisture.
// Lows and highs, fronts, jet streams, trade winds, the tropical rain belt, monsoon-like sea breezes
// and tropical storms are not placed anywhere: they come out of these rules.
//
// Units: lengths in grid cells (layers in the vertical), time in game seconds, temperatures in °C,
// vapour and cloud in g/kg. Fields live in float textures laid out as an atlas: layer k occupies rows
// k*NY .. k*NY+NY-1. The x axis wraps (the planet's east-west seam); the poles are walls.
// The CPU reads back only small packed views (the window around the player, a coarse global map).
const ATMOS_K = 8;

function createAtmosphere(gl, opts = {}) {
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const NX = opts.nx || 512, NY = opts.ny || 256, K = ATMOS_K;
  const PWc = 512, PHc = 256, SC = NX / PWc;   // grid cells per planet cell
  const WIN = opts.win || 128;                  // the window around the player, in planet cells
  const CG = [256, 128];                        // the coarse global view
  const DT = 0.25;                              // one model step, game seconds

  // ---- GL helpers ----
  const VS = '#version 300 es\nvoid main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }';
  const prog = (fs, names) => {
    const p = gl.createProgram();
    for (const [t, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('atmos shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('atmos link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  };
  const tex = (w, h, data) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const fbo = (ts) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    ts.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(ts.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    return ok ? f : null;
  };

  // ---- shared GLSL ----
  const COMMON = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D uS1, uS2, uSurf, uGeo, uGeo2, uD;
const int NX=${NX}, NY=${NY}, K=${K};
const float DT=${DT.toFixed(3)};
// physics constants (model units: cells, game seconds, °C, g/kg)
const float BETA=${(opts.beta || 0.06).toFixed(4)};      // buoyancy per °C of potential temperature (pressure per layer)
const float SREF=5.0;       // reference stratification: potential temperature rise per layer
const float GEX=1.0, HEX=4.0; // surface pressure: gravity and depth of the barotropic mode
const float LC=2.5;         // latent heat: °C of warming per g/kg condensed
const float F0=${(opts.f0 || 0.34).toFixed(5)};  // Coriolis parameter at the pole (per second; the grid sets the size of weather systems)
uniform float uTod;         // time of day at the player, hours
uniform float uPlayerX;     // player's longitude as a grid x
uniform float uSeason;      // -1 winter .. 1 summer in the player's hemisphere
uniform float uPlayerN;     // 1 if the player is in the northern hemisphere, -1 south
uniform float uTempOff, uHumid, uStorm;
ivec2 at(int i,int j,int k){ i=((i%NX)+NX)%NX; j=clamp(j,0,NY-1); return ivec2(i,j+k*NY); }
vec4 S1(int i,int j,int k){ return texelFetch(uS1,at(i,j,k),0); }
vec4 S2(int i,int j,int k){ return texelFetch(uS2,at(i,j,k),0); }
vec4 DG(int i,int j,int k){ return texelFetch(uD,at(i,j,k),0); }
vec4 SF(int i,int j){ i=((i%NX)+NX)%NX; j=clamp(j,0,NY-1); return texelFetch(uSurf,ivec2(i,j),0); }
vec4 GEO(int i,int j){ i=((i%NX)+NX)%NX; j=clamp(j,0,NY-1); return texelFetch(uGeo,ivec2(i,j),0); }
vec4 GEO2(int i,int j){ i=((i%NX)+NX)%NX; j=clamp(j,0,NY-1); return texelFetch(uGeo2,ivec2(i,j),0); }
float latOf(int j){ return 90.0-(float(j)+0.5)/float(NY)*180.0; }
float corio(int j){ return F0*sin(radians(latOf(j))); }
// reference potential temperature of layer k (°C) and the height of its middle (km)
float thRef(int k){ return 15.0+SREF*(float(k)+0.5); }
float zKm(int k){ return (float(k)+0.5)*1.5; }
// air temperature from potential temperature anomaly (dry adiabatic lapse 9.8 °C/km)
float tAir(int k,float th){ return thRef(k)+th-9.8*zKm(k); }
// saturation mixing ratio (g/kg) at temperature T and the pressure of layer k
float qsat(float T,int k){ return 3.8*exp(17.27*T/(T+237.3))*exp(zKm(k)/8.0); }
// the season and the time of day at column (i,j): surface temperature over land and sea (°C)
// GEO: r ground height (blocks above sea), g sea (1) / land (0), b planet climate temperature (°C), a usual wetness 0..1
// GEO2: r sea-surface temperature (°C), g half the yearly temperature swing (°C), b roughness, a planet rain
float seasonSign(int j){ return uSeason*(latOf(j)>=0.0 ? 1.0 : -1.0)*uPlayerN; }
float surfT(int i,int j,float cloud){
  vec4 g=GEO(i,j), g2=GEO2(i,j);
  float s=seasonSign(j);
  if(g.g>0.5) return g2.r+0.45*g2.g*s+uTempOff;
  float lt=uTod+(float(i)-uPlayerX)/float(NX)*24.0;
  float day=cos(6.2831853*(lt-15.0)/24.0)*5.0*(1.0-0.6*cloud);
  return g.b+g2.g*s+day+uTempOff;
}
// sunshine on the ground at column (i,j): 0 at night .. 1 at noon
float sunOn(int i){ float lt=mod(uTod+(float(i)-uPlayerX)/float(NX)*24.0+48.0,24.0); return lt>6.0&&lt<18.0 ? sin(3.14159*(lt-6.0)/12.0) : 0.0; }
// radiative-equilibrium potential temperature anomaly of layer k at row j: the sun heats the
// tropics more than the poles and the ground more than the air aloft; above the tropopause the
// air is warm (stratosphere), which caps convection
float thEq(int j,int k){
  float s=abs(sin(radians(latOf(j))));
  float sh=seasonSign(j)*6.0*s;
  float ts=28.0-40.0*pow(s,2.5)+sh+uTempOff;
  float a=(ts-17.5)*(1.0-0.35*float(k)/float(K));
  float trop=float(K)-2.0-1.2*s;
  a+=max(0.0,float(k)-trop)*7.0;
  return a;
}
`;
  const FRAG_IJK = `
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
void ijk(out int i,out int j,out int k){ ivec2 f=ivec2(gl_FragCoord.xy); i=f.x; k=f.y/NY; j=f.y-k*NY; }
`;
  // trilinear sample of an atlas texture at continuous grid position (x, y in cells, z in layers)
  const SAMPLE = `
vec4 samp(highp sampler2D t,float x,float y,float z){
  y=clamp(y,0.0,float(NY-1)); z=clamp(z,0.0,float(K-1));
  int i0=int(floor(x)), j0=int(floor(y)), k0=int(floor(z));
  float fx=x-floor(x), fy=y-floor(y), fz=z-floor(z);
  int j1=min(j0+1,NY-1), k1=min(k0+1,K-1);
  vec4 a=mix(mix(texelFetch(t,at(i0,j0,k0),0),texelFetch(t,at(i0+1,j0,k0),0),fx),mix(texelFetch(t,at(i0,j1,k0),0),texelFetch(t,at(i0+1,j1,k0),0),fx),fy);
  vec4 b=mix(mix(texelFetch(t,at(i0,j0,k1),0),texelFetch(t,at(i0+1,j0,k1),0),fx),mix(texelFetch(t,at(i0,j1,k1),0),texelFetch(t,at(i0+1,j1,k1),0),fx),fy);
  return mix(a,b,fz);
}
// pressure (kinematic) in layer k of column (i,j): the surface value plus the weight of the
// warm or cold air below this layer
float pres(int i,int j,int k){
  float s=0.0;
  for(int m=0;m<K;m++){ if(m>=k) break; s+=S1(i,j,m).z; }
  s+=0.5*S1(i,j,k).z;
  return BETA*s;
}
`;

  // Pass 1: dynamics. Advect (u, v, theta, q) and cloud, add pressure force, Coriolis, friction,
  // radiation, surface heat and evaporation, a little diffusion.
  const FS_DYN = COMMON + FRAG_IJK + SAMPLE + `
uniform float uRad, uDiff, uDivD;
void main(){
  int i,j,k; ijk(i,j,k);
  vec4 s=S1(i,j,k), c2=S2(i,j,k);
  // vertical velocity at the middle of the layer (S2.b holds w at the top of each layer, in layers/s)
  float wb=k>0 ? S2(i,j,k-1).b : 0.0, wt=c2.b, w=0.5*(wb+wt);
  float x=float(i)-s.x*DT, y=float(j)-s.y*DT, z=float(k)-w*DT;
  vec4 a=samp(uS1,x,y,z);
  vec4 a2=samp(uS2,x,y,z);
  // a little diffusion (keeps the grid-scale noise down)
  vec4 nb=0.25*(S1(i+1,j,k)+S1(i-1,j,k)+S1(i,j+1,k)+S1(i,j-1,k));
  vec4 nb2=0.25*(S2(i+1,j,k)+S2(i-1,j,k)+S2(i,j+1,k)+S2(i,j-1,k));
  float dif=uDiff*(1.0+4.0*smoothstep(75.0,88.0,abs(latOf(j))));
  a+=(nb-s)*dif; a2.r+=(nb2.r-c2.r)*dif;
  // pressure force
  // the warm/cold-air part comes from the diagnostics; the surface part from the current surface
  // pressure, so the surface and the wind step forward-backward (stable for the fast waves)
  float px=(DG(i+1,j,k).r-DG(i-1,j,k).r+GEX*(SF(i+1,j).x-SF(i-1,j).x))*0.5, py=(DG(i,j+1,k).r-DG(i,j-1,k).r+GEX*(SF(i,j+1).x-SF(i,j-1).x))*0.5;
  vec2 v=a.xy-DT*vec2(px,py);
  // divergence damping: air piling up or spreading out is pushed back a little, which calms the
  // short gravity waves (the real atmosphere's are far smaller than this grid can show) and
  // leaves the turning, balanced winds alone
  v+=DT*uDivD*0.5*vec2(DG(i+1,j,k).g-DG(i-1,j,k).g,DG(i,j+1,k).g-DG(i,j-1,k).g);
  // the planet's spin turns moving air (to the right in the north, left in the south)
  float an=corio(j)*DT, ca=cos(an), sa=sin(an);
  v=vec2(v.x*ca-v.y*sa, v.x*sa+v.y*ca);
  vec4 g=GEO(i,j), g2=GEO2(i,j);
  // friction: the ground slows the lowest layer (more over rough, high land), a sponge at the top
  float pol=smoothstep(78.0,88.0,abs(latOf(j)));
  float fr=pol*0.3+(k==0 ? (g.g>0.5 ? 0.03 : 0.06+0.0012*g.r+0.05*g2.b) : k==1 ? 0.012 : k==K-1 ? 0.01 : 0.0015);
  v/=1.0+DT*fr;
  if(j==0||j==NY-1) v.y=0.0;
  float th=a.z, q=max(a.w,0.0);
  // radiation
  th+=(thEq(j,k)-th)*DT/uRad;
  if(k==0){
    // the ground: sensible heat and evaporation into the lowest layer
    float col=0.0; for(int m=0;m<K;m++) col=max(col,S2(i,j,m).r);
    float cl=clamp(col*2.0,0.0,1.0);
    float Ts=surfT(i,j,cl);
    float th0=Ts-17.5;
    float wind=length(v);
    th+=(th0-th)*DT*(g.g>0.5 ? 0.025 : 0.04)*(0.6+0.8*min(wind,1.5));
    float wet=g.g>0.5 ? 1.0 : clamp(SF(i,j).z,0.02,1.0);
    // the sea and wet ground moisten the lowest air toward 80% of what air at the ground's
    // temperature holds, never past 90% of what this layer's own air holds
    float qs=min(qsat(Ts,0)*0.8,qsat(tAir(0,th),0)*0.9);
    float E=(g.g>0.5 ? 0.012 : 0.008*wet)*(0.5+min(wind,2.0))*uHumid;
    q+=max(0.0,qs*min(1.0,wet*1.2)-q)*E*DT;
  }
  o0=vec4(v,th,q);
  o1=vec4(max(a2.r,0.0),0.0,c2.b,a2.a*0.98);
}`;

  // Diagnostics after the dynamics: the pressure in each layer and how fast the air there spreads
  // out (divergence), used by the moist pass, the surface pass and the next step's dynamics.
  const FS_DIAG = COMMON + SAMPLE + `
out vec4 o0;
void main(){
  ivec2 f=ivec2(gl_FragCoord.xy); int i=f.x, k=f.y/NY, j=f.y-k*NY;
  float d=(S1(i+1,j,k).x-S1(i-1,j,k).x+S1(i,j+1,k).y-S1(i,j-1,k).y)*0.5;
  o0=vec4(pres(i,j,k),d,0.0,0.0);
}`;

  // Pass 2: moist physics on whole columns: condensation, convection, rain and its evaporation,
  // dry convective mixing. It runs once per column (on the surface grid) and writes the column's
  // new temperature, vapour and cloud packed four layers to a texel; a scatter pass then puts them
  // back into the layers and works out the vertical velocity. Done in two halves because WebGL 2
  // only promises four render targets.
  const FS_COL = COMMON + `
uniform float uConvT; uniform int uHalf;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2; layout(location=3) out vec4 o3;
float gamOf(float T,float qs){ return LC*qs*17.27*237.3/((T+237.3)*(T+237.3)); }
void main(){
  ivec2 f=ivec2(gl_FragCoord.xy); int i=f.x, j=f.y;
  float th[8], q[8], c[8];
  for(int m=0;m<K;m++){ vec4 s=S1(i,j,m); th[m]=s.z; q[m]=max(s.w,0.0); c[m]=S2(i,j,m).r; }
  // large-scale condensation where the air is saturated, cloud evaporating where it is not
  for(int m=0;m<K;m++){
    float T=tAir(m,th[m]), qs=qsat(T,m);
    float d=(q[m]-qs)/(1.0+gamOf(T,qs));
    if(d>0.0){ q[m]-=d; c[m]+=d; th[m]+=LC*d; }
    else { float e=min(c[m],-d*0.5); c[m]-=e; q[m]+=e; th[m]-=LC*e; }
  }
  // moist convection: a parcel from the lowest layer rises as long as it is warmer than the
  // saturated air around it (its equivalent potential temperature beats theirs)
  float the=th[0]+LC*q[0]+${(opts.cbonus ?? 0.3).toFixed(2)};
  int top=0;
  for(int m=1;m<K;m++){ float thes=th[m]+LC*qsat(tAir(m,th[m]),m); if(the>thes) top=m; else break; }
  float conv=0.0, rainC=0.0;
  if(top>=2){
    // it heats each layer it rises through toward its own moist temperature...
    float dh[8], heat=0.0;
    for(int m=0;m<K;m++){
      dh[m]=0.0;
      if(m<1||m>top) continue;
      float T=tAir(m,th[m]), qs=qsat(T,m);
      dh[m]=max(0.0,the-th[m]-LC*qs)/(1.0+gamOf(T,qs))*DT/uConvT; heat+=dh[m];
    }
    // ...paid for by vapour from the lowest layer; what can't be paid for is not done
    float need=heat/LC, have=max(0.0,q[0]-0.5*qsat(tAir(0,th[0]),0));
    float fpay=need>0.0 ? min(1.0,have/need) : 0.0;
    for(int m=1;m<K;m++) th[m]+=dh[m]*fpay;
    heat*=fpay;
    q[0]-=heat/LC;
    // an anvil of cloud spreads at the top, the rest rains out
    for(int m=1;m<K;m++){ if(m==top) c[m]+=heat/LC*0.25; if(m==top-1) c[m]+=heat/LC*0.1; }
    rainC=heat/LC*0.65;
    // the rain-cooled downdraft: a pool of cold air at the foot of the storm
    th[0]-=heat*0.15;
    conv=heat/DT;
  }
  // thick cloud turns to rain (ice more slowly), which falls through the layers below and partly
  // evaporates in dry air under the cloud, cooling it
  float F=0.0;
  for(int m=K-1;m>=0;m--){
    float T=tAir(m,th[m]);
    // ice crystals grow and fall out of thin cloud too (so high cloud thins out instead of piling up)
    float c0=T<-15.0 ? 0.03 : 0.3, ka=T<-15.0 ? 0.02 : 0.05;
    float r=max(0.0,c[m]-c0)*ka*DT;
    c[m]-=r; F+=r;
    if(m==top) F+=rainC;
    float rh=q[m]/qsat(T,m);
    float e=F*clamp((0.95-rh)*0.5,0.0,0.5);
    F-=e; q[m]+=e; th[m]-=LC*e;
  }
  // the stratosphere is dry: what little vapour and cloud reaches the top layer is slowly lost
  q[K-1]*=1.0-DT*0.01; c[K-1]*=1.0-DT*0.02;
  // the stratosphere is dry: what little vapour and cloud reaches the top layer is slowly lost
  q[K-1]*=1.0-DT*0.01; c[K-1]*=1.0-DT*0.02;
  // dry convective mixing: a layer warmer (in potential temperature) than the one above it overturns
  for(int it=0;it<2;it++) for(int m=0;m<K-1;m++){
    float d=th[m]-th[m+1]-SREF;
    if(d>0.0){ th[m]-=d*0.5; th[m+1]+=d*0.5; float dq=(q[m]-q[m+1])*0.5; q[m]-=dq; q[m+1]+=dq; }
  }
  if(uHalf==0){ o0=vec4(th[0],th[1],th[2],th[3]); o1=vec4(th[4],th[5],th[6],th[7]); o2=vec4(q[0],q[1],q[2],q[3]); o3=vec4(q[4],q[5],q[6],q[7]); }
  else { o0=vec4(c[0],c[1],c[2],c[3]); o1=vec4(c[4],c[5],c[6],c[7]); o2=vec4(F/DT,conv,float(top),0.0); o3=vec4(0.0); }
}`;
  const FS_SCAT = COMMON + FRAG_IJK + `
uniform highp sampler2D uC0, uC1, uC2, uC3, uC4, uC5, uC6;
float pick(vec4 a,vec4 b,int k){ vec4 v=k<4 ? a : b; int m=k<4 ? k : k-4; return m==0 ? v.x : m==1 ? v.y : m==2 ? v.z : v.w; }
void main(){
  int i,j,k; ijk(i,j,k);
  ivec2 c=ivec2(i,j);
  float th=pick(texelFetch(uC0,c,0),texelFetch(uC1,c,0),k), q=pick(texelFetch(uC2,c,0),texelFetch(uC3,c,0),k);
  float cl=pick(texelFetch(uC4,c,0),texelFetch(uC5,c,0),k);
  vec4 x=texelFetch(uC6,c,0);
  // vertical velocity at the top of this layer: what the layers up to here converge (the column's
  // mean convergence goes into the surface pressure instead), plus air forced up slopes
  float dsum=0.0, dmean=0.0;
  for(int m=0;m<K;m++){ float d=(S1(i+1,j,m).x-S1(i-1,j,m).x+S1(i,j+1,m).y-S1(i,j-1,m).y)*0.5; dmean+=d; if(m<=k) dsum+=d; }
  dmean/=float(K);
  vec2 u0=S1(i,j,0).xy;
  float hx=(GEO(i+1,j).r-GEO(i-1,j).r)*0.5, hy=(GEO(i,j+1).r-GEO(i,j-1).r)*0.5;
  float ws=(u0.x*hx+u0.y*hy)*0.004*${SC.toFixed(1)};
  float wtop=k==K-1 ? 0.0 : ws*(1.0-float(k+1)/float(K))-(dsum-dmean*float(k+1));
  // and at its bottom (the top of the layer below)
  float wbot=0.0;
  { float db=0.0; for(int m=0;m<K;m++){ if(m>=k) break; db+=(S1(i+1,j,m).x-S1(i-1,j,m).x+S1(i,j+1,m).y-S1(i,j-1,m).y)*0.5; }
    wbot=k==0 ? 0.0 : ws*(1.0-float(k)/float(K))-(db-dmean*float(k)); }
  // rising air cools and sinking air warms against the reference stratification (done here, with
  // the vertical velocity of the winds just updated, so pressure and temperature step
  // forward-backward and the fast gravity waves stay stable)
  th-=clamp(0.5*(wtop+wbot),-2.0,2.0)*SREF*DT;
  o0=vec4(S1(i,j,k).xy,th,max(q,0.0));
  o1=vec4(max(cl,0.0),k==0 ? x.x : (k==1 ? x.y : 0.0),clamp(wtop,-2.0,2.0),float(k)==x.z ? 1.0 : 0.0);
}`;

  // Pass 3: surface. Pressure from the column's net convergence, rain and soil moisture.
  const FS_SURF = COMMON + `
out vec4 o0;
float divAt(int i,int j,int m){ return DG(i,j,m).g; }
void main(){
  ivec2 f=ivec2(gl_FragCoord.xy); int i=f.x, j=f.y;
  vec4 s=SF(i,j);
  float dm=0.0; for(int m=0;m<K;m++) dm+=divAt(i,j,m); dm/=float(K);
  float eta=s.x-DT*HEX*dm;
  eta+=(0.25*(SF(i+1,j).x+SF(i-1,j).x+SF(i,j+1).x+SF(i,j-1).x)-s.x)*0.06;
  eta*=0.9995;
  float pr=S2(i,j,0).g;
  vec4 g=GEO(i,j);
  // soil: soaked by rain, dried by sun, slowly back toward the climate's usual wetness
  float soil=s.z;
  if(g.g<0.5){ soil+=pr*DT*0.4-soil*DT*0.0015*(0.2+sunOn(i)); soil+=(g.a-soil)*DT/1500.0; soil=clamp(soil,0.0,1.0); }
  else soil=1.0;
  o0=vec4(eta,s.y+(pr-s.y)*min(1.0,DT*0.5),soil,s.w+(S2(i,j,1).g-s.w)*min(1.0,DT*0.3));
}`;

  // Packing: the window around the player at planet-cell resolution, and a coarse global view.
  //  A: wind at cloud level (u, v, planet cells per s), large-scale lift, air-mass temperature anomaly
  //  B: relative humidity near the ground, low and middle cloud, high cloud, convection
  //  C: rain, surface pressure (hPa departure), surface air temperature, soil moisture
  const FS_PACK = COMMON + `
uniform vec2 uO; uniform vec2 uStepS; // origin (planet cells) and planet cells per output texel
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
void main(){
  vec2 pc=uO+(floor(gl_FragCoord.xy)+0.5)*uStepS;   // planet-cell coordinates of the texel centre
  int i=int(floor(pc.x*${SC.toFixed(1)})), j=int(floor(pc.y*${SC.toFixed(1)}));
  vec4 a0=S1(i,j,0), a1=S1(i,j,1), a2=S1(i,j,2);
  vec2 wc=(a0.xy*0.35+a1.xy*0.45+a2.xy*0.2)/${SC.toFixed(1)};
  float w=(S2(i,j,1).b+S2(i,j,2).b)*0.5;
  float col=0.0, hi=0.0;
  for(int m=0;m<K;m++){ float cm=S2(i,j,m).r; if(m<K-3) col=max(col,cm); else hi=max(hi,cm); }
  vec4 sf=SF(i,j);
  float cl=clamp(col*2.0,0.0,1.0);
  float Ts=surfT(i,j,cl);
  float anom=(a0.z+17.5)-Ts;
  float rh=a0.w/qsat(tAir(0,a0.z),0);
  float hpa=sf.x*20.0;
  o0=vec4(wc,w,anom);
  o1=vec4(rh,col,hi,sf.w);
  o2=vec4(sf.y,hpa,a0.z+17.5,sf.z);
}`;

  // The cloud volume the game draws: cloud water (g/kg) of every column, layers 0-3 and 4-7, and the
  // rain reaching the ground (g/kg per s), at the model's own resolution over the whole planet, in
  // half floats so the renderer can filter it. The sky and the cloud shadows read it directly, so
  // the clouds on screen are the model's clouds and nothing else.
  const FS_CLOUD = COMMON + `
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
void main(){
  ivec2 f=ivec2(gl_FragCoord.xy); int i=f.x, j=f.y;
  o0=vec4(S2(i,j,0).r,S2(i,j,1).r,S2(i,j,2).r,S2(i,j,3).r);
  o1=vec4(S2(i,j,4).r,S2(i,j,5).r,S2(i,j,6).r,S2(i,j,7).r);
  o2=vec4(SF(i,j).y,0.0,0.0,1.0);
}`;

  const P = {
    dyn: prog(FS_DYN), diag: prog(FS_DIAG), col: prog(FS_COL), scat: prog(FS_SCAT), surf: prog(FS_SURF), pack: prog(FS_PACK), cloud: prog(FS_CLOUD),
  };

  // ---- state ----
  const AW = NX, AH = NY * K;
  const S1 = [tex(AW, AH), tex(AW, AH)], S2 = [tex(AW, AH), tex(AW, AH)], SURF = [tex(NX, NY), tex(NX, NY)];
  const DGT = tex(AW, AH), FD = fbo([DGT]);
  const CT = [0, 1, 2, 3, 4, 5, 6].map(() => tex(NX, NY)), FC = [fbo(CT.slice(0, 4)), fbo(CT.slice(4, 7))];
  const F12 = [fbo([S1[0], S2[0]]), fbo([S1[1], S2[1]])], FS = [fbo([SURF[0]]), fbo([SURF[1]])];
  if (!F12[0] || !FS[0] || !FD || !FC[0] || !FC[1]) return null;
  let cur = 0, scur = 0;
  let geo = null, geo2 = null;
  const vao = gl.createVertexArray();

  // packed views and their asynchronous readback
  const mkPack = (w, h) => {
    const ts = [tex(w, h), tex(w, h), tex(w, h)];
    const f = fbo(ts);
    return { w, h, ts, f, data: [new Float32Array(w * h * 4), new Float32Array(w * h * 4), new Float32Array(w * h * 4)], pbo: [0, 1, 2].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 16, gl.STREAM_READ); return b; }), fence: null, o: [0, 0], ready: false, pending: null };
  };
  const win = mkPack(WIN, WIN), glob = mkPack(CG[0], CG[1]);
  const cloudTex = [0, 1, 2].map(() => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, NX, NY, 0, gl.RGBA, gl.HALF_FLOAT, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  });
  gl.bindTexture(gl.TEXTURE_2D, null);
  for (const t of cloudTex) { gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); }
  gl.bindTexture(gl.TEXTURE_2D, null);
  const FCL = fbo(cloudTex);
  if (!FCL) return null;
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

  const api = {
    NX, NY, K, ok: true,
    tod: 12, playerX: 0, playerZ: 0, season: 0, temp: 0, humid: 1, stormMul: 1,
    rad: 420, conv: 40, diff: 0.04, divD: 1.2,
    steps: 0, passMask: 15,
    win, glob, cloudTex,
  };

  function bindCommon(p) {
    gl.useProgram(p.p);
    const T = [['uS1', S1[cur]], ['uS2', S2[cur]], ['uSurf', SURF[scur]], ['uGeo', geo], ['uGeo2', geo2], ['uD', DGT], ...CT.map((t, n) => ['uC' + n, t])];
    T.forEach(([n, t], idx) => { if (p.u[n] !== undefined) { gl.activeTexture(gl.TEXTURE0 + 12 + idx); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(p.u[n], 12 + idx); } });
    const f = (n, v) => { if (p.u[n] !== undefined) gl.uniform1f(p.u[n], v); };
    f('uTod', api.tod); f('uPlayerX', api.playerX / 16 * SC); f('uPlayerN', api.playerZ / 16 < PHc / 2 ? 1 : -1);
    f('uSeason', api.season); f('uTempOff', api.temp); f('uHumid', api.humid); f('uStorm', api.stormMul);
    f('uRad', api.rad); f('uDivD', api.divD); f('uConvT', api.conv); f('uDiff', api.diff);
  }
  // save and restore the GL state this module touches, so the renderer is never disturbed
  function withGL(fn) {
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), vp = gl.getParameter(gl.VIEWPORT), at = gl.getParameter(gl.ACTIVE_TEXTURE);
    const depth = gl.isEnabled(gl.DEPTH_TEST), blend = gl.isEnabled(gl.BLEND), cull = gl.isEnabled(gl.CULL_FACE), sc = gl.isEnabled(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(vao);
    fn();
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb); gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    for (let u = 12; u < 26; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(at);
    if (depth) gl.enable(gl.DEPTH_TEST); if (blend) gl.enable(gl.BLEND); if (cull) gl.enable(gl.CULL_FACE); if (sc) gl.enable(gl.SCISSOR_TEST);
  }
  function stepGL(n) {
    for (let s = 0; s < n; s++) {
      // dynamics and moist physics ping-pong through the atlas, then the surface
      gl.bindFramebuffer(gl.FRAMEBUFFER, F12[cur ^ 1]); gl.viewport(0, 0, AW, AH);
      const m = api.passMask;
      if (m & 1) { bindCommon(P.dyn); gl.drawArrays(gl.TRIANGLES, 0, 3); cur ^= 1; }
      if (m & 4) {
        gl.viewport(0, 0, NX, NY);
        for (let h = 0; h < 2; h++) { gl.bindFramebuffer(gl.FRAMEBUFFER, FC[h]); bindCommon(P.col); gl.uniform1i(P.col.u.uHalf, h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, F12[cur ^ 1]); gl.viewport(0, 0, AW, AH);
        bindCommon(P.scat); gl.drawArrays(gl.TRIANGLES, 0, 3); cur ^= 1;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, FD); gl.viewport(0, 0, AW, AH);
      if (m & 2) { bindCommon(P.diag); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, FS[scur ^ 1]); gl.viewport(0, 0, NX, NY);
      if (m & 8) { bindCommon(P.surf); gl.drawArrays(gl.TRIANGLES, 0, 3); scur ^= 1; }
      api.steps++;
    }
    if (n > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, FCL); gl.viewport(0, 0, NX, NY); bindCommon(P.cloud); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0 + 12);
      for (const t of cloudTex) { gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); }
    }
  }
  function pack(pk, ox, oz, sx, sz) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, pk.f); gl.viewport(0, 0, pk.w, pk.h);
    bindCommon(P.pack);
    gl.uniform2f(P.pack.u.uO, ox, oz); gl.uniform2f(P.pack.u.uStepS, sx, sz);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let a = 0; a < 3; a++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + a);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pk.pbo[a]);
      gl.readPixels(0, 0, pk.w, pk.h, gl.RGBA, gl.FLOAT, 0);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    if (pk.fence) gl.deleteSync(pk.fence);
    pk.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    pk.pending = [ox, oz, sx, sz];
    gl.flush();
  }
  // copy a finished readback into its arrays (true when new data arrived)
  function collect(pk, wait) {
    if (!pk.fence) return false;
    const st = wait ? gl.clientWaitSync(pk.fence, gl.SYNC_FLUSH_COMMANDS_BIT, 0) : gl.getSyncParameter(pk.fence, gl.SYNC_STATUS);
    if (!wait && st !== gl.SIGNALED) return false;
    if (wait && st === gl.TIMEOUT_EXPIRED) { gl.finish(); }
    for (let a = 0; a < 3; a++) { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pk.pbo[a]); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pk.data[a]); }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(pk.fence); pk.fence = null;
    pk.o = pk.pending; pk.ready = true;
    return true;
  }

  // ---- set up from the planet ----
  api.reset = function (pl) {
    const g = new Float32Array(NX * NY * 4), g2 = new Float32Array(NX * NY * 4);
    const s1 = new Float32Array(AW * AH * 4), s2 = new Float32Array(AW * AH * 4), sf = new Float32Array(NX * NY * 4);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const pi = Math.floor(i / SC), pj = Math.floor(j / SC), k = pj * PWc + pi, n = (j * NX + i) * 4;
      const sea = pl.L.elev[k] <= 0 || pl.ys[k] < 30;
      const h = Math.max(0, pl.ys[k] - 30);
      g[n] = h; g[n + 1] = sea ? 1 : 0; g[n + 2] = pl.tmp[k]; g[n + 3] = pl.L.moist ? Math.min(1, pl.L.moist[k]) : Math.min(1, pl.L.rain[k] / 2);
      const sst = pl.L.sst ? pl.L.sst[k] : pl.tmp[k];
      g2[n] = sea ? sst : 0; g2[n + 1] = pl.L.tAmp ? pl.L.tAmp[k] : 8 * Math.min(1, Math.abs(90 - (pj + 0.5) / PHc * 180) / 50);
      // roughness: ground that rises and falls a lot around here
      let rgh = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const kk = Math.max(0, Math.min(PHc - 1, pj + dj)) * PWc + ((pi + di + PWc) % PWc); rgh += Math.abs(pl.ys[kk] - pl.ys[k]); }
      g2[n + 2] = Math.min(1, rgh / 60); g2[n + 3] = pl.L.rain[k];
      sf[n + 2] = g[n + 3];
      // start from the climate at rest with a little noise, so storms can grow
      const lat = 90 - (j + 0.5) / NY * 180, s = Math.abs(Math.sin(lat * Math.PI / 180));
      for (let kk = 0; kk < K; kk++) {
        const m = ((j + kk * NY) * AW + i) * 4;
        const ts = 28 - 40 * Math.pow(s, 2.5);
        let a = (ts - 17.5) * (1 - 0.35 * kk / K);
        const trop = K - 2 - 1.2 * s; a += Math.max(0, kk - trop) * 7;
        s1[m] = 0; s1[m + 1] = 0; s1[m + 2] = a + (rnd() - 0.5) * 0.6;
        const T = 15 + 5 * (kk + 0.5) + a - 9.8 * (kk + 0.5) * 1.5;
        s1[m + 3] = (opts.q0 ?? 0.6) * 3.8 * Math.exp(17.27 * T / (T + 237.3)) * Math.exp((kk + 0.5) * 1.5 / 8);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    geo = geo || tex(NX, NY); geo2 = geo2 || tex(NX, NY);
    gl.bindTexture(gl.TEXTURE_2D, geo); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, g);
    gl.bindTexture(gl.TEXTURE_2D, geo2); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, g2);
    for (const t of S1) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AW, AH, gl.RGBA, gl.FLOAT, s1); }
    for (const t of S2) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AW, AH, gl.RGBA, gl.FLOAT, s2); }
    for (const t of SURF) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, sf); }
    gl.bindTexture(gl.TEXTURE_2D, null);
    cur = 0; scur = 0; api.steps = 0; win.ready = false; glob.ready = false;
  };
  // run n model steps now (spin-up, or catching up)
  api.run = function (n) { withGL(() => stepGL(n)); };
  // request packed views: the window around (ox, oz) planet cells, and the coarse globe
  api.request = function (ox, oz, wantGlobal) {
    withGL(() => {
      if (!win.fence) pack(win, ox, oz, 1, 1);
      if (wantGlobal && !glob.fence) pack(glob, 0, 0, PWc / CG[0], PHc / CG[1]);
    });
  };
  api.collect = function (wait) { const a = collect(win, wait), b = collect(glob, wait); if (b) findLows(); return a || b; };
  // The lows: places on the coarse globe where the surface pressure is lowest around and well
  // below its surroundings. These are the storms and depressions the sim grew; the game uses them
  // for the map, for swell and for the storm list. Positions in planet cells, depth in hPa.
  api.lows = [];
  function findLows() {
    const W = CG[0], H = CG[1], d = glob.data[2], P = (i, j) => d[(Math.min(H - 1, Math.max(0, j)) * W + ((i % W) + W) % W) * 4 + 1];
    const out = [], sx = PWc / W, sz = PHc / H;
    for (let j = 3; j < H - 3; j++) for (let i = 0; i < W; i++) {
      const p = P(i, j);
      let min = true;
      for (let b = -3; b <= 3 && min; b++) for (let a = -3; a <= 3; a++) if ((a || b) && P(i + a, j + b) < p) { min = false; break; }
      if (!min) continue;
      // depth against a ring around it, and the radius where the low is half as deep
      let ring = 0, nr = 0;
      for (let t = 0; t < 16; t++) { const an = t / 16 * 6.2832; ring += P(Math.round(i + Math.cos(an) * 7), Math.round(j + Math.sin(an) * 7)); nr++; }
      const depth = ring / nr - p;
      if (depth < 3) continue;
      let r = 1;
      for (; r < 12; r++) { let s = 0; for (let t = 0; t < 8; t++) { const an = t / 8 * 6.2832; s += P(Math.round(i + Math.cos(an) * r), Math.round(j + Math.sin(an) * r)); } if (s / 8 - p > depth * 0.5) break; }
      const lat = 90 - (j + 0.5) / H * 180;
      out.push({ x: (i + 0.5) * sx, z: (j + 0.5) * sz, r: Math.max(3, r * sx * 1.2), depth, hpa: 1013 + p, tropical: Math.abs(lat) < 25 });
    }
    out.sort((a, b) => b.depth - a.depth);
    api.lows = out.slice(0, 60);
  }
  // sample a packed view at planet-cell coordinates (bilinear); f = 0, 1, 2 (A, B, C), c = channel
  api.sampleWin = function (f, c, x, z) {
    if (!win.ready) return 0;
    let fx = x - win.o[0] - 0.5, fz = z - win.o[1] - 0.5;
    // outside the window: the coarse globe (same fields), or the window's nearest edge
    if (fx < 0 || fz < 0 || fx > win.w - 1 || fz > win.h - 1) {
      if (glob.ready && (fx < -2 || fz < -2 || fx > win.w + 1 || fz > win.h + 1)) return api.sampleGlob(f, c, x, z);
    }
    return bil(win, f, c, fx, fz, false);
  };
  api.sampleGlob = function (f, c, x, z) {
    if (!glob.ready) return 0;
    const fx = x / (PWc / CG[0]) - 0.5, fz = z / (PHc / CG[1]) - 0.5;
    return bil(glob, f, c, fx, fz, true);
  };
  function bil(pk, f, c, fx, fz, wrap) {
    const W = pk.w, H = pk.h, d = pk.data[f];
    if (!wrap && (fx < 0 || fz < 0 || fx > W - 1 || fz > H - 1)) { fx = Math.max(0, Math.min(W - 1, fx)); fz = Math.max(0, Math.min(H - 1, fz)); }
    fz = Math.max(0, Math.min(H - 1.0001, fz));
    let i0 = Math.floor(fx); const j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
    const ix = i => wrap ? ((i % W) + W) % W : Math.max(0, Math.min(W - 1, i));
    const v = (i, j) => d[(j * W + ix(i)) * 4 + c];
    return (v(i0, j0) * (1 - tx) + v(i0 + 1, j0) * tx) * (1 - tz) + (v(i0, j0 + 1) * (1 - tx) + v(i0 + 1, j0 + 1) * tx) * tz;
  }
  // for tests: read a whole layer of a state texture (u, v, theta, q or cloud)
  api.readLayer = function (which, k) {
    const out = new Float32Array(NX * NY * 4);
    withGL(() => {
      const t = which === 's2' ? S2[cur] : which === 'surf' ? SURF[scur] : S1[cur];
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.readPixels(0, which === 'surf' ? 0 : k * NY, NX, NY, gl.RGBA, gl.FLOAT, out);
      gl.deleteFramebuffer(f);
    });
    return out;
  };
  return api;
}

# Cloud Lab findings (2026-10-15)

Lab page: https://claude.ai/artifact/EyKAGFPaf7CdkdmBy7KXzq · source: `cloud-lab/index.html` (single file, raw WebGL2, no libraries; `?scale=0.3&lapse=0` query sets params for headless tests).

## Approach chosen
Nubis (Schneider, Horizon Zero Dawn 2015/2017/2022) shape model + Frostbite (Hillaire 2016) lighting:

- **Weather map** (1024², 160 km, RGBA8): R coverage, G cloud type 0..1 (St, Sc, Cu, TCu, Cb), B rain, A fine field (only for the "old" comparison mode). Drawn in *air coordinates*, so it drifts with the wind and only re-renders when a slider moves or the camera drifts 30 km.
- **Shape**: 128³ RGBA8 Perlin-Worley (R) + Worley fbm (GBA), baked on the GPU into 3D texture layers. `base = remap(R, fbm-1, 1, 0, 1) * typeProfile(h)`, then `c = remap(base, 1-cov, 1, 0, 1) * cov`. Detail: 64³ Worley erodes edges (`mix(df, 1-df, h*3)`: wispy at base, billowy above).
- **Type profiles** (fraction of a 1.5–9.5 km layer): St (0,.015,.04,.075), Cu (0,.035,.11,.21), TCu (0,.05,.3,.5), Cb (0,.05,.82,1). Anvil = coverage boost high up, only where cov>0.35 and type>0.8 (otherwise anvils merge into a deck).
- **Light**: 6 growing sun steps (35 m ×1.65) + one far sample; 4 multi-scatter octaves (a×0.4, b×ms≈0.55, c×0.55) on a 2-lobe HG (0.8 / -0.3); view-dependent powder; ambient = sky LUT top/bottom by height in the type column; energy-conserving integration `(S - S·T)/σ`. Extinction 0.035/m default.
- **Sky**: single-scattering Rayleigh/Mie/ozone LUT (192×96 RGBA16F), sun colour computed on the CPU, separate sun colour at 2.5 km for clouds (keeps dusk clouds pink instead of grey).
- **Curved planet**: cloud shells are spheres; intersections use `c=(a-h)(a+h+2R)` and a stable quadratic so float32 survives R=6360 km.

## Why the game's sim-driven clouds were blobby
The sim's cells (16 blocks, 128 grid) drew the outlines. Any field that draws outlines gives smooth rounded masses that merge as cover rises (lab "Weather draws the shapes" mode). At low cover it actually gives tidy cartoon puffs, so the difference shows most at cover > 0.45.

## What to take back into the game
1. Feed the sim into a weather map (cover, type, rain) and let a 3D Perlin-Worley texture make the shapes via the coverage remap. v62 is halfway there (sim only sets amount); missing are the type profiles and the 3D remap.
2. Map the sim's `cvt`/`tops` to a type 0..1 and use the height profiles instead of one fixed CHT.
3. Black strips: keep extinction around 0.02–0.05, always include the octave multi-scatter, never let ambient under the base drop to zero, cloud sunlight from a higher altitude than the camera.
4. Scale: the game's layer is 420–800 blocks; the lab uses real metres (1.5–9.5 km, base noise tile 11 km). Scale tiles with the layer if porting.

## Not done
Motion/jitter tests (skipped as asked). Step offsets are deterministic (no dither, no TAA), so the anti-jitter rules from the game still hold. Headless swiftshader renders at 0.3–0.55 scale only.

## Ported into the game (v67, 2026-10-15)
- Noise fix found while porting: the Perlin-Worley used `1-|perlin|`, which saturated the base noise (~0.94 everywhere), so the clouds came from the weather fbm instead. It now uses `|perlin|`, and the remapped base (5–95% = 0.63–0.81) is stretched with `(b-0.6)/0.23` so that coverage is roughly the share of sky that is cloud. Fixed in the lab too (version 2).
- Game: `cDen`, `cloudType`, `cProfile` and `cloudShade` live in GLSL_COMMON. The layer is CB 420 + CHT 1500, the base tile is 3600 blocks and the detail tile 420. The type comes from the sim's cvt (map2.G) plus tops (map.G), both read at lod 3; map2 is now mipmapped, because sharp type steps from cell to cell drew stripes. Slices sit at fixed heights `CHT*pow(i/n,1.4)`. clouds.js bakes the 3D textures (units 13/14).
- Port script: the Cloud Lab thread's scratchpad port/patch.py (anchor-based).

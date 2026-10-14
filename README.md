# Emberwood

A voxel autumn forest on a simulated planet (plate tectonics, climate, erosion, rivers, weather), written in plain JavaScript and raw WebGL2 with no libraries.

![Emberwood](screenshot.png)

## Build

```
node build.mjs
```

This inlines `src/` into a single self-contained `index.html` (and `emberwood.html`, the page body without the html/head wrapper). Open `index.html` in a browser with WebGL2.

`VERSION` is shown in the HUD; bump it when shipping a new build.

## Deploy

Every push to `main` runs `.github/workflows/pages.yml`, which builds and deploys `index.html` to GitHub Pages.

## Sharing a spot

Menu → Settings → **Share this spot** copies a link whose hash holds the seed, position, view, time of day and season, e.g.
`https://headswe.github.io/WorldSim/#s=1337&p=6544,80,2994&v=0.50,-0.10&t=15.0&se=2`.
Opening the link grows that planet and drops you there. The same code (or the whole link) can be pasted into the box and sent with **Go**.

## Playing with the environment

Menu → **Environment** has live sliders for temperature, humidity, cloudiness, storms, rain and haze (plus Settings → wind). They act on the weather simulation as it runs, so clouds, rain and thunderstorms build or clear over a minute or two; the terrain stays as the planet made it. Shared spots carry these values when they differ from the defaults.

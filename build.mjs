// Inlines src/ into one self-contained page: emberwood.html (artifact body) and index.html (standalone).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const r = f => readFileSync(dir + f, 'utf8');
// sound effects in sfx/ (name.mp3, .ogg or .wav) are inlined so the page stays one file
const MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4' };
const sfx = {};
if (existsSync(dir + 'sfx')) for (const f of readdirSync(dir + 'sfx').sort()) {
  const m = f.match(/^(.+)\.(mp3|ogg|wav|m4a)$/);
  if (m) sfx[m[1]] = `data:${MIME[m[2]]};base64,` + readFileSync(dir + 'sfx/' + f).toString('base64');
}
const body = r('src/page.html')
  .replace('/*WORKER*/', () => r('src/planet.js') + '\n' + r('src/worker.js'))
  .replace('/*SHADERS*/', () => r('src/shaders.js'))
  .replace('/*POST*/', () => r('src/post.js') + '\n' + r('src/clouds.js') + '\n' + r('src/atmos.js') + '\n' + r('src/ocean.js') + '\n' + r('src/boat.js') + '\n' + r('src/audio.js').replace('/*SFX*/{}', () => JSON.stringify(sfx)))
  .replace('/*MAIN*/', () => r('src/main.js').replace('/*BUILD*/', r('VERSION').trim()));
writeFileSync(dir + 'emberwood.html', body);
writeFileSync(dir + 'index.html', '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' + body + '\n</body>\n</html>\n');
console.log('built', body.length, 'bytes,', Object.keys(sfx).length, 'sound files');

// Inlines src/ into one self-contained page: emberwood.html (artifact body) and index.html (standalone).
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
const r = f => readFileSync(dir + f, 'utf8');
const body = r('src/page.html')
  .replace('/*WORKER*/', () => r('src/planet.js') + '\n' + r('src/worker.js'))
  .replace('/*SHADERS*/', () => r('src/shaders.js'))
  .replace('/*POST*/', () => r('src/post.js') + '\n' + r('src/clouds.js'))
  .replace('/*MAIN*/', () => r('src/main.js').replace('/*BUILD*/', r('VERSION').trim()));
writeFileSync(dir + 'emberwood.html', body);
writeFileSync(dir + 'index.html', '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' + body + '\n</body>\n</html>\n');
console.log('built', body.length, 'bytes');

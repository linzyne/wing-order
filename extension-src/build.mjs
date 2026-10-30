// 확장용 offscreen.js 묶기 (firebase 포함). npm run build:ext
import { build } from 'esbuild';
for (const dir of ['wing-order-extension', 'admin-order-extension']) {
  await build({
    entryPoints: ['extension-src/offscreen.js'],
    outfile: `${dir}/offscreen.js`,
    bundle: true, format: 'iife', minify: true, target: 'chrome120', legalComments: 'none',
    banner: { js: '// 묶은 파일 — extension-src/offscreen.js 를 고치고 npm run build:ext' },
  });
}
console.log('offscreen.js 만듦');

import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod'); // 打包时:关 sourcemap + 压缩(不把源码映射塞进分发包)
const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info' };

/** 三个产物:主进程、preload、渲染层。electron 内置模块标记 external。 */
const targets = [
  { entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { entryPoints: ['src/renderer/hud.ts'], outfile: 'dist/renderer/hud.js', platform: 'browser', format: 'iife' },
];

async function copyStatic() {
  await mkdir('dist/renderer', { recursive: true });
  await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
  await copyFile('src/renderer/hud.css', 'dist/renderer/hud.css');
}

await copyStatic();

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context({ ...common, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[clipeek] watching for changes…');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...common, ...t })));
  console.log('[clipeek] build done → dist/');
}

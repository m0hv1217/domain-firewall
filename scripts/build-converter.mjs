// scripts/build-converter.mjs
// 用法: node scripts/build-converter.mjs
// 产物: dnr-converter.bundle.js（IIFE，暴露全局 DnrConverter）

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

await build({
  entryPoints: [join(ROOT, 'scripts', 'converter-entry.mjs')],
  outfile: join(ROOT, 'dnr-converter.bundle.js'),

  bundle: true,
  format: 'iife',
  globalName: 'DnrConverter',

  platform: 'browser',
  target: 'chrome120',

  // WASM 内联为 base64，保证单文件产物、SW 内可直接编译
  loader: { '.wasm': 'binary' },

  // 生产构建
  minify: true,
  sourcemap: false,
  legalComments: 'none',

  // 避免 Node 内置模块被误引入
  define: {
    'process.env.NODE_ENV': '"production"',
  },

  logLevel: 'info',
});

console.log('[build-converter] 完成 → dnr-converter.bundle.js');
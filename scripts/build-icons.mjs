// scripts/build-icons.mjs
// 用法: node scripts/build-icons.mjs
// 输入: icons/icon.svg
// 输出: icons/icon16.png, icon32.png, icon48.png, icon128.png

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SRC = join(ROOT, 'icons', 'icon.svg');
const OUT_DIR = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

mkdirSync(OUT_DIR, { recursive: true });

const svg = readFileSync(SRC, 'utf8');

for (const size of SIZES) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  const png = resvg.render().asPng();
  const out = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`[build-icons] ${out} (${png.length} bytes)`);
}

console.log('[build-icons] 完成');
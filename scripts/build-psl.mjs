// scripts/build-psl.mjs
// 用官方 Public Suffix List 重新生成 psl.js 里 "PSL DATA BEGIN / END" 之间的数据块。
// 只改这一块，判定逻辑（getRootDomain 等）原样保留。
//
// 用法（在项目根目录）：
//   node scripts/build-psl.mjs --fetch                    下载最新官方列表（需要 Node 18+ 和网络）
//   node scripts/build-psl.mjs --dat path/to/list.dat     使用本地的 public_suffix_list.dat
//   node scripts/build-psl.mjs --rules-js path/to/rules.js 使用 npm 包 psl 的 data/rules.js
//   node scripts/build-psl.mjs                            缺省：尝试 node_modules/psl/data/rules.js
//
// 生成时会把 Unicode 规则转成 punycode，并去重、排序，保证输出稳定。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, domainToASCII } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(__dirname, '..', 'psl.js');
const BEGIN = '// ==== PSL DATA BEGIN';
const END = '// ==== PSL DATA END ====';
const OFFICIAL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

// ---------- 读取原始规则 ----------
function parseDat(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    rules.push(line.split(/\s/)[0]);   // 规范：规则只取到第一个空白为止
  }
  return rules;
}

function parseRulesJs(text) {
  const body = text.replace(/^\s*export\s+default\s+/, '').replace(/^\s*module\.exports\s*=\s*/, '').trim().replace(/;\s*$/, '');
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error('rules.js 不是数组');
  return arr;
}

async function loadRules() {
  if (opt('--fetch')) {
    const res = await fetch(OFFICIAL_URL);
    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
    return { rules: parseDat(await res.text()), source: OFFICIAL_URL };
  }
  const dat = opt('--dat');
  if (typeof dat === 'string') {
    return { rules: parseDat(fs.readFileSync(dat, 'utf8')), source: `file:${path.basename(dat)}` };
  }
  const rj = opt('--rules-js') || path.resolve(__dirname, '..', 'node_modules', 'psl', 'data', 'rules.js');
  if (typeof rj === 'string' && fs.existsSync(rj)) {
    let ver = '';
    try { ver = '@' + JSON.parse(fs.readFileSync(path.join(path.dirname(rj), '..', 'package.json'), 'utf8')).version; } catch { /* 无版本信息 */ }
    return { rules: parseRulesJs(fs.readFileSync(rj, 'utf8')), source: `npm:psl${ver}` };
  }
  throw new Error('没有可用的数据源。请使用 --fetch，或 --dat <文件>，或先 npm i -D psl。');
}

// ---------- 规范化 ----------
function normalize(rules) {
  const out = new Set();
  let skipped = 0;
  for (const raw of rules) {
    let prefix = '', body = String(raw).trim().toLowerCase();
    if (body.startsWith('!')) { prefix = '!'; body = body.slice(1); }
    else if (body.startsWith('*.')) { prefix = '*.'; body = body.slice(2); }
    const ascii = domainToASCII(body);   // Unicode → punycode；非法输入返回 ''
    if (!ascii || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(ascii)) { skipped++; continue; }
    out.add(prefix + ascii);
  }
  return { rules: [...out].sort(), skipped };
}

// ---------- 写回 psl.js ----------
async function main() {  const { rules: rawRules, source } = await loadRules();
  const { rules, skipped } = normalize(rawRules);
  if (rules.length < 1000) throw new Error(`规则数只有 ${rules.length}，数据源看起来不对，已中止`);

  const meta = { source, generatedAt: new Date().toISOString().slice(0, 10), rules: rules.length };
  const block =
    `  ${BEGIN}（自动生成，勿手改）====\n` +
    `  const PSL_META = ${JSON.stringify(meta)};\n` +
    `  const PSL_RULES = \`\n${rules.join('\n')}\n\`;\n` +
    `  ${END}`;

  const src = fs.readFileSync(TARGET, 'utf8');
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i < 0 || j < 0 || j < i) throw new Error('psl.js 里找不到 PSL DATA BEGIN / END 标记');
  const regionStart = src.lastIndexOf('\n', i) + 1;                 // BEGIN 所在行的行首
  const endNl = src.indexOf('\n', j);
  const regionEnd = endNl < 0 ? src.length : endNl;                 // END 所在行的行尾（不含换行）
  const next = src.slice(0, regionStart) + block + src.slice(regionEnd);

  fs.writeFileSync(TARGET, next, 'utf8');
  console.log(`psl.js 已更新：${rules.length} 条规则（来源 ${source}，跳过无效 ${skipped} 条，${(Buffer.byteLength(next) / 1024).toFixed(0)} KB）`);
}

main().catch((e) => {
  console.error('build-psl 失败：' + e.message);
  process.exit(1);
});

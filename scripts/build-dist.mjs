// scripts/build-dist.mjs
// 预构建 + 分包：为 Chrome / Edge / Opera / Firefox 分别生成可直接使用的扩展包。
// 产物全部是纯静态文件，最终用户不需要安装 Node.js 或任何其他软件。
//
// 用法（项目根目录；请先 npm run build 生成 icons/ 和 rules/）：
//   node scripts/build-dist.mjs                              四个浏览器都构建（目录 + 商店上传用 zip）
//   node scripts/build-dist.mjs --target firefox             只构建某一个：chrome / edge / opera / firefox
//   node scripts/build-dist.mjs --target chrome,edge         逗号分隔可选多个；chromium = chrome + edge + opera
//   node scripts/build-dist.mjs --release                    在以上基础上生成 release/ 发布包（见下）
//   node scripts/build-dist.mjs --no-zip                     只要目录，不生成 zip
//
// 产物：
//   dist/<浏览器>/                                   解压即用的扩展目录（可直接"加载已解压的扩展"）
//   dist/domain-firewall-<版本>-<浏览器>.zip          商店上传 / 提交签名用的纯扩展包（manifest 在根目录）
//   release/store/*.zip                              同上（汇总，--release 时生成）
//   release/packages/*-package.zip                   发给最终用户的整包：扩展文件夹 + 该浏览器的安装说明
//   release/SHA256SUMS.txt、release/RELEASE.txt      校验和与发布摘要
//
// Chrome / Edge / Opera 同属 Chromium 内核，扩展文件完全相同，分开打包是为了：
// 各商店分别提交、安装说明各自准确。需要为某个浏览器单独改 manifest 时，新建
// manifest.<浏览器>.json（如 manifest.edge.json）即可，会自动合并，无需改脚本。
//
// Firefox 的 manifest 由 manifest.firefox.json 补丁合并而成（background 改成事件页、加 gecko 设置）。
// 如果项目根目录的 signed/ 里放了已签名的 .xpi（文件名含版本号），release 的 Firefox 整包会自动带上它。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');
const BASE_MANIFEST = 'manifest.json';
const PLACEHOLDER_GECKO_ID = 'domain-firewall@example.com';
const MIN_REAL_RULES = 1000;          // 低于这个数量的规则集，多半是占位规则集

const BROWSERS = {
  chrome:  { label: 'Google Chrome',   family: 'chromium', page: 'chrome://extensions', devMode: '开发者模式',   loadBtn: '加载已解压的扩展程序',
             startupNote: '每次启动 Google Chrome 时可能提示“停用开发者模式的扩展程序”，选择保留即可。',
             permHow: '到 chrome://extensions → Domain Firewall → 详情 → 网站访问权限，选“在所有网站上”。' },
  edge:    { label: 'Microsoft Edge',  family: 'chromium', page: 'edge://extensions',   devMode: '开发人员模式', loadBtn: '加载解压缩的扩展',
             startupNote: '启动 Microsoft Edge 时如果出现与开发人员模式有关的提示，选择保留 / 忽略即可。',
             permHow: '到 edge://extensions → Domain Firewall → 详细信息，把站点访问权限设为允许所有网站。' },
  opera:   { label: 'Opera',           family: 'chromium', page: 'opera://extensions',  devMode: '开发者模式',   loadBtn: '加载已解压的扩展程序',
             startupNote: null,
             permHow: '到 opera://extensions → Domain Firewall 的详情里，把站点访问权限设为允许所有网站（具体位置因 Opera 版本而异）。' },
  firefox: { label: 'Mozilla Firefox', family: 'firefox' },
};

// ---------- 参数 ----------
const args = process.argv.slice(2);
const argVal = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const doRelease = args.includes('--release');
const shouldZip = doRelease || !args.includes('--no-zip');
function fail(msg) { console.error('build-dist 失败：' + msg); process.exit(1); }

const wanted = argVal('--target', 'all').split(',').map((s) => s.trim()).filter(Boolean);
const TARGETS = [];
for (const w of wanted) {
  const list = w === 'all' ? Object.keys(BROWSERS) : w === 'chromium' ? ['chrome', 'edge', 'opera'] : [w];
  for (const t of list) {
    if (!BROWSERS[t]) fail(`未知目标 "${t}"，可选 chrome / edge / opera / firefox / chromium / all`);
    if (!TARGETS.includes(t)) TARGETS.push(t);
  }
}
if (doRelease && TARGETS.length !== Object.keys(BROWSERS).length) {
  fail('--release 需要同时构建四个浏览器（不要和 --target 一起用）');
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

// ---------- manifest ----------
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('_')) continue;                 // 说明性键，不合并
    if (v === null) { delete out[k]; continue; }     // null = 删除
    const bothObjects = v && typeof v === 'object' && !Array.isArray(v) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]);
    out[k] = bothObjects ? deepMerge(out[k], v) : v;
  }
  return out;
}

function buildManifest(browser) {
  let m = readJson(BASE_MANIFEST);
  const patchRel = `manifest.${browser}.json`;       // 每个浏览器可以有自己的补丁（可选）
  if (fs.existsSync(path.join(ROOT, patchRel))) m = deepMerge(m, readJson(patchRel));
  else if (BROWSERS[browser].family === 'firefox') fail(`缺少 ${patchRel}`);
  return m;
}

function validateManifest(browser, m, problems, warnings) {
  const family = BROWSERS[browser].family;
  const bg = m.background || {};
  if (family === 'chromium') {
    if (!bg.service_worker) problems.push('Chromium 系需要 background.service_worker');
    if (bg.scripts) problems.push('Chromium 系不应包含 background.scripts（旧版 Chrome 会报警告）');
    if (m.browser_specific_settings) warnings.push('带有 browser_specific_settings（Firefox 专用，会被忽略）');
  } else {
    if (!Array.isArray(bg.scripts) || !bg.scripts.length) problems.push('Firefox 版需要 background.scripts');
    if (bg.service_worker) problems.push('Firefox 版不应包含 background.service_worker');
    const i = (n) => (bg.scripts || []).indexOf(n);
    if (i('budget-manager.js') < 0 || i('budget-manager.js') > i('background.js')) {
      problems.push('background.scripts 里 budget-manager.js 必须存在且排在 background.js 之前');
    }
    if (i('dnr-converter.bundle.js') > i('background.js')) {
      problems.push('background.scripts 里 dnr-converter.bundle.js 必须排在 background.js 之前');
    }
    const gecko = (m.browser_specific_settings || {}).gecko || {};
    if (!gecko.id) problems.push('Firefox 版需要 browser_specific_settings.gecko.id');
    else if (gecko.id === PLACEHOLDER_GECKO_ID) warnings.push(`gecko.id 还是占位值 ${PLACEHOLDER_GECKO_ID}：上架或签名前请在 manifest.firefox.json 里改成你自己的`);
    if (!gecko.data_collection_permissions) warnings.push('缺少 data_collection_permissions（2025-11 起新上架 AMO 的扩展必须声明）');
  }
  const pkgVer = readJson('package.json').version || '';
  if (pkgVer && !pkgVer.startsWith(m.version)) warnings.push(`manifest 版本 ${m.version} 与 package.json 版本 ${pkgVer} 不一致`);
}

// ---------- 收集要打包的文件 ----------
const isLocalRef = (s) => s && !/^([a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(s);
const clean = (s) => s.split('#')[0].split('?')[0].replace(/^\.?\//, '');

function manifestRefs(m) {
  const refs = new Set();
  const add = (x) => { if (typeof x === 'string' && isLocalRef(x)) refs.add(clean(x)); };
  Object.values(m.icons || {}).forEach(add);
  const action = m.action || m.browser_action || {};
  add(action.default_popup);
  const di = action.default_icon;
  if (typeof di === 'string') add(di); else Object.values(di || {}).forEach(add);
  add((m.options_ui || {}).page); add(m.options_page);
  const bg = m.background || {};
  add(bg.service_worker); add(bg.page); (bg.scripts || []).forEach(add);
  for (const cs of m.content_scripts || []) { (cs.js || []).forEach(add); (cs.css || []).forEach(add); }
  for (const r of (m.declarative_net_request || {}).rule_resources || []) add(r.path);
  for (const w of m.web_accessible_resources || []) (w.resources || []).forEach(add);
  return [...refs];
}

function scanFile(rel) {
  const found = [];
  const ext = path.extname(rel).toLowerCase();
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (ext === '.html') {
    for (const m of text.matchAll(/<(?:script|img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) found.push(m[1]);
    for (const m of text.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) found.push(m[1]);
  } else if (ext === '.js') {
    for (const m of text.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) found.push(s[1]);
    }
  }
  return found.filter(isLocalRef).map(clean);
}

function collectFiles(manifest) {
  const files = new Set();
  const missing = [];
  const queue = manifestRefs(manifest);
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) { missing.push(rel); continue; }
    files.add(rel);
    if (/\.(html|js)$/i.test(rel)) queue.push(...scanFile(rel));
  }
  return { files: [...files].sort(), missing: [...new Set(missing)].sort() };
}

// ---------- 发布前体检：规则集 / 多余文件 ----------
const FORBIDDEN = /(^|\/)(node_modules|filters|scripts|tests?|dist|release|signed)\/|(^|\/)(package(-lock)?\.json|README[^/]*|\.git[^/]*)$|\.(mjs|map|md|ts)$/i;

function inspectPackage(manifest, files, problems, warnings) {
  const info = { rulesets: [] };
  for (const f of files) if (FORBIDDEN.test(f)) problems.push(`包里混进了不该发布的文件：${f}`);
  for (const r of (manifest.declarative_net_request || {}).rule_resources || []) {
    let rules;
    try { rules = JSON.parse(fs.readFileSync(path.join(ROOT, r.path), 'utf8')); }
    catch (e) { problems.push(`规则集 ${r.path} 不是合法 JSON：${e.message}`); continue; }
    if (!Array.isArray(rules)) { problems.push(`规则集 ${r.path} 不是数组`); continue; }
    const unsafe = rules.filter((x) => x.action && (x.action.type === 'redirect' || x.action.type === 'modifyHeaders')).length;
    const regex = rules.filter((x) => x.condition && x.condition.regexFilter).length;
    if (unsafe || regex) problems.push(`规则集 ${r.path} 含 ${unsafe} 条不安全动作 / ${regex} 条正则规则，浏览器会拒绝加载（请重新 npm run build:rules）`);
    if (rules.length > 30000) problems.push(`规则集 ${r.path} 有 ${rules.length} 条，超过静态规则 30,000 的保证额度`);
    if (rules.length < MIN_REAL_RULES) warnings.push(`规则集 ${r.path} 只有 ${rules.length} 条，看起来是占位规则集——这样的包没有广告拦截效果，不要对外发布`);
    info.rulesets.push({ id: r.id, path: r.path, enabled: r.enabled !== false, count: rules.length });
  }
  const enabledTotal = info.rulesets.filter((x) => x.enabled).reduce((n, x) => n + x.count, 0);
  if (enabledTotal > 30000) warnings.push(`默认启用的规则集合计 ${enabledTotal} 条，超过 30,000`);
  return info;
}

// ---------- zip（纯 Node，无依赖）----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function makeZip(entries) {
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;   // 固定时间戳，保证同样的输入得到同样的 zip
  const DOS_TIME = 0;
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---------- 给最终用户的安装说明 ----------
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const toWindowsText = (s) => Buffer.concat([BOM, Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8')]);   // UTF-8 + BOM + CRLF，旧版记事本也能正确显示

function installText(browser, ver, ctx) {
  const b = BROWSERS[browser];
  const head = [
    '================================================================================',
    ` Domain Firewall ${ver} —— ${b.label} 安装说明`,
    '================================================================================',
    '',
    '这个压缩包里是已经构建好的扩展，不需要安装 Node.js、npm 或任何其他软件，',
    '只要有浏览器就能装。',
    '',
    '包内容：',
    '  extension/     扩展本体（里面直接能看到 manifest.json）',
    '  INSTALL.txt    本说明',
  ];
  if (browser === 'firefox') {
    const xpi = ctx.signedXpi ? `domain-firewall-${ver}-firefox.xpi` : `domain-firewall-${ver}-firefox-unsigned.xpi`;
    head.push(`  ${xpi}${ctx.signedXpi ? '   （已由 Mozilla 签名，正式版 Firefox 可直接安装）' : '   （未签名，正式版 Firefox 会拒绝安装，见下面的说明）'}`);
  }
  head.push('');

  if (b.family === 'chromium') {
    return [...head,
      '一、安装（约 1 分钟）',
      '',
      '  1) 把本压缩包解压到一个【固定位置】，例如 D:\\Tools\\domain-firewall 。',
      '     注意：浏览器会一直从这个文件夹读取扩展，安装后不要移动或删除它。',
      `  2) 打开 ${b.label}，在地址栏输入   ${b.page}   并回车。`,
      `  3) 打开页面右上角的“${b.devMode}”开关。`,
      `  4) 点“${b.loadBtn}”，选择解压出来的 extension 文件夹`,
      '     （要选到能直接看见 manifest.json 的那一层）。',
      '  5) 完成。建议把 Domain Firewall 固定到工具栏，方便点击。',
      '',
      '二、检查权限',
      '',
      '  默认已授予“访问所有网站”。如果点开扩展图标看到黄色警告“未授予「所有网站」访问权限”，',
      `  ${b.permHow}`,
      '  （没有这个权限时，拦截仍然工作，但记录模式和元素拾取不可用。）',
      '',
      '三、说明',
      '',
      '  - 为什么要开发者模式：Windows / macOS 上的正式版浏览器不允许从应用商店以外安装 .crx',
      '    安装包，只能加载解压后的文件夹。',
      ...(b.startupNote ? [`  - ${b.startupNote}`] : []),
      '  - 更省事的办法：由发布者把扩展上架到商店（Chrome 网上应用店可设为“不公开”，',
      '    Edge 附加组件可设为“隐藏”，只有拿到链接的人才能安装），用户点“添加”即可，',
      '    不需要开发者模式。详见 README.txt 第 14 节。',
      '',
      '四、更新',
      '',
      '  把新版本解压到同一个文件夹，覆盖旧文件；然后在扩展管理页点 Domain Firewall 的“刷新”按钮，',
      '  并刷新已经打开的网页（否则元素拾取会提示你刷新页面）。',
      '',
      '五、卸载',
      '',
      `  在 ${b.page} 里点“移除”，再删除解压的文件夹。设置、日志等数据保存在浏览器里，会一并删除。`,
      '',
      '六、使用方法',
      '',
      '  点工具栏上的 Domain Firewall 图标：默认是“拦截”模式，只允许页面与它自己的站点（含子域名）',
      '  和你加入白名单的域名通信。页面显示不全时，切到“记录”模式刷新页面，在设置页的日志里找到',
      '  被拦的域名，加入白名单，再切回“拦截”。完整说明见 README.txt 第一部分。',
      '',
    ].join('\n');
  }

  // Firefox
  return [...head,
    '一、先说明：Firefox 只能安装“经过 Mozilla 签名”的扩展',
    '',
    ctx.signedXpi
      ? '  本包里的 .xpi 已经签名，按下面的“方式 A”安装即可。'
      : '  本包里的 .xpi【没有签名】，正式版 Firefox 会拒绝安装它。请按下面“方式 B/C”使用，\n  或让发布者提供已签名的版本（把已签名的 .xpi 放进项目的 signed/ 目录，重新运行\n  npm run release，这个包就会带上它）。',
    '',
    '二、安装方式',
    '',
    '  【方式 A：已签名的 .xpi，长期使用】',
    '    1) 把 .xpi 文件拖进 Firefox 窗口（或 about:addons → 齿轮 → 从文件安装附加组件）；',
    '    2) 在弹出的提示里点“添加”；',
    '    3) 安装后到 about:addons → Domain Firewall → 权限，打开“访问所有网站的数据”（见第三节）。',
    '',
    '  【方式 B：临时载入（测试用，关闭 Firefox 后失效）】',
    '    1) 把压缩包解压到任意位置；',
    '    2) 地址栏输入  about:debugging#/runtime/this-firefox  并回车；',
    '    3) 点“临时载入附加组件…”，选择 extension 文件夹里的 manifest.json。',
    '    每次重新启动 Firefox 都要重新做一遍。',
    '',
    '  【方式 C：Firefox Developer Edition / Nightly / ESR（长期使用，无需签名）】',
    '    1) 地址栏输入 about:config，把 xpinstall.signatures.required 设为 false；',
    '    2) about:addons → 齿轮 → 从文件安装附加组件，选择未签名的 .xpi。',
    '    正式版 Firefox 不允许这样做。',
    '',
    '三、检查权限（重要）',
    '',
    '  Firefox 默认不授予“访问所有网站”。没有它，拦截仍然工作，但记录模式和元素拾取不可用。',
    '  开启方法：about:addons → Domain Firewall → 权限 → 打开“访问所有网站的数据”。',
    '  点开扩展图标看到黄色警告，就说明还没开启。',
    '',
    '四、要求',
    '',
    '  Firefox 140 或更高版本。',
    '',
    '五、更新与卸载',
    '',
    '  更新：安装新版 .xpi 会覆盖旧版（扩展 ID 必须保持不变）。',
    '  卸载：about:addons → Domain Firewall → 移除。数据保存在浏览器里，会一并删除。',
    '',
    '六、使用方法',
    '',
    '  点工具栏上的 Domain Firewall 图标：默认是“拦截”模式。页面显示不全时，切到“记录”模式刷新页面，',
    '  在设置页的日志里找到被拦的域名，加入白名单，再切回“拦截”。完整说明见 README.txt 第一部分。',
    '',
  ].join('\n');
}

// ---------- 主流程 ----------
fs.mkdirSync(DIST, { recursive: true });
let hadError = false;
const built = [];     // 成功构建的目标信息
const printedWarnings = new Set();   // 同一条警告只在控制台打印一次（四个浏览器常常一样）

for (const browser of TARGETS) {
  const manifest = buildManifest(browser);
  const problems = [], warnings = [];
  validateManifest(browser, manifest, problems, warnings);
  const { files, missing } = collectFiles(manifest);
  if (missing.length) {
    problems.push('以下文件被引用但不存在（图标和规则文件请先运行 npm run build）：\n    - ' + missing.join('\n    - '));
  }
  const info = missing.length ? { rulesets: [] } : inspectPackage(manifest, files, problems, warnings);

  console.log(`\n== ${browser}（${BROWSERS[browser].label}）==`);
  let skipped = 0;
  for (const w of warnings) {
    if (printedWarnings.has(w)) { skipped++; continue; }
    printedWarnings.add(w);
    console.log('  警告：' + w);
  }
  if (skipped) console.log(`  （另有 ${skipped} 条与前面浏览器相同的警告，已省略）`);
  if (problems.length) {
    for (const p of problems) console.error('  错误：' + p);
    hadError = true;
    continue;
  }

  const outDir = path.join(DIST, browser);
  fs.rmSync(outDir, { recursive: true, force: true });
  let totalSize = 0;
  for (const rel of files) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
    totalSize += fs.statSync(dest).size;
  }
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestText);
  const rulesText = info.rulesets.map((r) => `${r.id}${r.enabled ? '' : '(默认关闭)'}=${r.count}`).join(' ');
  console.log(`  目录：dist/${browser}/（${files.length + 1} 个文件，${kb(totalSize)}；规则集 ${rulesText || '无'}）`);

  const entries = [
    { name: 'manifest.json', data: Buffer.from(manifestText) },
    ...files.map((rel) => ({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(path.join(outDir, rel)) })),
  ];
  const result = { browser, manifest, files, entries, info, warnings, totalSize, storeZip: null };
  if (shouldZip) {
    const zipBuf = makeZip(entries);
    const zipPath = path.join(DIST, `domain-firewall-${manifest.version}-${browser}.zip`);
    fs.writeFileSync(zipPath, zipBuf);
    result.storeZip = { path: zipPath, data: zipBuf };
    console.log(`  商店包：dist/${path.basename(zipPath)}（${kb(zipBuf.length)}）`);
  }
  built.push(result);
}

if (hadError) process.exit(1);

// ---------- 发布包（release/）----------
if (doRelease) {
  const ver = built[0].manifest.version;
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(RELEASE, 'store'), { recursive: true });
  fs.mkdirSync(path.join(RELEASE, 'packages'), { recursive: true });
  const sums = [];
  const summary = [];
  console.log('\n== release ==');

  for (const r of built) {
    const { browser } = r;
    const top = `domain-firewall-${ver}-${browser}`;

    // 1) 商店上传包（纯扩展，manifest 在根目录）
    const storeName = `domain-firewall-${ver}-${browser}.zip`;
    fs.writeFileSync(path.join(RELEASE, 'store', storeName), r.storeZip.data);
    sums.push([sha256(r.storeZip.data), `store/${storeName}`]);

    // 2) 给最终用户的整包：extension/ + INSTALL.txt（Firefox 另带 .xpi）
    let signedXpi = null;
    if (browser === 'firefox') {
      const dir = path.join(ROOT, 'signed');
      if (fs.existsSync(dir)) {
        const cand = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xpi') && f.includes(ver));
        if (cand.length) signedXpi = fs.readFileSync(path.join(dir, cand.sort().pop()));
      }
    }
    const pkgEntries = [
      { name: `${top}/INSTALL.txt`, data: toWindowsText(installText(browser, ver, { signedXpi: !!signedXpi })) },
      ...r.entries.map((e) => ({ name: `${top}/extension/${e.name}`, data: e.data })),
    ];
    if (browser === 'firefox') {
      pkgEntries.push(signedXpi
        ? { name: `${top}/domain-firewall-${ver}-firefox.xpi`, data: signedXpi }
        : { name: `${top}/domain-firewall-${ver}-firefox-unsigned.xpi`, data: r.storeZip.data });
    }
    const pkgName = `${top}-package.zip`;
    const pkgBuf = makeZip(pkgEntries);
    fs.writeFileSync(path.join(RELEASE, 'packages', pkgName), pkgBuf);
    sums.push([sha256(pkgBuf), `packages/${pkgName}`]);
    console.log(`  ${pkgName}（${kb(pkgBuf.length)}）${browser === 'firefox' ? (signedXpi ? '  含已签名 .xpi' : '  .xpi 未签名') : ''}`);
    summary.push({ browser, pkgName, storeName, size: pkgBuf.length, rules: r.info.rulesets, signedXpi: !!signedXpi, warnings: r.warnings });
  }

  fs.writeFileSync(path.join(RELEASE, 'SHA256SUMS.txt'),
    sums.map(([h, n]) => `${h}  ${n}`).join('\n') + '\n');

  const allWarnings = [...new Set(summary.flatMap((s) => s.warnings))];
  const lines = [
    `Domain Firewall ${ver} 发布摘要`,
    `生成时间：${new Date().toISOString()}`,
    '',
    '目录说明',
    '  store/      商店上传 / 提交签名用的纯扩展包（manifest.json 在 zip 根目录）',
    '  packages/   发给最终用户的整包：extension/ 扩展文件夹 + INSTALL.txt 安装说明',
    '  SHA256SUMS.txt  以上所有 zip 的校验和（校验命令：Windows certutil -hashfile 文件 SHA256，',
    '                  macOS/Linux shasum -a 256 文件）',
    '',
    '各浏览器',
  ];
  for (const s of summary) {
    lines.push(`  ${BROWSERS[s.browser].label}`);
    lines.push(`    整包   packages/${s.pkgName}`);
    lines.push(`    商店包 store/${s.storeName}`);
    lines.push(`    规则集 ${s.rules.map((x) => `${x.id}=${x.count}${x.enabled ? '' : '(默认关闭)'}`).join('，') || '无'}`);
    if (s.browser === 'firefox') lines.push(`    Firefox .xpi：${s.signedXpi ? '已签名（来自 signed/）' : '未签名——正式版 Firefox 无法直接安装，需要先签名（README 第 14.4 节）'}`);
  }
  lines.push('', '需要处理的警告', ...(allWarnings.length ? allWarnings.map((w) => '  - ' + w) : ['  （无）']), '');
  fs.writeFileSync(path.join(RELEASE, 'RELEASE.txt'), toWindowsText(lines.join('\n')));
  console.log('  SHA256SUMS.txt、RELEASE.txt');
}

console.log('\n完成。');

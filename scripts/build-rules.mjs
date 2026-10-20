// scripts/build-rules.mjs
// 用法: node scripts/build-rules.mjs
//
// 职责:
//   读取 filters/*.txt（原始 EasyList / AdGuard 列表）
//   → @adguard/dnr-converter 转换
//   → 过滤掉静态规则集不支持的规则（unsafe 动作、正则）
//   → 写入 rules/*.json（manifest 中 rule_resources 引用的静态规则集）
//
// 注意:
//   - 这是构建脚本，不在扩展运行时执行。
//   - 转换错误是预期行为：$replace / $jsonprune / $popup / DNS 修饰符等
//     无法用 DNR 表达，converter 会跳过并记入 errors，脚本不应因此失败。
//   - 不负责下载 filters/*.txt；列表来源与版本由 CI 或人工控制，
//     以保证构建产物可复现。
//   - 适配 @adguard/dnr-converter 2.x API（convert + ruleset.getDeclarativeRules）。
//   - 静态规则集（rule_resources）只允许 safe 动作：
//       block / allow / allowAllRequests / upgradeScheme
//     redirect / modifyHeaders 会导致 Chrome 拒绝加载整个 ruleset，必须剔除。
//   - 正则规则在静态规则集中有严格配额，且 Node 环境下 re2-wasm 无法访问
//     chrome.declarativeNetRequest，converter 会保守拒绝——这里再过滤一次作为防御。

import { Filter, FilterConverter } from '@adguard/dnr-converter';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ============================================================================
// 规则集定义
// ============================================================================
// 每个条目对应 manifest.declarative_net_request.rule_resources 中的一项。
// id 必须与 manifest 完全一致。
const RULESETS = [
  {
    id: 'easylist',
    source: join(ROOT, 'filters', 'easylist.txt'),
    output: join(ROOT, 'rules', 'easylist.json'),
  },
  {
    id: 'adguard-base',
    source: join(ROOT, 'filters', 'adguard-base.txt'),
    output: join(ROOT, 'rules', 'adguard-base.json'),
  },
];

// ============================================================================
// 单规则集上限
// ============================================================================
// Chrome 静态规则集安全上限约为 30,000 条/扩展（121+）。
// 这里对每个规则集单独截断，为其他规则集与动态规则留余量。
// 先过滤 unsafe / regex，再截断，保证最终产物全为 safe 规则。
const MAX_RULES_PER_SET = 28000;

// ============================================================================
// 工具
// ============================================================================
function loadFilterText(path) {
  if (!existsSync(path)) {
    console.warn(`[build-rules] 跳过缺失的过滤列表: ${path}`);
    return null;
  }
  const text = readFileSync(path, 'utf8');
  // 去掉 BOM（某些 Windows 编辑器会写入）
  return text.replace(/^\uFEFF/, '');
}

/**
 * 从 converter 返回的 errors / limitations 数组中提取可读消息。
 * 2.x 的 errors 元素可能是对象，字段随版本略有差异，做宽松兼容。
 */
function stringifyIssue(item) {
  if (item == null) return '(unknown)';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    const parts = [];
    if (item.filter) parts.push(`filter=${item.filter}`);
    if (item.rule) parts.push(`rule=${item.rule}`);
    if (item.reason) parts.push(`reason=${item.reason}`);
    if (item.message) parts.push(item.message);
    if (!parts.length) {
      try { return JSON.stringify(item); } catch { return String(item); }
    }
    return parts.join(' | ');
  }
  return String(item);
}

function reportIssues(name, list, label, limit = 10) {
  if (!list || !list.length) return;
  console.warn(`[build-rules] ${name}: ${list.length} 条${label}`);
  list.slice(0, limit).forEach((item, i) => {
    console.warn(`  [${i + 1}] ${stringifyIssue(item)}`);
  });
  if (list.length > limit) {
    console.warn(`  ... 其余 ${list.length - limit} 条已省略`);
  }
}

/**
 * 过滤静态规则集不支持的动作和字段。
 *   - unsafe 动作：redirect / modifyHeaders
 *   - 正则条件：regexFilter（静态规则集有严格配额，且 Node 端已多数被拒）
 *
 * 返回 { rules, removedUnsafe, removedRegex }
 */
function filterForStaticRuleset(rules) {
  let removedUnsafe = 0;
  let removedRegex = 0;

  const filtered = [];
  for (const r of rules) {
    const t = r && r.action && r.action.type;
    if (t === 'redirect' || t === 'modifyHeaders') {
      removedUnsafe++;
      continue;
    }
    if (r && r.condition && r.condition.regexFilter) {
      removedRegex++;
      continue;
    }
    filtered.push(r);
  }

  return { rules: filtered, removedUnsafe, removedRegex };
}

// ============================================================================
// 转换
// ============================================================================
async function convertFilterSet(text, name) {
  const filter = new Filter(1, text);
  const converter = new FilterConverter();

  // 2.x API: convert 接收 Filter 数组，返回结果数组。
  // 每个元素形如 { ruleset, errors, limitations }。
  const results = await converter.convert([filter]);
  if (!Array.isArray(results) || !results.length) {
    throw new Error(`converter.convert 返回空结果（${name}）`);
  }

  const { ruleset, errors, limitations } = results[0];

  if (!ruleset || typeof ruleset.getDeclarativeRules !== 'function') {
    throw new Error(`converter 返回的 ruleset 缺少 getDeclarativeRules（${name}）`);
  }

  // getDeclarativeRules 在 2.x 中同步返回 DeclarativeRule[]；
  // 用 await 包一层，兼容未来可能的异步化，无副作用。
  let rules = await ruleset.getDeclarativeRules();
  if (!Array.isArray(rules)) rules = [];

  reportIssues(name, errors, '规则无法转换，已跳过');
  reportIssues(name, limitations, '规则受 MV3 限制');

  // ---- 过滤 unsafe 动作 + 正则 ----
  const { rules: safeRules, removedUnsafe, removedRegex } = filterForStaticRuleset(rules);
  if (removedUnsafe > 0) {
    console.warn(
      `[build-rules] ${name}: 移除 ${removedUnsafe} 条 unsafe 规则 ` +
      `(redirect/modifyHeaders) —— 静态规则集不支持这些动作`
    );
  }
  if (removedRegex > 0) {
    console.warn(
      `[build-rules] ${name}: 移除 ${removedRegex} 条正则规则 ` +
      `(regexFilter) —— 静态规则集正则配额有限`
    );
  }

  rules = safeRules;

  // ---- 截断 ----
  if (rules.length > MAX_RULES_PER_SET) {
    console.warn(
      `[build-rules] ${name}: 过滤后 ${rules.length} 条，` +
      `截断到 ${MAX_RULES_PER_SET} 条（MAX_RULES_PER_SET）`
    );
    rules = rules.slice(0, MAX_RULES_PER_SET);
  }

  return rules;
}

// ============================================================================
// 主流程
// ============================================================================
async function main() {
  mkdirSync(join(ROOT, 'rules'), { recursive: true });

  let totalRules = 0;

  for (const rs of RULESETS) {
    const text = loadFilterText(rs.source);
    if (text === null) continue;

    console.log(`[build-rules] 转换 ${rs.id} ...`);
    const rules = await convertFilterSet(text, rs.id);

    writeFileSync(rs.output, JSON.stringify(rules, null, 2), 'utf8');
    totalRules += rules.length;

    console.log(`[build-rules] ${rs.id}: ${rules.length} 条 DNR 规则 → ${rs.output}`);
  }

  console.log(`[build-rules] 完成，共 ${totalRules} 条规则`);

  if (totalRules > 30000) {
    console.warn(
      `[build-rules] 警告：总规则数 ${totalRules} 超过 30,000，` +
      `同时启用所有规则集时可能导致 updateEnabledRulesets 失败或规则被裁剪。` +
      `默认只启用 easylist，通常不受影响；如需同时启用，考虑拆分规则集。`
    );
  }
}

main().catch((e) => {
  console.error('[build-rules] 失败', e);
  process.exit(1);
});
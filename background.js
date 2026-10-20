// ============ 依赖 ============
// psl.js 已不再被 background 使用（"是否第三方"改由 DNR 的 domainType 判断）；
// 它仍由 popup.html 单独加载，用于白名单输入校验。
// 跨浏览器：Chromium（Chrome / Edge / Opera）的 service worker 用 importScripts 加载依赖；
// Firefox 的 event page 没有 importScripts，改由 manifest 的 background.scripts 按顺序预先加载
// （见 manifest.firefox.json，budget-manager.js 与转换器必须排在 background.js 之前）。
// 两种环境下得到的全局变量完全一样。
const CAN_IMPORT_SCRIPTS = typeof importScripts === 'function';
try { if (CAN_IMPORT_SCRIPTS) importScripts('budget-manager.js'); }
catch (e) { console.error('[Domain Firewall] 基础依赖加载失败', e); }
try { if (CAN_IMPORT_SCRIPTS) importScripts('dnr-converter.bundle.js'); }
catch (e) { console.warn('[Domain Firewall] 转换器未加载（运行 npm run build:converter）', e); }
if (typeof BudgetLedger === 'undefined') {
  console.error('[Domain Firewall] budget-manager.js 未加载：Firefox 需要把它列在 manifest 的 background.scripts 里，并排在 background.js 之前');
}

// ============ 常量 ============
const RULE_ID = 1; // CORE：唯一的防火墙拦截规则
const MAX_LOGS = 800;
const MAX_BODY_CHARS = 8000;
const LOG_FLUSH_DELAY_MS = 100;
const LOG_FLUSH_MAX = 50;

const SWEEP_ALARM_NAME = 'df-transient-sweep';
const SWEEP_INTERVAL_MIN = 5;
const SWEEP_INITIAL_DELAY_MIN = 1;
const TRANSIENT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_TTL_MIN_MS = 60 * 1000;
const TRANSIENT_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const BATCH_MAX_LINES = 500;
const BATCH_PROGRESS_KEY = 'batch-progress';
const BATCH_PROGRESS_SAVE_INTERVAL = 1000;

const RULESET_IDS = ['easylist', 'adguard-base'];

const pendingRequests = new Map();

// ---- 记录模式的隐私开关（storage 键；保存前始终做脱敏）----
// recordRequestBody：是否保存请求体。默认值集中在这里，想默认关闭改成 false 即可。
// redactUrl：是否遮掉 URL 查询参数里的敏感值（token / code / key ...），默认开启。
const RECORD_BODY_DEFAULT = true;
let recordBodyEnabled = null; // null = 尚未读到，按"不保存"处理（失败关闭）
let redactUrlEnabled = true;  // 未读到时按"遮"处理（失败关闭）

let recordConfigReady = null;
function ensureRecordConfig() {
  if (!recordConfigReady) {
    recordConfigReady = chrome.storage.local
      .get({ recordRequestBody: RECORD_BODY_DEFAULT, redactUrl: true })
      .then(v => {
        recordBodyEnabled = !!v.recordRequestBody;
        redactUrlEnabled = v.redactUrl !== false;
      })
      .catch(() => { recordBodyEnabled = false; redactUrlEnabled = true; });
  }
  return recordConfigReady;
}

// ============ 状态 ============
async function getState() {
  return chrome.storage.local.get({ mode: 'block', whitelist: [] });
}

async function getTransientTtlMs() {
  const { transientTtlMs = TRANSIENT_DEFAULT_TTL_MS } = await chrome.storage.local.get({
    transientTtlMs: TRANSIENT_DEFAULT_TTL_MS
  });
  const v = Number(transientTtlMs);
  if (!Number.isFinite(v)) return TRANSIENT_DEFAULT_TTL_MS;
  return Math.max(TRANSIENT_TTL_MIN_MS, Math.min(TRANSIENT_TTL_MAX_MS, v));
}

/**
 * 白名单条目 → DNR excludedRequestDomains 可用的形式。
 * 保持用户输入的粒度（cdn.example.com 只放行 cdn.example.com 及其子域，
 * 不再升格为 example.com）。非法输入返回 null 并被忽略。
 * DNR 要求：小写、ASCII（IDN 需转 punycode）、无末尾点；IPv6 不支持。
 */
function normalizeWhitelistEntry(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\.+$/, '');
  if (!s) return null;
  if (/[\/?#@:\\\s]/.test(s)) return null;           // 路径、端口、用户信息、IPv6、空白
  if (/[^\x00-\x7f]/.test(s)) {                       // IDN → punycode
    try { s = new URL('http://' + s + '/').hostname; } catch { return null; }
  }
  if (!s || s.length > 253) return null;
  for (const label of s.split('.')) {                 // 标签 1–63 字符，首尾必须是字母或数字
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return s;
}

function hostMatches(ruleHost, pageHost) {
  if (!ruleHost || !pageHost) return false;
  const r = String(ruleHost).toLowerCase();
  const p = String(pageHost).toLowerCase();
  return p === r || p.endsWith('.' + r);
}

// ============ 队列 ============
function makeQueue() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
}
const dnrQueue = makeQueue();
const applyQueue = makeQueue();

let pendingRulesUpdate = null;
function scheduleRulesUpdate() {
  if (pendingRulesUpdate) return pendingRulesUpdate;
  pendingRulesUpdate = dnrQueue(async () => {
    pendingRulesUpdate = null;
    await updateFirewallRulesInternal();
  });
  return pendingRulesUpdate;
}

// ============ CORE ============
// 拦截判定完全交给浏览器：
//   - domainType: 'thirdParty'：请求域名与「发起请求的页面」的可注册域名（eTLD+1）不同才命中。
//     不再依赖活动标签页，因此没有"跨域跳转 / 切标签时规则滞后"的竞态，后台标签页也不会被误拦，
//     而且用的是 Chrome 自带的 PSL，不再受 psl.js 覆盖范围限制。
//   - excludedRequestDomains：全局白名单，按用户输入的粒度匹配（该域名及其所有子域名）。
// 规则只随 mode / whitelist 变化，所以不再监听 tabs 事件。
const FIREWALL_RESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script',
  'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'other'
]; // 不含 main_frame：顶层导航放行

async function buildFirewallRulesPayload() {
  const { mode, whitelist } = await getState();
  if (mode !== 'block') return { addRules: [], removeRuleIds: [RULE_ID] };

  const allowed = new Set();
  for (const w of Array.isArray(whitelist) ? whitelist : []) {
    const d = normalizeWhitelistEntry(w);
    if (d) allowed.add(d);
  }

  const condition = {
    domainType: 'thirdParty',
    resourceTypes: FIREWALL_RESOURCE_TYPES.slice()
  };
  // excludedRequestDomains 不能是空数组，白名单为空时整个字段省略
  if (allowed.size) condition.excludedRequestDomains = [...allowed];

  return {
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: { type: 'block' },
      condition
    }]
  };
}

async function getExistingFirewallRules() {
  try {
    // 有的浏览器可能忽略 ruleIds 过滤并返回全部规则，所以结果再按 id 过滤一次
    const rules = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: [RULE_ID] });
    return rules.filter(r => r.id === RULE_ID);
  } catch (e) {
    const all = await chrome.declarativeNetRequest.getDynamicRules();
    return all.filter(r => r.id === RULE_ID);
  }
}

// 只比较我们自己写入的字段：即使 Chrome 以后在返回的规则里补默认字段，
// 也不会让"规则没变就不写"的优化失效。给 CORE 规则新增字段时，记得同步这里。
function ruleKey(r) {
  const c = r.condition || {};
  return JSON.stringify({
    id: r.id,
    priority: r.priority,
    action: r.action && r.action.type,
    condition: {
      domainType: c.domainType || null,
      excludedRequestDomains: [...(c.excludedRequestDomains || [])].sort(),
      resourceTypes: [...(c.resourceTypes || [])].sort(),
    },
  });
}

function sameRules(a, b) {
  if (a.length !== b.length) return false;
  const ka = a.map(ruleKey).sort();
  const kb = b.map(ruleKey).sort();
  return ka.every((x, i) => x === kb[i]);
}

async function updateFirewallRulesInternal() {
  try {
    await ensureBudgetReady();
    const payload = await buildFirewallRulesPayload();

    // 规则没变就不写：每次 updateDynamicRules 浏览器都会重建整个动态规则集
    // （CUSTOM 规则多时很重），而 SW 每次唤醒都会走到这里。
    const existing = await getExistingFirewallRules();
    if (sameRules(existing, payload.addRules)) return;

    const res = await admitAndApplyInternal('CORE', payload);
    if (!res.ok) {
      console.warn('[Domain Firewall] CORE 规则被预算拒绝:', res.reason);
      return;
    }
    const rule = payload.addRules[0];
    if (rule) {
      const wl = rule.condition.excludedRequestDomains || [];
      console.log('[Domain Firewall] 拦截规则已更新，白名单:', wl.join(', ') || '（空）');
    } else {
      console.log('[Domain Firewall] 拦截规则已移除（非拦截模式）');
    }
  } catch (e) {
    console.error('[Domain Firewall] 更新规则失败', e);
  }
}

// ============ 通用规则释放 ============
// 返回值约定：
//   ok === true  → released 为「已确认不再占用 DNR」的全部 ID（包括本来就不在 DNR 里的）
//   ok === false → released 恒为 []，调用方不得据此更新任何记录
async function releaseIdsFromPool(pool, ids) {
  const uniqueIds = [...new Set(
    (Array.isArray(ids) ? ids : []).filter(id => Number.isInteger(id) && id > 0)
  )];
  if (!uniqueIds.length) return { ok: true, released: [] };
  await ensureBudgetReady();

  // 查询与删除放在同一个队列任务里，中间不会插入其他规则变更。
  // （admitAndApplyInternal 本身不取队列，不会死锁。）
  return dnrQueue(async () => {
    let existing;
    try {
      existing = await chrome.declarativeNetRequest.getDynamicRules();
    } catch (e) {
      // 无法确认当前规则状态时失败关闭：不去"盲删"
      console.error('[Domain Firewall] getDynamicRules 失败，放弃释放', e);
      return { ok: false, released: [], reason: 'get_dynamic_rules_failed' };
    }
    const existingIds = new Set(existing.map(r => r.id));
    const toRemove = uniqueIds.filter(id => existingIds.has(id));
    if (!toRemove.length) return { ok: true, released: uniqueIds };

    const res = await admitAndApplyInternal(pool, { addRules: [], removeRuleIds: toRemove });
    return res.ok
      ? { ok: true, released: uniqueIds }
      : { ok: false, released: [], reason: res.reason };
  });
}

async function releaseTransientIds(ids) {
  return releaseIdsFromPool('TRANSIENT', ids);
}

// ============ TRANSIENT ============
// DNR urlFilter 不是字面量比较：* ^ | 有特殊含义，且不加锚点时是"子串匹配"
// （会命中把该 URL 嵌在查询串里的其他请求）。这里：
//   1. 只接受 http(s)，丢掉 #hash；
//   2. 用起始锚点 "|" 做前缀匹配（?v=2 之类的缓存参数变体仍会命中）；
//   3. URL 里出现 * ^ | 时在该处截断，避免被当成通配语法。
function toPickerUrlFilter(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  const prefix = u.href.split(/[*^|]/)[0];
  if (prefix.length < u.origin.length) return null;
  return '|' + prefix;
}

function buildPickerDnrRule(record, id) {
  const urlFilter = toPickerUrlFilter(record.url);
  if (!urlFilter) throw new Error('URL 无法转换为拦截规则');
  return {
    id,
    priority: 5000,
    action: { type: 'block' },
    condition: {
      urlFilter,
      resourceTypes: [
        'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
        'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
      ]
    }
  };
}

async function applyPickerDnrRule(record) {
  if (!toPickerUrlFilter(record.url)) throw new Error('URL 无法转换为拦截规则');  // 先校验，避免白白占用 ID
  await ensureBudgetReady();
  return dnrQueue(async () => {
    const ledger = getBudgetLedger();
    const id = ledger.allocateRuleId('TRANSIENT');
    const rule = buildPickerDnrRule(record, id);
    const res = await admitAndApplyInternal('TRANSIENT', { addRules: [rule], removeRuleIds: [] });
    if (!res.ok) throw new Error('预算拒绝: ' + res.reason);
    return id;
  });
}

// ============ 记录模式 ============
// 发起者：Chromium 提供 details.initiator（源）；Firefox 没有，改用 originUrl / documentUrl 取其源。
function getInitiator(details) {
  if (details.initiator) return details.initiator;
  const u = details.originUrl || details.documentUrl;
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
}

// ---- 脱敏 ----
// 按 key 名脱敏（宁可多遮：author 之类的也会被遮，不影响排错）。
const SENSITIVE_KEY_RE = /(pass(word|wd)?|pwd|secret|token|auth|cookie|credential|(api|access|private)[-_]?key|session|jwt|otp|cvv|cvc|card[-_]?(number|no)|ssn)/i;
// URL 查询参数额外按"整名"匹配（这些词太泛，不适合做子串匹配）
const URL_SENSITIVE_RE = new RegExp(SENSITIVE_KEY_RE.source + '|^(?:code|key|sig|signature|sid|ticket|state)$', 'i');
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);
const REDACTED = '[redacted]';

function redactDeep(v, depth = 0) {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactDeep(val, depth + 1);
  }
  return out;
}

/**
 * 文本请求体脱敏，失败关闭：
 *   JSON            → 解析后按 key 脱敏；被截断 / 解析失败 → 正则兜底
 *   key=value&...   → 逐对脱敏
 *   其他（含多行文本、XML、未知格式）→ 不保存内容，只留长度
 */
function redactBodyText(text) {
  const t = String(text).trim();
  if (!t) return t;
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.stringify(redactDeep(JSON.parse(t))); } catch { /* 走兜底 */ }
    return t.replace(
      /("[^"]*(?:pass|pwd|secret|token|auth|cookie|credential|key|session|jwt|otp|cvv|cvc|ssn)[^"]*"\s*:\s*)("(?:[^"\\]|\\.)*"|"(?:[^"\\]|\\.)*$|[^,}\]\s]+)/gi,
      '$1"' + REDACTED + '"'
    );
  }
  // urlencoded：只要有以 key= 开头的段、且没有换行，就逐对解析
  // （不要求整串无空白：非标准编码里值含空格也能被识别）
  if (!/[\r\n]/.test(t) && /(^|&)[^&=\s]+=/.test(t)) {
    try {
      const parts = [];
      for (const [k, v] of new URLSearchParams(t)) {
        parts.push(encodeURIComponent(k) + '=' + (SENSITIVE_KEY_RE.test(k) ? REDACTED : encodeURIComponent(v)));
      }
      return parts.join('&');
    } catch { /* 落到下面的失败关闭 */ }
  }
  return `[omitted: unrecognized body format, ${t.length} chars]`;
}

/** 遮掉 URL 查询参数里的敏感值；保留 scheme/host/path 和其他参数的原始编码。 */
function redactUrl(raw) {
  if (!redactUrlEnabled || typeof raw !== 'string') return raw;
  const qi = raw.indexOf('?');
  if (qi < 0) return raw;
  const hi = raw.indexOf('#', qi);
  const head = raw.slice(0, qi + 1);
  const query = hi < 0 ? raw.slice(qi + 1) : raw.slice(qi + 1, hi);
  const tail = hi < 0 ? '' : raw.slice(hi);
  const out = query.split('&').map(pair => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    let key = pair.slice(0, eq);
    try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* 保持原样 */ }
    return URL_SENSITIVE_RE.test(key) ? pair.slice(0, eq + 1) + REDACTED : pair;
  }).join('&');
  return head + out + tail;
}

function redactHeaders(list) {
  if (!Array.isArray(list)) return list;
  return list.map(h =>
    h && SENSITIVE_HEADERS.has(String(h.name).toLowerCase())
      ? { name: h.name, value: REDACTED }
      : h
  );
}

function finalizeLog(log) {
  log.url = redactUrl(log.url);
  log.requestHeaders = redactHeaders(log.requestHeaders);
  log.responseHeaders = redactHeaders(log.responseHeaders);
  return log;
}

function serializeRequestBody(body) {
  if (!recordBodyEnabled) return null;
  try {
    const out = {};
    if (body.formData) out.formData = redactDeep(body.formData);
    if (body.raw) {
      // body.raw 的元素是 UploadData：{ bytes?: ArrayBuffer, file?: string }，不是 ArrayBuffer 本身
      out.raw = body.raw.map(part => {
        if (part && part.bytes) {
          try {
            const len = Math.min(part.bytes.byteLength, MAX_BODY_CHARS);
            const text = new TextDecoder('utf-8').decode(new Uint8Array(part.bytes, 0, len));
            const bad = (text.match(/\uFFFD/g) || []).length;
            if (text.includes('\u0000') || bad > text.length * 0.1) {
              return `[binary ${part.bytes.byteLength} bytes]`;
            }
            return redactBodyText(text);
          } catch { return '[binary]'; }
        }
        if (part && part.file) return '[file]';
        return '[unknown]';
      });
    }
    let s = JSON.stringify(out);
    if (s.length > MAX_BODY_CHARS) s = s.slice(0, MAX_BODY_CHARS) + '...[truncated]';
    return s;
  } catch {
    return '[无法序列化]';
  }
}

// 部分请求（长连接、事件丢失等）可能始终没有 onCompleted / onErrorOccurred，
// 条目会一直留在 Map 里。超时的当作"已结束但没收到终止事件"落盘并移除；
// 超过上限时按插入顺序（最旧优先）淘汰。5 分钟以上的超长请求会被提前落盘一次，
// 之后真正结束时因条目已不在 Map 而被忽略——这是有意的取舍。
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const PENDING_MAX_ENTRIES = 2000;

function sweepStalePendingRequests() {
  if (!pendingRequests.size) return;
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  let removed = 0;
  const evict = (id, log) => {
    log.error = log.error || 'no_terminal_event';
    enqueueLog(finalizeLog(log));
    pendingRequests.delete(id);
    removed++;
  };
  for (const [id, log] of pendingRequests) {
    if (log.timestamp < cutoff) evict(id, log);
  }
  if (pendingRequests.size > PENDING_MAX_ENTRIES) {
    const target = Math.floor(PENDING_MAX_ENTRIES * 0.9);
    for (const [id, log] of pendingRequests) {
      if (pendingRequests.size <= target) break;
      evict(id, log);
    }
  }
  if (removed) console.warn(`[Domain Firewall] 清理 ${removed} 条未收到终止事件的 pendingRequests`);
}

const logBuffer = [];
let logFlushTimer = null;
let flushing = false;

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => { logFlushTimer = null; flushLogs(); }, LOG_FLUSH_DELAY_MS);
}

async function flushLogs() {
  if (flushing) return;
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (!logBuffer.length) return;
  flushing = true;
  const batch = logBuffer.splice(0, logBuffer.length);
  try {
    const { logs = [] } = await chrome.storage.local.get({ logs: [] });
    logs.push(...batch);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ logs });
  } catch (e) {
    console.error('[Domain Firewall] flush 日志失败', e);
    logBuffer.unshift(...batch);
  } finally {
    flushing = false;
  }
  if (logBuffer.length) scheduleLogFlush();
}

function enqueueLog(log) {
  logBuffer.push(log);
  if (logBuffer.length >= LOG_FLUSH_MAX) flushLogs();
  else scheduleLogFlush();
}

const handlers = {
  onBeforeRequest: (details) => {
    if (pendingRequests.size >= PENDING_MAX_ENTRIES) sweepStalePendingRequests();
    pendingRequests.set(details.requestId, {
      id: details.requestId, timestamp: details.timeStamp, url: details.url,
      method: details.method, type: details.type, tabId: details.tabId,
      frameId: details.frameId, parentFrameId: details.parentFrameId,
      initiator: getInitiator(details),
      requestBody: details.requestBody ? serializeRequestBody(details.requestBody) : null,
      requestHeaders: null, responseHeaders: null, statusCode: null,
      fromCache: false, error: null,
    });
  },
  onBeforeSendHeaders: (details) => {
    const log = pendingRequests.get(details.requestId);
    if (log) log.requestHeaders = details.requestHeaders || null;
  },
  onHeadersReceived: (details) => {
    const log = pendingRequests.get(details.requestId);
    if (log) {
      log.responseHeaders = details.responseHeaders || null;
      log.statusCode = details.statusCode;
    }
  },
  onCompleted: (details) => {
    const log = pendingRequests.get(details.requestId);
    if (log) {
      log.statusCode = details.statusCode;
      log.fromCache = details.fromCache;
      enqueueLog(finalizeLog(log));
      pendingRequests.delete(details.requestId);
    }
  },
  onErrorOccurred: (details) => {
    const log = pendingRequests.get(details.requestId);
    if (log) {
      log.error = details.error;
      enqueueLog(finalizeLog(log));
      pendingRequests.delete(details.requestId);
    }
  },
};

let recordRegistered = false;

async function registerRecordListeners() {
  if (recordRegistered) return;
  await ensureRecordConfig();   // 先读完隐私开关，监听器一启用就按它执行
  if (recordRegistered) return;
  const f = { urls: ['<all_urls>'] };
  try {
    chrome.webRequest.onBeforeRequest.addListener(handlers.onBeforeRequest, f, ['requestBody']);
    chrome.webRequest.onBeforeSendHeaders.addListener(handlers.onBeforeSendHeaders, f, ['requestHeaders']);
    chrome.webRequest.onHeadersReceived.addListener(handlers.onHeadersReceived, f, ['responseHeaders']);
    chrome.webRequest.onCompleted.addListener(handlers.onCompleted, f);
    chrome.webRequest.onErrorOccurred.addListener(handlers.onErrorOccurred, f);
    recordRegistered = true;
    console.log('[Domain Firewall] 记录模式监听器已注册');
  } catch (e) {
    console.error('[Domain Firewall] 注册监听器失败', e);
  }
}

function unregisterRecordListeners() {
  if (!recordRegistered) return;
  try {
    chrome.webRequest.onBeforeRequest.removeListener(handlers.onBeforeRequest);
    chrome.webRequest.onBeforeSendHeaders.removeListener(handlers.onBeforeSendHeaders);
    chrome.webRequest.onHeadersReceived.removeListener(handlers.onHeadersReceived);
    chrome.webRequest.onCompleted.removeListener(handlers.onCompleted);
    chrome.webRequest.onErrorOccurred.removeListener(handlers.onErrorOccurred);
  } catch (e) { /* ignore */ }
  pendingRequests.clear();
  recordRegistered = false;
  console.log('[Domain Firewall] 记录模式监听器已注销');
}

// MV3 的 SW 休眠后，只有「在脚本顶层同步注册」的监听器才能唤醒它；而 registerRecordListeners
// 要先异步读取模式才注册，休眠后新请求唤醒不了 SW。
// 解决：在顶层常驻一个极轻量的 main_frame 监听器（每次顶层导航至多触发一次）当唤醒源，
// 唤醒后立刻按当前模式补注册完整的记录监听器。
// 为什么不把全部监听器常驻：那样 block/off 模式下每个请求都会唤醒 SW，开销太大。
// 已知代价：唤醒那一次导航的 main_frame 请求本身，以及注册完成前的极少数请求可能漏记。
let ensuringRecord = false;
function ensureRecordState() {
  if (recordRegistered || ensuringRecord) return;   // 连开多个标签时不重复排队
  ensuringRecord = true;
  applyQueue(async () => {
    if (recordRegistered) return;
    const { mode } = await getState();
    if (mode === 'record') await registerRecordListeners();
  })
    .catch(e => console.error('[Domain Firewall] 唤醒后注册记录监听器失败', e))
    .finally(() => { ensuringRecord = false; });
}

// ============ 模式应用 ============
function applyMode() {
  return applyQueue(async () => {
    const { mode } = await getState();
    if (mode === 'record') {
      await registerRecordListeners();   // 幂等；已注册时不再注销重注册，避免清空进行中的 pendingRequests
    } else {
      unregisterRecordListeners();
    }
    await scheduleRulesUpdate();
    await applyRulesets();
  });
}

// ============ 元素拾取记录 ============
async function getPickerRules() {
  const { pickerRules = [] } = await chrome.storage.local.get({ pickerRules: [] });
  return pickerRules;
}
async function setPickerRules(rules) {
  await chrome.storage.local.set({ pickerRules: rules });
}

async function broadcastCosmeticUpdate() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, { type: 'cosmetic-updated' }).catch(() => {});
  }
}

async function addPickerRecord(msg) {
  const { advancedMode = false } = await chrome.storage.local.get({ advancedMode: false });
  const rules = await getPickerRules();
  const record = {
    id: 'pick_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    hostname: msg.hostname, selector: msg.selector, url: msg.url || null,
    dnrRuleIds: [], expiresAt: null, dnrExpired: false,
    createdAt: Date.now(), active: true,
  };
  let netError = null;   // 高级模式下"网络拦截没写进去"的原因，交给 UI 提示
  if (advancedMode && record.url) {
    const ttl = await getTransientTtlMs();
    try {
      const id = await applyPickerDnrRule(record);
      record.dnrRuleIds.push(id);
      record.expiresAt = Date.now() + ttl;
    } catch (e) {
      console.warn('[Domain Firewall] 生成网络拦截规则失败', e);
      netError = (e && e.message) ? e.message : String(e);
    }
  }
  rules.push(record);
  await setPickerRules(rules);
  broadcastCosmeticUpdate();
  return { record, netError };
}

async function removePickerRecord(id) {
  const rules = await getPickerRules();
  const rec = rules.find(r => r.id === id);
  if (!rec) return;
  if (rec.dnrRuleIds && rec.dnrRuleIds.length) {
    try {
      const res = await releaseTransientIds(rec.dnrRuleIds);
      if (!res.ok) throw new Error(res.reason || 'release_failed');
    } catch (e) {
      console.warn('[Domain Firewall] 释放拾取网络规则失败，保留记录以便重试', e);
      return;
    }
  }
  await setPickerRules(rules.filter(r => r.id !== id));
  broadcastCosmeticUpdate();
}

async function togglePickerRecord(id, active) {
  const rules = await getPickerRules();
  const rec = rules.find(r => r.id === id);
  if (!rec) return;

  const needsRearm = active && rec.url && (!rec.dnrRuleIds || !rec.dnrRuleIds.length);
  if (needsRearm) {
    const ttl = await getTransientTtlMs();
    try {
      const newId = await applyPickerDnrRule(rec);
      rec.dnrRuleIds = [newId];
      rec.expiresAt = Date.now() + ttl;
      rec.dnrExpired = false;
      rec.active = true;
      await setPickerRules(rules);
      broadcastCosmeticUpdate();
    } catch (e) {
      console.warn('[Domain Firewall] 重建拾取网络规则失败', e);
    }
    return;
  }

  if (rec.active === active) return;
  rec.active = active;

  if (!active && rec.dnrRuleIds && rec.dnrRuleIds.length) {
    try {
      const res = await releaseTransientIds(rec.dnrRuleIds);
      if (!res.ok) throw new Error(res.reason || 'release_failed');
    } catch (e) {
      console.warn('[Domain Firewall] 释放拾取网络规则失败', e);
      rec.active = true;
      await setPickerRules(rules);
      return;
    }
    rec.dnrRuleIds = [];
    rec.expiresAt = null;
  }
  await setPickerRules(rules);
  broadcastCosmeticUpdate();
}

// ============ TRANSIENT sweep ============
async function sweepExpiredTransientRules() {
  sweepStalePendingRequests();
  const rules = await getPickerRules();
  const now = Date.now();
  const expiredRecs = [];
  const staleIds = new Set();

  for (const rec of rules) {
    if (!rec.dnrRuleIds || !rec.dnrRuleIds.length) continue;
    if (rec.expiresAt && rec.expiresAt <= now) {
      expiredRecs.push(rec);
      for (const id of rec.dnrRuleIds) staleIds.add(id);
    }
  }
  if (!expiredRecs.length) return;

  const idList = [...staleIds];
  let released;
  try {
    const res = await releaseTransientIds(idList);
    if (!res.ok) {
      // 释放失败：DNR 里的规则还在，记录保持原样，下次 sweep 重试
      console.warn('[Domain Firewall] sweep 释放被拒绝:', res.reason);
      return;
    }
    released = new Set(res.released);
  } catch (e) {
    console.error('[Domain Firewall] sweep 释放失败', e);
    return;
  }

  let changed = false;
  for (const rec of expiredRecs) {
    const stillHave = (rec.dnrRuleIds || []).filter(id => !released.has(id));
    if (stillHave.length) { rec.dnrRuleIds = stillHave; continue; }
    rec.dnrRuleIds = [];
    rec.dnrExpired = true;
    changed = true;
  }
  if (changed) {
    await setPickerRules(rules);
    console.log(`[Domain Firewall] sweep 释放 ${released.size} 条过期 TRANSIENT 规则`);
  }
}

async function ensureSweepAlarm() {
  try {
    const existing = await chrome.alarms.get(SWEEP_ALARM_NAME);
    if (existing) return;
    await chrome.alarms.create(SWEEP_ALARM_NAME, {
      delayInMinutes: SWEEP_INITIAL_DELAY_MIN,
      periodInMinutes: SWEEP_INTERVAL_MIN,
    });
  } catch (e) {
    console.error('[Domain Firewall] 创建 sweep alarm 失败', e);
  }
}

// ============ 静态规则集 ============
async function getEnabledRulesets() {
  const { enabledRulesets = ['easylist'] } = await chrome.storage.local.get({
    enabledRulesets: ['easylist'],
  });
  return enabledRulesets.filter(id => RULESET_IDS.includes(id));
}

async function applyRulesets() {
  const enabled = await getEnabledRulesets();
  const all = new Set(RULESET_IDS);
  const disableRulesetIds = [...all].filter(id => !enabled.includes(id));
  const enableRulesetIds = enabled.filter(id => all.has(id));
  try {
    // 已经是目标状态就不重复调用（SW 每次唤醒都会走到这里）
    const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
    const enableDelta = enableRulesetIds.filter(id => !current.has(id));
    const disableDelta = disableRulesetIds.filter(id => current.has(id));
    if (!enableDelta.length && !disableDelta.length) return;
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enableDelta, disableRulesetIds: disableDelta,
    });
    console.log('[Domain Firewall] 规则集已更新，启用:', enableRulesetIds.join(', ') || '（无）');
  } catch (e) {
    console.error('[Domain Firewall] 更新规则集失败', e);
  }
}

// ============ 批次进度存储 ============
const progressStorage = {
  async save(data) {
    try {
      await chrome.storage.session.set({ [BATCH_PROGRESS_KEY]: data });
    } catch (e) {
      console.warn('[Domain Firewall] 保存批次进度失败', e);
    }
  },
  async load() {
    try {
      const r = await chrome.storage.session.get({ [BATCH_PROGRESS_KEY]: null });
      return r[BATCH_PROGRESS_KEY];
    } catch (e) { return null; }
  },
  async clear() {
    try { await chrome.storage.session.remove(BATCH_PROGRESS_KEY); }
    catch (e) { /* ignore */ }
  },
};

let lastProgressSaveAt = 0;
async function maybeSaveProgress(force, data) {
  const now = Date.now();
  if (!force && now - lastProgressSaveAt < BATCH_PROGRESS_SAVE_INTERVAL) return;
  lastProgressSaveAt = now;
  await progressStorage.save(data);
}

// ============ 规则签名（去重用） ============
function normalizeForSig(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    const normalized = obj.map(normalizeForSig);
    if (obj.every(x => typeof x === 'string' || typeof x === 'number')) normalized.sort();
    return normalized;
  }
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = normalizeForSig(obj[k]);
  return out;
}

function stripForSig(rule) {
  const { id, priority, ...rest } = rule;
  return rest;
}

function ruleSignature(rule) {
  return JSON.stringify({
    c: normalizeForSig(rule.condition || {}),
    a: normalizeForSig(rule.action || {}),
  });
}

// ============ 活跃批次锁 ============
const batchLock = {
  id: null,
  tryLock(batchId) {
    if (this.id) return false;
    this.id = batchId;
    return true;
  },
  unlock() { this.id = null; },
};

// ============ CUSTOM：转换器（2.x API） ============
let __converter = null;

async function ensureConverter() {
  if (__converter) return __converter;
  if (!self.DnrConverter || !self.DnrConverter.FilterConverter) {
    throw new Error('转换器未加载（dnr-converter.bundle.js）');
  }
  // 2.x：FilterConverter 构造无参数
  __converter = new self.DnrConverter.FilterConverter();
  return __converter;
}

function makeFilter(id, text) {
  const F = self.DnrConverter.Filter;
  if (!F) throw new Error('DnrConverter.Filter 不可用');
  if (typeof F.fromText === 'function') return F.fromText(text);
  return new F(id, text);
}

/**
 * 用 2.x API 转换单行文本。
 * 返回 { ok, rules, errors } 或抛出异常。
 */
async function convertSingleLine(converter, cid, line) {
  const filter = makeFilter(cid, line);
  const results = await converter.convert([filter]);
  if (!Array.isArray(results) || !results.length) {
    return { ok: false, reason: 'no_result', errors: ['converter.convert 返回空数组'] };
  }
  const first = results[0] || {};
  const { ruleset, errors, limitations } = first;

  if (!ruleset || typeof ruleset.getDeclarativeRules !== 'function') {
    return { ok: false, reason: 'no_ruleset', errors: ['ruleset 缺少 getDeclarativeRules'] };
  }

  let rules = await ruleset.getDeclarativeRules();
  if (!Array.isArray(rules)) rules = [];

  if (errors && errors.length) {
    return { ok: false, reason: 'conversion_failed', errors, limitations };
  }
  if (!rules.length) {
    return { ok: false, reason: 'no_dnr_rule', errors: [], limitations };
  }
  return { ok: true, rules, limitations };
}

function parseFilterLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('!')) continue;
    if (line.startsWith('[') && line.endsWith(']')) continue;
    out.push(line);
  }
  return [...new Set(out)];
}

async function getCustomRules() {
  const { customRules = [] } = await chrome.storage.local.get({ customRules: [] });
  return customRules;
}
async function setCustomRules(rules) {
  await chrome.storage.local.set({ customRules: rules });
}
async function getCustomBatches() {
  const { customBatches = [] } = await chrome.storage.local.get({ customBatches: [] });
  return customBatches;
}
async function setCustomBatches(batches) {
  await chrome.storage.local.set({ customBatches: batches });
}

function makeCancelledResult(partialSucceeded, failed) {
  return {
    ok: false, reason: 'cancelled', cancelled: true,
    succeeded: 0, conversionFailed: failed.length,
    convertPartial: partialSucceeded,
    failed, rejectedByBudget: [],
  };
}

async function addCustomFiltersBatch({ text, atomic = false, onProgress, signal, resumeState = null } = {}) {
  await ensureBudgetReady();

  // —— 恢复 / 新批次初始化 ——
  let batchId, lines, succeeded, failed, startIdx, startedAt;
  if (resumeState) {
    batchId = resumeState.batchId;
    text = resumeState.text;
    atomic = !!resumeState.atomic;
    startedAt = resumeState.startedAt || Date.now();
    lines = parseFilterLines(text);
    succeeded = Array.isArray(resumeState.succeeded) ? resumeState.succeeded.slice() : [];
    failed = Array.isArray(resumeState.failed) ? resumeState.failed.slice() : [];
    startIdx = resumeState.current || 0;
    if (lines.length !== resumeState.total ||
        !Number.isInteger(startIdx) || startIdx < 0 || startIdx > lines.length) {
      succeeded = [];
      failed = [];
      startIdx = 0;
    }
    const existingBatches = await getCustomBatches();
    if (existingBatches.find(b => b.id === batchId)) {
      await progressStorage.clear();
      return { ok: true, alreadyCompleted: true, batchId, succeeded: 0, conversionFailed: 0, budgetRejected: 0, deduped: 0 };
    }
  } else {
    batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    startedAt = Date.now();
    lines = parseFilterLines(text);
    succeeded = [];
    failed = [];
    startIdx = 0;
  }

  if (!lines.length) return { ok: false, reason: 'empty' };
  if (lines.length > BATCH_MAX_LINES) {
    return { ok: false, reason: 'too_many_lines', limit: BATCH_MAX_LINES, actual: lines.length };
  }

  if (!batchLock.tryLock(batchId)) {
    return { ok: false, reason: 'batch_in_progress', activeBatchId: batchLock.id };
  }

  try {
    const progress = {
      batchId, text, atomic, startedAt,
      total: lines.length, current: startIdx, phase: 'convert',
      succeeded, failed,
      cancelled: false, completed: false,
    };
    await maybeSaveProgress(true, progress);
    if (onProgress) onProgress({ phase: 'parse', total: lines.length, resumeFrom: startIdx });

    // —— 转换阶段（2.x API） ——
    let converter;
    try { converter = await ensureConverter(); }
    catch (e) {
      await progressStorage.clear();
      return { ok: false, reason: 'converter_unavailable', error: String(e) };
    }
    let cid = 1;

    for (let i = startIdx; i < lines.length; i++) {
      if (signal && signal.cancelled) {
        await progressStorage.clear();
        return makeCancelledResult(succeeded.length, failed);
      }
      const line = lines[i];
      try {
        const conv = await convertSingleLine(converter, cid++, line);
        if (conv.ok) {
          succeeded.push({ line, rules: conv.rules });
        } else {
          failed.push({
            line,
            reason: conv.reason,
            errors: conv.errors || [],
            limitations: conv.limitations || [],
          });
        }
      } catch (e) {
        failed.push({ line, reason: 'exception', errors: [String(e)] });
      }
      progress.current = i + 1;
      await maybeSaveProgress(false, progress);
      if (onProgress) onProgress({ phase: 'convert', current: i + 1, total: lines.length, line });
    }

    if (signal && signal.cancelled) {
      await progressStorage.clear();
      return makeCancelledResult(succeeded.length, failed);
    }

    if (atomic && failed.length > 0) {
      await progressStorage.clear();
      return {
        ok: false, reason: 'atomic_conversion_failed',
        succeeded: 0, conversionFailed: failed.length, failed,
        deduped: 0, dedupedLines: [], rejectedByBudget: [],
      };
    }

    if (!succeeded.length) {
      await progressStorage.clear();
      return {
        ok: false, reason: 'all_failed',
        succeeded: 0, conversionFailed: failed.length, failed,
        deduped: 0, dedupedLines: [], rejectedByBudget: [],
      };
    }

    if (onProgress) onProgress({ phase: 'admit', succeeded: succeeded.length, failed: failed.length });
    progress.phase = 'admit';
    await maybeSaveProgress(true, progress);

    // —— 准入阶段（含去重） ——
    return await dnrQueue(async () => {
      if (signal && signal.cancelled) {
        await progressStorage.clear();
        return makeCancelledResult(succeeded.length, failed);
      }

      const ledger = getBudgetLedger();
      const temp = ledger.snapshot();

      // 构建现有 CUSTOM 规则签名索引 + 已归属记录的 ID 集合
      const existingDnr = await chrome.declarativeNetRequest.getDynamicRules();
      const existingBySig = new Map();
      for (const r of existingDnr) {
        if (inferPoolFromId(r.id) !== 'CUSTOM') continue;
        existingBySig.set(ruleSignature(stripForSig(r)), r);
      }
      const currentRecords = await getCustomRules();
      const ownedIds = new Set();
      for (const r of currentRecords) for (const id of r.dnrRuleIds || []) ownedIds.add(id);

      // 三分类：新规则 / 认领孤儿 / 去重跳过
      const toAdmit = [];
      const toClaim = [];
      const dedupedLines = [];

      for (const { line, rules } of succeeded) {
        const sigs = rules.map(r => ruleSignature(stripForSig(r)));
        const matches = sigs.map(s => existingBySig.get(s));
        if (matches.every(Boolean)) {
          const ids = matches.map(r => r.id);
          if (ids.every(id => ownedIds.has(id))) {
            dedupedLines.push({ line, reason: 'duplicate_existing' });
            continue;
          }
          for (const id of ids) ownedIds.add(id);
          toClaim.push({ line, ids, rules: matches.map(r => ({ ...r })) });
          continue;
        }
        toAdmit.push({ line, rules, sigs });
      }

      if (!toAdmit.length && !toClaim.length) {
        await progressStorage.clear();
        return {
          ok: false,
          reason: dedupedLines.length ? 'all_duplicates' : 'all_failed',
          succeeded: 0, conversionFailed: failed.length, failed,
          deduped: dedupedLines.length, dedupedLines, rejectedByBudget: [],
        };
      }

      if (atomic) {
        let totalCount = 0, totalUnsafe = 0, totalRegex = 0;
        for (const { rules } of toAdmit) {
          const c = analyzeRules(rules);
          totalCount += rules.length;
          totalUnsafe += c.unsafe;
          totalRegex += c.regex;
        }
        if (totalCount > 0) {
          const check = temp.canAdmit('CUSTOM', totalCount, { unsafe: totalUnsafe, regex: totalRegex });
          if (!check.ok) {
            await progressStorage.clear();
            return {
              ok: false, reason: 'atomic_budget_exceeded', budgetReason: check.reason,
              succeeded: 0, conversionFailed: failed.length, failed,
              deduped: dedupedLines.length, dedupedLines,
              rejectedByBudget: toAdmit.map(s => ({ line: s.line, reason: check.reason })),
            };
          }
        }
      }

      const acceptedLines = [...toClaim.map(x => ({ ...x, isClaimed: true }))];
      const rejectedByBudget = [];

      for (const { line, rules, sigs } of toAdmit) {
        const counts = analyzeRules(rules);
        const check = temp.canAdmit('CUSTOM', rules.length, counts);
        if (!check.ok) {
          if (atomic) {
            await progressStorage.clear();
            return {
              ok: false, reason: 'atomic_budget_exceeded', budgetReason: check.reason,
              succeeded: 0, conversionFailed: failed.length, failed,
              deduped: dedupedLines.length, dedupedLines,
              rejectedByBudget: [{ line, reason: check.reason }],
            };
          }
          rejectedByBudget.push({ line, reason: check.reason });
          continue;
        }
        const ids = [];
        const batchRules = [];
        for (const r of rules) {
          const id = ledger.allocateRuleId('CUSTOM');
          ids.push(id);
          // 保留转换器算出的 priority：它用优先级表达 @@ 例外（≈1e5）、$important（≈1e6）等语义，
          // 统一压成 1000 会让 $important 拦截规则压不过普通例外规则。
          batchRules.push({ ...r, id, priority: r.priority || 1 });
        }
        temp.commit('CUSTOM', batchRules);
        acceptedLines.push({ line, ids, rules: batchRules, isClaimed: false });
      }

      if (!acceptedLines.length) {
        await progressStorage.clear();
        return {
          ok: false, reason: 'budget_exceeded',
          succeeded: 0, conversionFailed: failed.length, failed,
          deduped: dedupedLines.length, dedupedLines,
          budgetRejected: rejectedByBudget.length, rejectedByBudget,
        };
      }

      const newRules = acceptedLines.filter(a => !a.isClaimed).flatMap(a => a.rules);
      if (newRules.length > 0) {
        const res = await admitAndApplyInternal('CUSTOM', { addRules: newRules, removeRuleIds: [] });
        if (!res.ok) {
          await progressStorage.clear();
          return {
            ok: false, reason: res.reason,
            succeeded: 0, conversionFailed: failed.length, failed,
            deduped: dedupedLines.length, dedupedLines,
            budgetRejected: rejectedByBudget.length, rejectedByBudget,
          };
        }
      }

      const now = Date.now();
      const newRecords = acceptedLines.map(({ line, ids }) => ({
        id: 'custom_' + now + '_' + Math.random().toString(36).slice(2, 8),
        batchId, text: line, dnrRuleIds: ids,
        createdAt: now, active: true, stale: false,
      }));
      currentRecords.push(...newRecords);
      await setCustomRules(currentRecords);

      const batches = await getCustomBatches();
      batches.push({
        id: batchId, createdAt: now, totalLines: lines.length,
        succeeded: newRecords.length,
        conversionFailed: failed.length,
        budgetRejected: rejectedByBudget.length,
        deduped: dedupedLines.length,
        atomic,
        failures: [...failed, ...rejectedByBudget],
        dedupedLines,
      });
      await setCustomBatches(batches);

      await progressStorage.clear();

      return {
        ok: true, batchId,
        succeeded: newRecords.length,
        conversionFailed: failed.length,
        budgetRejected: rejectedByBudget.length,
        deduped: dedupedLines.length,
        dnrRuleCount: newRules.length,
        claimedCount: acceptedLines.filter(a => a.isClaimed).length,
        failed, rejectedByBudget, dedupedLines,
      };
    });
  } finally {
    batchLock.unlock();
  }
}

async function removeCustomRule(recordId) {
  const records = await getCustomRules();
  const rec = records.find(r => r.id === recordId);
  if (!rec) return { ok: false, reason: 'not_found' };
  const res = await releaseIdsFromPool('CUSTOM', rec.dnrRuleIds || []);
  if (!res.ok) {
    rec.stale = true;
    await setCustomRules(records);
    return { ok: false, reason: res.reason || 'release_failed' };
  }
  await setCustomRules(records.filter(r => r.id !== recordId));
  return { ok: true };
}

async function removeCustomBatch(batchId) {
  const records = await getCustomRules();
  const inBatch = records.filter(r => r.batchId === batchId);
  if (!inBatch.length) return { ok: false, reason: 'not_found' };
  const ids = inBatch.flatMap(r => r.dnrRuleIds || []);
  const res = await releaseIdsFromPool('CUSTOM', ids);
  if (!res.ok) {
    for (const r of inBatch) r.stale = true;
    await setCustomRules(records);
    return { ok: false, reason: res.reason || 'release_failed' };
  }
  const batches = await getCustomBatches();
  await chrome.storage.local.set({   // 一次写入，避免两次写之间失败留下半截状态
    customRules: records.filter(r => r.batchId !== batchId),
    customBatches: batches.filter(b => b.id !== batchId),
  });
  return { ok: true };
}

// ============ 消息 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    try {
      if (msg.type === 'cosmetic-get') {
        const rules = await getPickerRules();
        const host = msg.hostname || '';
        const matched = rules.filter(r => r.active && hostMatches(r.hostname, host));
        sendResponse({ rules: matched });
      } else if (msg.type === 'picker-add') {
        const { record, netError } = await addPickerRecord(msg);
        sendResponse({ ok: true, record, netError });
      } else if (msg.type === 'picker-remove') {
        await removePickerRecord(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === 'picker-toggle') {
        await togglePickerRecord(msg.id, !!msg.active);
        sendResponse({ ok: true });
      } else if (msg.type === 'picker-list') {
        const rules = await getPickerRules();
        sendResponse({ rules });
      } else if (msg.type === 'budget-snapshot') {
        const snap = await getBudgetSnapshot();
        sendResponse({ ok: true, snapshot: snap });
      } else if (msg.type === 'sweep-now') {
        await sweepExpiredTransientRules();
        sendResponse({ ok: true });
      } else if (msg.type === 'custom-add-batch') {
        const res = await addCustomFiltersBatch({ text: msg.text, atomic: !!msg.atomic });
        sendResponse(res);
      } else if (msg.type === 'custom-add') {
        const res = await addCustomFiltersBatch({ text: msg.text, atomic: false });
        sendResponse(res);
      } else if (msg.type === 'custom-remove') {
        const res = await removeCustomRule(msg.id);
        sendResponse(res);
      } else if (msg.type === 'custom-remove-batch') {
        const res = await removeCustomBatch(msg.batchId);
        sendResponse(res);
      } else if (msg.type === 'custom-list') {
        const rules = await getCustomRules();
        const batches = await getCustomBatches();
        sendResponse({ rules, batches });
      } else if (msg.type === 'batch-progress-get') {
        const progress = await progressStorage.load();
        sendResponse({ ok: true, progress });
      } else if (msg.type === 'batch-progress-discard') {
        await progressStorage.clear();
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// ============ Port：批量导入进度推送 ============
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'custom-batch') return;
  let cancelled = false;
  let started = false;

  const post = (data) => {
    try { port.postMessage(data); } catch { cancelled = true; }
  };

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'cancel') { cancelled = true; return; }

    if (msg.type === 'discard-progress') {
      progressStorage.clear().then(() => post({ type: 'discarded' }));
      return;
    }

    if (msg.type !== 'start' || started) return;
    started = true;

    const signal = { get cancelled() { return cancelled; } };
    (async () => {
      try {
        let resumeState = null;
        if (msg.resume) {
          const prog = await progressStorage.load();
          if (!prog) {
            post({ type: 'error', error: '没有未完成的批次' });
            return;
          }
          resumeState = prog;
        }
        const res = await addCustomFiltersBatch({
          text: msg.text,
          atomic: !!msg.atomic,
          signal,
          onProgress: (p) => post({ type: 'progress', ...p }),
          resumeState,
        });
        post({ type: 'done', result: res });
      } catch (e) {
        post({ type: 'error', error: String(e) });
      }
    })();
  });

  port.onDisconnect.addListener(() => { cancelled = true; });
});

// ============ 事件 ============
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.mode || changes.whitelist) applyMode();
  if (changes.budgetConfig) {
    resetBudgetLedger()
      .then(() => scheduleRulesUpdate())
      .catch(e => console.error('[Domain Firewall] 重建预算账本失败', e));
  }
  if (changes.enabledRulesets) {
    applyRulesets().catch(e => console.error('[Domain Firewall] 应用规则集失败', e));
  }
  if (changes.recordRequestBody) {
    const nv = changes.recordRequestBody.newValue;
    recordBodyEnabled = nv === undefined ? RECORD_BODY_DEFAULT : !!nv;
  }
  if (changes.redactUrl) {
    redactUrlEnabled = changes.redactUrl.newValue !== false;
  }
});

// 顶层同步注册的唤醒源（见 ensureRecordState 的说明）。必须留在脚本顶层，不能放进任何异步回调。
chrome.webRequest.onBeforeRequest.addListener(
  () => { ensureRecordState(); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

// 拦截规则不再依赖活动标签页（见 CORE 一节），因此不再监听 tabs.onActivated / onUpdated。

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SWEEP_ALARM_NAME) return;
  sweepExpiredTransientRules().catch(e => console.error('[Domain Firewall] sweep 失败', e));
});

chrome.runtime.onInstalled.addListener(() => { ensureSweepAlarm(); applyMode(); });
chrome.runtime.onStartup.addListener(() => { ensureSweepAlarm(); applyMode(); });

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => { flushLogs(); });
}

ensureSweepAlarm();
applyMode().catch(e => console.error('[Domain Firewall] applyMode 失败', e));
// ============ 状态读写 ============
async function getState() {
  return chrome.storage.local.get({
    mode: 'block',
    whitelist: [],
    advancedMode: false,
  });
}

// ============ 域名校验（PSL） ============
// 与 background.js 的 normalizeWhitelistEntry 保持同一套规则：
// 输入可以是裸域名、带端口/路径的字符串或完整 URL；中文域名会转成 punycode 后保存
// （DNR 只接受 ASCII 域名）。保存的就是用户填的粒度：cdn.example.com 只放行它自己及其子域名。
function normalizeDomain(input) {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return null;

  let u;
  try {
    // URL 解析会去掉协议 / 端口 / 路径，并把 IDN 转成 punycode；空白、非法端口会直接抛错
    u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch { return null; }
  if (u.username || u.password) return null;      // user@host 之类的写法一律拒绝

  const s = u.hostname.replace(/\.+$/, '');
  if (!s || s.length > 253 || !s.includes('.')) return null;
  for (const label of s.split('.')) {              // 每段 1–63 字符，首尾必须是字母或数字
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  // 公共后缀（co.uk / github.io）不能进白名单：会放行整个后缀下的所有站点
  if (typeof getRootDomain === 'function' && getRootDomain(s) === null) return null;
  return s;
}

// ============ 模式文案 ============
function modeText(mode) {
  return {
    block: '拦截模式：仅允许页面自身站点（含子域名）及白名单通信',
    record: '记录模式：不拦截，记录所有请求',
    off: '关闭：不拦截也不记录',
  }[mode] || mode;
}

// ============ 白名单渲染 ============
function renderWhitelist(list) {
  const box = document.getElementById('whitelist');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="hint">暂无白名单</div>';
    return;
  }
  for (const d of list) {
    const item = document.createElement('div');
    item.className = 'whitelist-item';
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.textContent = '删除';
    btn.onclick = async () => {
      const { whitelist } = await getState();
      await chrome.storage.local.set({
        whitelist: whitelist.filter(x => x !== d),
      });
    };
    item.append(span, btn);
    box.appendChild(item);
  }
}

// ============ 拾取按钮可用性 ============
function setPickerEnabled(enabled, reason) {
  const btn = document.getElementById('pick-element');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.title = enabled ? '' : (reason || '');
}

function isPickableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

// ============ 提示（替代 alert）============
// 弹窗里的 alert() 在不同浏览器里表现不一致（Firefox 的弹窗里可能被吞掉），改用页内提示。
let noticeTimer = null;
function showNotice(text, kind = 'error') {
  const el = document.getElementById('notice');
  if (!el) return;
  el.textContent = text;
  el.className = 'notice ' + kind;
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 9000);
}

// ============ 站点访问权限 ============
// 拦截本身（DNR 的 block）不需要主机权限，但记录模式（webRequest）和元素拾取（content script）需要。
// Chrome / Edge / Opera 用户可以把"网站访问权限"改成"点击时"，Firefox 默认不授予主机权限——两边都可能缺。
async function hasAllSitesAccess() {
  try { return await chrome.permissions.contains({ origins: ['<all_urls>'] }); }
  catch { return true; }   // 无法判断时不打扰用户
}

async function refreshHostWarning() {
  const el = document.getElementById('host-warning');
  if (el) el.hidden = await hasAllSitesAccess();
}

// ============ 初始化 ============
async function init() {
  const state = await getState();

  const radios = document.querySelectorAll('input[name="mode"]');
  const statusEl = document.getElementById('status');
  const refreshStatus = (mode) => {
    statusEl.className = 'status ' + mode;
    statusEl.textContent = modeText(mode);
    radios.forEach(r => { r.checked = r.value === mode; });
  };
  refreshStatus(state.mode);
  radios.forEach(r => {
    r.onchange = async () => {
      if (r.checked) await chrome.storage.local.set({ mode: r.value });
    };
  });

  const domainEl = document.getElementById('current-domain');
  let currentTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;
    if (tab && tab.url) {
      domainEl.textContent = new URL(tab.url).hostname;
    } else {
      domainEl.textContent = '无法解析';
    }
  } catch {
    domainEl.textContent = '无法解析';
  }

  if (!currentTab || !isPickableUrl(currentTab.url)) {
    setPickerEnabled(false, '此页面不支持拾取（仅 http/https）');
  } else {
    setPickerEnabled(true);
  }

  // 缺少"所有网站"访问权限时给出提示与授权入口
  await refreshHostWarning();
  const grantBtn = document.getElementById('grant-host');
  if (grantBtn) {
    grantBtn.onclick = async () => {
      try {
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        if (!granted) showNotice('未授予权限。请按下方说明在浏览器的扩展管理页里手动开启。');
      } catch {
        // Firefox 的弹窗里请求权限可能失败（弹窗会因权限提示失焦而关闭）
        showNotice('无法在弹窗里请求权限，请按下方说明在浏览器的扩展管理页里手动开启。');
      }
      refreshHostWarning();
    };
  }
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(refreshHostWarning);
    chrome.permissions.onRemoved.addListener(refreshHostWarning);
  }

  const advEl = document.getElementById('advanced-mode');
  advEl.checked = !!state.advancedMode;
  advEl.onchange = () => {
    chrome.storage.local.set({ advancedMode: advEl.checked });
  };

  // ---------- 元素拾取：ping 握手 ----------
  document.getElementById('pick-element').onclick = async () => {
    if (!currentTab || !currentTab.id) {
      showNotice('无法获取当前标签页');
      return;
    }

    // 1. 先 ping，确认 content script 已注入
    let alive = false;
    try {
      const pong = await chrome.tabs.sendMessage(currentTab.id, { type: 'ping' });
      alive = (pong === 'pong');
    } catch {
      alive = false;
    }

    if (!alive) {
      if (!(await hasAllSitesAccess())) {
        showNotice('尚未授予「所有网站」访问权限，无法在页面里拾取元素。请先点上方的“授予权限”，或按说明在扩展管理页里开启。');
      } else {
        showNotice(
          '拾取功能需要先刷新页面。\n' +
          '原因：扩展重载后，已打开的页面里运行的是旧的 content script。\n' +
          '解决：在当前页面按 F5 刷新，然后重新点此按钮。'
        );
      }
      return;
    }

    // 2. 启动拾取
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: 'start-picker' });
      window.close();
    } catch (e) {
      showNotice('启动拾取失败：' + (e && e.message ? e.message : String(e)));
    }
  };

  renderWhitelist(state.whitelist);

  const inputEl = document.getElementById('new-whitelist');
  const addBtn = document.getElementById('add-whitelist');

  const doAdd = async () => {
    const d = normalizeDomain(inputEl.value);
    if (!d) {
      showNotice('请输入有效域名，例如 cdn.example.com\n· 公共后缀（如 co.uk、github.io）不被接受\n· 中文域名会转成 punycode（xn--…）保存');
      return;
    }
    const { whitelist } = await getState();
    if (whitelist.includes(d)) {
      inputEl.value = '';
      return;
    }
    await chrome.storage.local.set({ whitelist: [...whitelist, d] });
    inputEl.value = '';
  };

  addBtn.onclick = doAdd;
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
  });

  document.getElementById('open-options').onclick = () => {
    chrome.runtime.openOptionsPage();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mode) refreshStatus(changes.mode.newValue);
    if (changes.whitelist) renderWhitelist(changes.whitelist.newValue || []);
    if (changes.advancedMode) advEl.checked = !!changes.advancedMode.newValue;
  });
}

init().catch(e => {
  console.error('[Domain Firewall popup] 初始化失败', e);
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.className = 'status off';
    statusEl.textContent = '初始化失败：' + e;
  }
});
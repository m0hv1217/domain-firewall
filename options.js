// ============================================================================
// 状态
// ============================================================================
let allLogs = [];
let renderedLogs = [];
let renderTimer = null;

let pickerRules = [];
let customRules = [];
let customBatches = [];

let activeBatchPort = null;

const BATCH_PROGRESS_KEY = 'batch-progress';

// ============================================================================
// 工具函数
// ============================================================================
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '-';
}

function buildDetail(log) {
  return {
    id: log.id,
    tabId: log.tabId,
    frameId: log.frameId,
    initiator: log.initiator,
    fromCache: log.fromCache,
    error: log.error,
    requestHeaders: log.requestHeaders,
    responseHeaders: log.responseHeaders,
    requestBody: log.requestBody,
  };
}

// ============================================================================
// 日志渲染
// ============================================================================
function render() {
  const q = document.getElementById('filter').value.trim().toLowerCase();
  const t = document.getElementById('type-filter').value;
  let logs = allLogs;
  if (q) logs = logs.filter(l => l.url && l.url.toLowerCase().includes(q));
  if (t) logs = logs.filter(l => l.type === t);

  document.getElementById('count').textContent =
    `匹配 ${logs.length} 条 / 总计 ${allLogs.length} 条`;

  const tbody = document.getElementById('log-body');
  if (!logs.length) {
    renderedLogs = [];
    tbody.innerHTML = '<tr><td colspan="6" class="empty">无匹配日志</td></tr>';
    return;
  }

  renderedLogs = [...logs].reverse();

  tbody.innerHTML = renderedLogs.map((log, i) => `<tr>
      <td>${fmtTime(log.timestamp)}</td>
      <td>${esc(log.method)}</td>
      <td>${esc(log.type)}</td>
      <td>${log.error
        ? '<span style="color:#c62828">ERR</span>'
        : esc(log.statusCode ?? '-')}</td>
      <td class="url">${esc(log.url)}</td>
      <td><details data-idx="${i}"><summary>查看</summary><pre class="detail-pre"></pre></details></td>
    </tr>`).join('');

  // 延迟 stringify：仅当 details 展开时才生成 JSON
  tbody.querySelectorAll('details[data-idx]').forEach(d => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      const pre = d.querySelector('.detail-pre');
      if (pre && !pre.textContent) {
        const log = renderedLogs[+d.dataset.idx];
        if (log) pre.textContent = JSON.stringify(buildDetail(log), null, 2);
      }
    });
  });
}

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 200);
}

async function loadLogs() {
  const { logs = [] } = await chrome.storage.local.get({ logs: [] });
  allLogs = logs;
  render();
}

// ============================================================================
// 元素拾取记录
// ============================================================================
async function loadPickerRules() {
  const { pickerRules: rules = [] } = await chrome.storage.local.get({ pickerRules: [] });
  pickerRules = rules;
  renderPicker();
}

function fmtTtl(r) {
  if (!r.active) return '<span class="muted">停用</span>';
  const hasNet = r.dnrRuleIds && r.dnrRuleIds.length > 0;
  if (!hasNet) {
    return r.dnrExpired
      ? '<span style="color:#c62828">已过期</span>'
      : '<span class="muted">仅隐藏</span>';
  }
  if (!r.expiresAt) return '<span class="muted">永久</span>';
  const remain = r.expiresAt - Date.now();
  if (remain <= 0) return '<span style="color:#c62828">已过期</span>';
  const min = Math.floor(remain / 60000);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天 ${hr % 24} 小时`;
}

function renderPicker() {
  const tbody = document.getElementById('picker-body');
  if (!pickerRules.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无拾取记录</td></tr>';
    return;
  }

  tbody.innerHTML = [...pickerRules].reverse().map(r => {
    const hasNet = r.url && (r.dnrRuleIds || []).length > 0;
    const canRearm = r.active && r.url && !hasNet;
    const primaryAction = canRearm
      ? `<button data-action="rearm" data-id="${esc(r.id)}">重新拦截</button>`
      : `<button data-action="toggle" data-id="${esc(r.id)}">${r.active ? '停用' : '启用'}</button>`;
    return `<tr>
      <td>${fmtTime(r.createdAt)}</td>
      <td>${esc(r.hostname)}</td>
      <td class="mono">${esc(r.selector)}</td>
      <td class="mono">${r.url ? esc(r.url) : '<span class="muted">—</span>'}</td>
      <td>${fmtTtl(r)}</td>
      <td>${r.active
        ? '<span class="badge on">启用</span>'
        : '<span class="badge off">停用</span>'}</td>
      <td class="row-actions">
        ${primaryAction}
        <button data-action="remove" data-id="${esc(r.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'remove') {
        if (!confirm('删除此拾取记录？元素将重新显示（需刷新页面），关联的网络拦截也会释放。')) return;
        await chrome.runtime.sendMessage({ type: 'picker-remove', id });
      } else if (action === 'rearm') {
        await chrome.runtime.sendMessage({ type: 'picker-toggle', id, active: true });
      } else {
        const rec = pickerRules.find(x => x.id === id);
        if (!rec) return;
        await chrome.runtime.sendMessage({
          type: 'picker-toggle', id, active: !rec.active,
        });
      }
      loadPickerRules();
      refreshBudgetSnapshot();
    };
  });
}

// ============================================================================
// 预算份额
// ============================================================================
const BUDGET_KEYS = ['CORE', 'CUSTOM', 'TRANSIENT', 'RESERVE'];
const BUDGET_DEFAULTS_PCT = { CORE: 15, CUSTOM: 15, TRANSIENT: 30, RESERVE: 40 };
const BUDGET_PREV_REGEX = { CORE: 0.05, CUSTOM: 0.70, TRANSIENT: 0.15, RESERVE: 0.10 };

function updateBudgetTotal() {
  let total = 0;
  for (const k of BUDGET_KEYS) {
    total += Number(document.getElementById('share-' + k).value) || 0;
  }
  document.getElementById('budget-total').textContent = `合计 ${total}%`;
}

async function loadBudgetConfig() {
  const { budgetConfig } = await chrome.storage.local.get({ budgetConfig: null });
  for (const k of BUDGET_KEYS) {
    const pct = budgetConfig && budgetConfig[k]
      ? Math.round((budgetConfig[k].share || 0) * 100)
      : BUDGET_DEFAULTS_PCT[k];
    document.getElementById('share-' + k).value = pct;
  }
  updateBudgetTotal();
}

async function refreshBudgetSnapshot() {
  const el = document.getElementById('budget-snapshot');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'budget-snapshot' });
    if (res && res.ok) el.textContent = JSON.stringify(res.snapshot, null, 2);
    else el.textContent = '（无法获取快照）';
  } catch (e) {
    el.textContent = String(e);
  }
}

// ============================================================================
// TRANSIENT TTL
// ============================================================================
const TTL_DEFAULT_HOURS = 24;

async function loadTtlConfig() {
  const { transientTtlMs } = await chrome.storage.local.get({ transientTtlMs: null });
  const hours = transientTtlMs
    ? Math.round((Number(transientTtlMs) / 3600000) * 10) / 10
    : TTL_DEFAULT_HOURS;
  document.getElementById('ttl-hours').value = hours;
  document.getElementById('ttl-status').textContent =
    transientTtlMs ? '' : '（使用默认值）';
}

// ============================================================================
// 静态规则集
// ============================================================================
const RULESET_META = {
  easylist: { name: 'EasyList', desc: '基础广告过滤（推荐）' },
  'adguard-base': { name: 'AdGuard Base', desc: '更激进的广告与跟踪器过滤' },
};

async function loadRulesets() {
  const { enabledRulesets = ['easylist'] } = await chrome.storage.local.get({
    enabledRulesets: ['easylist'],
  });
  const box = document.getElementById('ruleset-list');
  box.innerHTML = Object.entries(RULESET_META).map(([id, meta]) => {
    const checked = enabledRulesets.includes(id);
    return `<label class="ruleset-item">
      <input type="checkbox" data-ruleset="${id}" ${checked ? 'checked' : ''}>
      <span><strong>${meta.name}</strong><br><span class="muted">${meta.desc}</span></span>
    </label>`;
  }).join('');

  box.querySelectorAll('input[data-ruleset]').forEach(cb => {
    cb.onchange = async () => {
      const { enabledRulesets = ['easylist'] } = await chrome.storage.local.get({
        enabledRulesets: ['easylist'],
      });
      const id = cb.dataset.ruleset;
      const next = cb.checked
        ? [...new Set([...enabledRulesets, id])]
        : enabledRulesets.filter(x => x !== id);
      await chrome.storage.local.set({ enabledRulesets: next });
    };
  });
}

// ============================================================================
// 恢复横幅
// ============================================================================
async function checkProgressBanner() {
  try {
    const r = await chrome.storage.session.get({ [BATCH_PROGRESS_KEY]: null });
    const prog = r[BATCH_PROGRESS_KEY];
    const banner = document.getElementById('resume-banner');
    const detail = document.getElementById('resume-detail');
    const addBtn = document.getElementById('add-custom-batch');

    if (!prog || prog.completed || prog.cancelled) {
      banner.style.display = 'none';
      if (!activeBatchPort) addBtn.disabled = false;
      return;
    }

    const cur = prog.current || 0;
    const total = prog.total || 0;
    const phaseText = prog.phase === 'admit' ? '（已转换完成，等待写入）' : '';
    detail.textContent = `批次 ${prog.batchId}：已转换 ${cur}/${total} 行${phaseText}`;
    banner.style.display = 'block';

    // 有未完成批次时禁用「批量导入」，避免误覆盖
    if (!activeBatchPort) addBtn.disabled = true;
  } catch {
    // session storage 不可用时静默失败
  }
}

// ============================================================================
// 批量导入结果格式化
// ============================================================================
function formatBatchResult(res) {
  const lines = [];

  if (res.alreadyCompleted) {
    lines.push('该批次已落盘，无需恢复。');
    return lines.join('\n');
  }

  if (res.cancelled) {
    lines.push('已取消，未写入任何规则。');
    if (res.convertPartial) lines.push(`取消前已转换成功：${res.convertPartial} 行`);
    if (res.conversionFailed) lines.push(`取消前已转换失败：${res.conversionFailed} 行`);
    if (res.failed && res.failed.length) {
      lines.push('', '转换失败明细：');
      for (const f of res.failed) lines.push(`  [${f.reason}] ${f.line}`);
    }
    return lines.join('\n');
  }

  if (!res.ok) {
    lines.push(`导入失败：${res.reason || 'unknown'}`);
    if (res.budgetReason) lines.push(`预算原因：${res.budgetReason}`);
  } else {
    lines.push(`成功：${res.succeeded} 行，生成 ${res.dnrRuleCount} 条新 DNR 规则`);
    if (res.claimedCount) lines.push(`认领孤儿规则：${res.claimedCount} 行`);
    if (res.deduped) lines.push(`去重跳过：${res.deduped} 行（规则已存在）`);
    if (res.conversionFailed) lines.push(`转换失败：${res.conversionFailed} 行`);
    if (res.budgetRejected) lines.push(`预算拒绝：${res.budgetRejected} 行`);
  }

  if (res.dedupedLines && res.dedupedLines.length) {
    lines.push('', '去重明细：');
    for (const d of res.dedupedLines) lines.push(`  [${d.reason}] ${d.line}`);
  }
  if (res.failed && res.failed.length) {
    lines.push('', '转换失败明细：');
    for (const f of res.failed) {
      lines.push(`  [${f.reason}] ${f.line}`);
      if (f.errors && f.errors.length) {
        lines.push(`    ${f.errors.slice(0, 1).join('; ')}`);
      }
    }
  }
  if (res.rejectedByBudget && res.rejectedByBudget.length) {
    lines.push('', '预算拒绝明细：');
    for (const f of res.rejectedByBudget) lines.push(`  [${f.reason}] ${f.line}`);
  }

  return lines.join('\n');
}

// ============================================================================
// 批量导入：Port 长连接 + 进度 + 取消 + 恢复
// ============================================================================
function setupBatchImport() {
  const input = document.getElementById('custom-rule-input');
  const msg = document.getElementById('custom-rule-msg');
  const progressEl = document.getElementById('custom-progress');
  const progressBar = document.getElementById('custom-progress-bar');
  const cancelBtn = document.getElementById('custom-cancel');
  const addBtn = document.getElementById('add-custom-batch');
  const details = document.getElementById('custom-result-details');
  const pre = document.getElementById('custom-result-pre');

  // 暴露给恢复按钮
  window.runBatchImport = async ({ resume = false } = {}) => {
    if (activeBatchPort) return;

    let text, atomic;
    if (resume) {
      const r = await chrome.storage.session.get({ [BATCH_PROGRESS_KEY]: null });
      const prog = r[BATCH_PROGRESS_KEY];
      if (!prog) {
        msg.textContent = '没有可恢复的批次';
        return;
      }
      text = prog.text;
      atomic = !!prog.atomic;
      input.value = text;
      document.getElementById('atomic-mode').checked = atomic;
    } else {
      text = input.value;
      atomic = document.getElementById('atomic-mode').checked;
      if (!text.trim()) return;
    }

    progressEl.style.display = 'block';
    progressBar.value = 0;
    progressBar.max = 100;
    cancelBtn.style.display = 'inline-block';
    addBtn.disabled = true;
    msg.textContent = resume ? '恢复中…' : '准备中…';
    details.style.display = 'none';
    pre.textContent = '';

    let port;
    try {
      port = chrome.runtime.connect({ name: 'custom-batch' });
    } catch (e) {
      msg.textContent = '连接失败：' + e;
      finish(port);
      return;
    }
    activeBatchPort = port;

    let done = false;
    let lastProgressAt = 0;

    port.onMessage.addListener((m) => {
      if (!m || !m.type) return;

      if (m.type === 'progress') {
        if (m.phase === 'parse') {
          msg.textContent = m.resumeFrom
            ? `恢复解析完成，从第 ${m.resumeFrom + 1} 行继续（共 ${m.total} 行）`
            : `解析完成，共 ${m.total} 行`;
          progressBar.max = m.total;
          progressBar.value = m.resumeFrom || 0;
        } else if (m.phase === 'convert') {
          const now = Date.now();
          if (now - lastProgressAt < 100 && m.current < m.total) return;
          lastProgressAt = now;
          const snippet = m.line.length > 60 ? m.line.slice(0, 60) + '…' : m.line;
          msg.textContent = `转换中 ${m.current}/${m.total}: ${snippet}`;
          progressBar.max = m.total;
          progressBar.value = m.current;
        } else if (m.phase === 'admit') {
          msg.textContent = `预算检查与写入中（转换成功 ${m.succeeded}，失败 ${m.failed}）`;
        }
      } else if (m.type === 'done') {
        done = true;
        const res = m.result;
        pre.textContent = formatBatchResult(res);
        details.style.display = 'block';
        details.open = !res.ok;

        if (res.cancelled) {
          msg.textContent = '已取消，未写入任何规则';
        } else if (res.alreadyCompleted) {
          msg.textContent = '该批次已完成，无需恢复';
        } else {
          msg.textContent = res.ok
            ? `已导入 ${res.succeeded} 行（去重 ${res.deduped || 0}，转换失败 ${res.conversionFailed}，预算拒绝 ${res.budgetRejected}）`
            : `导入失败：${res.reason || 'unknown'}`;
          if (res.ok) input.value = '';
        }

        loadCustomData();
        refreshBudgetSnapshot();
        checkProgressBanner();
        try { port.disconnect(); } catch { /* ignore */ }
      } else if (m.type === 'error') {
        done = true;
        msg.textContent = '错误：' + m.error;
        try { port.disconnect(); } catch { /* ignore */ }
      }
    });

    port.onDisconnect.addListener(() => {
      if (!done) {
        msg.textContent = '连接中断（可能 Service Worker 重启），下次打开此页可恢复';
      }
      finish(port);
      checkProgressBanner();
    });

    cancelBtn.onclick = () => {
      try { port.postMessage({ type: 'cancel' }); } catch { /* ignore */ }
      msg.textContent = '正在取消…';
    };

    try {
      port.postMessage({ type: 'start', text, atomic, resume });
    } catch (e) {
      msg.textContent = '发送失败：' + e;
      try { port.disconnect(); } catch { /* ignore */ }
    }

    function finish(p) {
      if (activeBatchPort !== p && p) return;
      activeBatchPort = null;
      cancelBtn.style.display = 'none';
      addBtn.disabled = false;
      setTimeout(() => {
        if (!activeBatchPort) progressEl.style.display = 'none';
      }, 1500);
    }
  };

  addBtn.onclick = () => window.runBatchImport({ resume: false });
}

// ============================================================================
// 自定义规则：数据加载与渲染
// ============================================================================
async function loadCustomData() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'custom-list' });
    if (res && res.rules) {
      customRules = res.rules;
      customBatches = res.batches || [];
    }
  } catch {
    customRules = [];
    customBatches = [];
  }
  renderCustomBatches();
  renderCustomRules();
}

function renderCustomBatches() {
  const tbody = document.getElementById('custom-batch-body');
  if (!customBatches.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无批次</td></tr>';
    return;
  }

  tbody.innerHTML = [...customBatches].reverse().map(b => `<tr>
    <td>${fmtTime(b.createdAt)}${b.atomic ? ' <span class="muted">(原子)</span>' : ''}</td>
    <td>${b.totalLines}</td>
    <td>${b.succeeded}</td>
    <td>${b.deduped || 0}</td>
    <td>${b.conversionFailed}</td>
    <td>${b.budgetRejected}</td>
    <td class="row-actions">
      <button data-batch-action="remove" data-id="${esc(b.id)}">删除整批</button>
    </td>
  </tr>`).join('');

  tbody.querySelectorAll('button[data-batch-action="remove"]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('删除整个批次？该批次下的所有规则都会被释放。')) return;
      const res = await chrome.runtime.sendMessage({
        type: 'custom-remove-batch',
        batchId: btn.dataset.id,
      });
      if (!res.ok) alert('删除失败：' + (res.reason || '未知错误'));
      loadCustomData();
      refreshBudgetSnapshot();
    };
  });
}

function renderCustomRules() {
  const tbody = document.getElementById('custom-rule-body');
  if (!customRules.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无自定义规则</td></tr>';
    return;
  }

  tbody.innerHTML = [...customRules].reverse().map(r => `<tr>
    <td>${fmtTime(r.createdAt)}</td>
    <td class="mono">${esc(r.text)}</td>
    <td>${r.dnrRuleIds ? r.dnrRuleIds.length : 0}</td>
    <td>${r.stale
      ? '<span style="color:#c62828">需要重试</span>'
      : '<span class="badge on">启用</span>'}</td>
    <td class="row-actions">
      <button data-custom-action="remove" data-id="${esc(r.id)}">删除</button>
    </td>
  </tr>`).join('');

  tbody.querySelectorAll('button[data-custom-action="remove"]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('删除此自定义规则？')) return;
      const res = await chrome.runtime.sendMessage({
        type: 'custom-remove',
        id: btn.dataset.id,
      });
      if (!res.ok) alert('删除失败：' + (res.reason || '未知错误'));
      loadCustomData();
      refreshBudgetSnapshot();
    };
  });
}

// ============================================================================
// 事件绑定
// ============================================================================
function bindStaticEvents() {
  // 日志
  document.getElementById('refresh').onclick = loadLogs;
  document.getElementById('filter').oninput = scheduleRender;
  document.getElementById('type-filter').onchange = scheduleRender;

  document.getElementById('export').onclick = () => {
    const blob = new Blob([JSON.stringify(allLogs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `domain-firewall-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById('clear').onclick = async () => {
    if (!confirm('确定清空所有日志？')) return;
    await chrome.storage.local.set({ logs: [] });
    allLogs = [];
    render();
  };

  // 预算份额
  document.getElementById('share-CORE').oninput = updateBudgetTotal;
  document.getElementById('share-CUSTOM').oninput = updateBudgetTotal;
  document.getElementById('share-TRANSIENT').oninput = updateBudgetTotal;
  document.getElementById('share-RESERVE').oninput = updateBudgetTotal;

  document.getElementById('save-budget').onclick = async () => {
    const shares = {};
    let total = 0;
    for (const k of BUDGET_KEYS) {
      const v = Number(document.getElementById('share-' + k).value);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        alert(`${k} 份额无效`);
        return;
      }
      shares[k] = v;
      total += v;
    }
    if (total > 100) {
      alert('总份额不能超过 100%');
      return;
    }
    if (shares.RESERVE < 5) {
      alert('RESERVE 至少 5%');
      return;
    }

    const budgetConfig = {};
    for (const k of BUDGET_KEYS) {
      budgetConfig[k] = {
        share: shares[k] / 100,
        regexShare: BUDGET_PREV_REGEX[k],
      };
    }
    await chrome.storage.local.set({ budgetConfig });
    refreshBudgetSnapshot();
    alert('已保存，账本将按新份额重建。');
  };

  document.getElementById('reset-budget').onclick = async () => {
    await chrome.storage.local.set({ budgetConfig: null });
    await loadBudgetConfig();
    refreshBudgetSnapshot();
  };

  // TTL
  document.getElementById('save-ttl').onclick = async () => {
    const hours = Number(document.getElementById('ttl-hours').value);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
      alert('请输入 0.1 到 720 之间的小时数');
      return;
    }
    await chrome.storage.local.set({ transientTtlMs: Math.round(hours * 3600000) });
    document.getElementById('ttl-status').textContent = '已保存';
  };

  document.getElementById('sweep-now').onclick = async () => {
    document.getElementById('ttl-status').textContent = '清理中…';
    try {
      await chrome.runtime.sendMessage({ type: 'sweep-now' });
      await loadPickerRules();
      await refreshBudgetSnapshot();
      document.getElementById('ttl-status').textContent = '已清理';
    } catch (e) {
      document.getElementById('ttl-status').textContent = '清理失败：' + e;
    }
  };

  // 恢复横幅
  document.getElementById('resume-btn').onclick = async () => {
    if (activeBatchPort) return;
    await window.runBatchImport({ resume: true });
  };

  document.getElementById('discard-btn').onclick = async () => {
    if (!confirm('丢弃上次未完成的批次进度？')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'batch-progress-discard' });
    } catch { /* ignore */ }
    try {
      await chrome.storage.session.remove(BATCH_PROGRESS_KEY);
    } catch { /* ignore */ }
    document.getElementById('resume-banner').style.display = 'none';
    document.getElementById('add-custom-batch').disabled = false;
  };
}

// ============================================================================
// storage 监听
// ============================================================================
function bindStorageListeners() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[BATCH_PROGRESS_KEY]) {
      checkProgressBanner();
      return;
    }
    if (area !== 'local') return;

    if (changes.logs) {
      allLogs = changes.logs.newValue || [];
      scheduleRender();
    }
    if (changes.pickerRules) {
      pickerRules = changes.pickerRules.newValue || [];
      renderPicker();
    }
    if (changes.budgetConfig) {
      loadBudgetConfig();
      refreshBudgetSnapshot();
    }
    if (changes.transientTtlMs) {
      loadTtlConfig();
    }
    if (changes.enabledRulesets) {
      loadRulesets();
    }
    if (changes.customRules || changes.customBatches) {
      loadCustomData();
    }
  });
}

// ============================================================================
// 初始化
// ============================================================================
async function init() {
  bindStaticEvents();
  bindStorageListeners();
  setupBatchImport();

  await Promise.all([
    loadLogs(),
    loadPickerRules(),
    loadBudgetConfig(),
    loadTtlConfig(),
    loadRulesets(),
    loadCustomData(),
  ]);

  await Promise.all([
    refreshBudgetSnapshot(),
    checkProgressBanner(),
  ]);
}

init().catch(e => {
  console.error('[Domain Firewall options] 初始化失败', e);
  const el = document.getElementById('count');
  if (el) el.textContent = '初始化失败：' + e;
});
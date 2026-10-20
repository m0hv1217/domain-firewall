(function () {
  if (window.__dfContentLoaded) return;
  window.__dfContentLoaded = true;

  console.log('[Domain Firewall] content script 已加载 @', location.hostname);

  // ============================================================================
  // Cosmetic
  // ============================================================================
  let styleEl = null;

  function getStyleHost() {
    return document.head || document.documentElement;
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl;
    const host = getStyleHost();
    if (!host) return null;
    styleEl = document.createElement('style');
    styleEl.id = '__df_cosmetic_style';
    styleEl.setAttribute('type', 'text/css');
    host.appendChild(styleEl);
    return styleEl;
  }

  async function loadCosmetic() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'cosmetic-get',
        hostname: location.hostname,
      });
      const rules = (res && res.rules) || [];
      const css = rules
        .filter(r => r && r.active && r.selector)
        .map(r => `${String(r.selector).trim()} { display: none !important; }`)
        .join('\n');
      const el = ensureStyle();
      if (el) el.textContent = css;
    } catch { /* 扩展上下文失效 / SW 未就绪 */ }
  }

  loadCosmetic();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCosmetic, { once: true });
  }

  // ============================================================================
  // 消息
  // ============================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ping') {
      sendResponse('pong');
      return true;
    }
    if (msg.type === 'cosmetic-updated') loadCosmetic();
    if (msg.type === 'start-picker') startPicker();
  });

  // ============================================================================
  // Picker
  // ============================================================================
  let pickerActive = false;
  let hlBox = null;      // 透明蓝色高亮框
  let hlInfo = null;     // 尺寸 + 元素信息标签
  let panel = null;      // 确认面板
  let currentTarget = null;
  let rafId = null;
  let lastMouseEvent = null;
  let pickerStyleEl = null;

  const BRAND = '#2E5BFF';
  const BRAND_RGB = '46,91,255';

  function ensurePickerStyles() {
    if (pickerStyleEl && pickerStyleEl.isConnected) return;
    pickerStyleEl = document.createElement('style');
    pickerStyleEl.id = '__df_picker_styles';
    pickerStyleEl.textContent = `
      @keyframes __df_panel_in {
        from { opacity: 0; transform: translateY(6px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes __df_hl_pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(${BRAND_RGB},0.30); }
        50%      { box-shadow: 0 0 0 4px rgba(${BRAND_RGB},0.18); }
      }
      html.__df_picking,
      html.__df_picking * {
        cursor: pointer !important;
      }
    `;
    (document.head || document.documentElement).appendChild(pickerStyleEl);
  }

  function setPickingCursor(on) {
    const root = document.documentElement;
    if (!root) return;
    if (on) root.classList.add('__df_picking');
    else root.classList.remove('__df_picking');
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    currentTarget = null;

    ensurePickerStyles();

    // 高亮框
    hlBox = document.createElement('div');
    hlBox.id = '__df_picker_hl_box';
    Object.assign(hlBox.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      border: `2px solid ${BRAND}`,
      background: `rgba(${BRAND_RGB},0.12)`,
      boxSizing: 'border-box',
      borderRadius: '2px',
      display: 'none',
      transition:
        'top 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'left 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'width 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'height 80ms cubic-bezier(0.4,0,0.2,1)',
      animation: '__df_hl_pulse 1.6s ease-in-out infinite',
    });
    (document.body || document.documentElement).appendChild(hlBox);

    // 尺寸 + 元素信息标签
    hlInfo = document.createElement('div');
    hlInfo.id = '__df_picker_hl_info';
    Object.assign(hlInfo.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      background: `rgba(${BRAND_RGB},0.95)`,
      color: '#fff',
      padding: '3px 7px',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
      display: 'none',
      boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
      maxWidth: '80vw',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      transition:
        'top 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'left 80ms cubic-bezier(0.4,0,0.2,1)',
    });
    (document.body || document.documentElement).appendChild(hlInfo);

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    setPickingCursor(true);
  }

  function stopPicker() {
    pickerActive = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);

    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    lastMouseEvent = null;

    if (hlBox) { hlBox.remove(); hlBox = null; }
    if (hlInfo) { hlInfo.remove(); hlInfo = null; }
    if (panel) { panel.remove(); panel = null; }
    currentTarget = null;
    setPickingCursor(false);
  }

  function onMove(e) {
    if (!pickerActive) return;
    lastMouseEvent = e;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const ev = lastMouseEvent;
      lastMouseEvent = null;
      if (!ev) return;
      const el = ev.target;
      if (!el || el === hlBox || el === hlInfo || (panel && panel.contains(el))) return;
      highlight(el);
    });
  }

  function onClick(e) {
    if (!pickerActive) return;
    if (panel && panel.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    currentTarget = e.target;
    showPanel(currentTarget);
  }

  function onKey(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') { e.preventDefault(); stopPicker(); return; }
    if (e.key === 'ArrowUp' && currentTarget && currentTarget.parentElement) {
      e.preventDefault();
      currentTarget = currentTarget.parentElement;
      highlight(currentTarget);
      showPanel(currentTarget);
    }
  }

  /**
   * 更新高亮框 + 尺寸/元素信息标签。
   * 首次显示时关掉过渡，避免从 (0,0) 滑入；之后移动鼠标时平滑跟随。
   */
  function highlight(el) {
    if (!hlBox || !hlInfo || !el || el.nodeType !== 1) return;

    const r = el.getBoundingClientRect();
    const firstShow = hlBox.style.display === 'none';

    if (firstShow) {
      hlBox.style.transition = 'none';
      hlInfo.style.transition = 'none';
    }

    // ---- 高亮框 ----
    Object.assign(hlBox.style, {
      display: 'block',
      top: r.top + 'px',
      left: r.left + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
    });

    // ---- 尺寸 + 元素信息 ----
    const tag = el.localName || (el.tagName ? el.tagName.toLowerCase() : '?');
    const idPart = el.id ? `#${el.id}` : '';
    let classPart = '';
    if (el.classList && el.classList.length) {
      const cls = Array.from(el.classList).slice(0, 2).join('.');
      classPart = '.' + cls;
    }
    const sizeText = `${Math.round(r.width)} × ${Math.round(r.height)}`;
    const labelText = `${tag}${idPart}${classPart}`;
    hlInfo.textContent = `${sizeText}  ${labelText}`;
    hlInfo.style.display = 'block';

    // 先放到左上角测量实际尺寸，再计算位置
    hlInfo.style.top = '0px';
    hlInfo.style.left = '0px';
    const infoW = hlInfo.offsetWidth;
    const infoH = hlInfo.offsetHeight;

    // 默认在框上方 4px；顶部放不下就放下方
    let infoTop = r.top - infoH - 4;
    if (infoTop < 4) infoTop = r.bottom + 4;

    // 左边和框对齐；右侧超出视口就往左推
    let infoLeft = r.left;
    const maxLeft = window.innerWidth - infoW - 8;
    if (infoLeft > maxLeft) infoLeft = maxLeft;
    if (infoLeft < 4) infoLeft = 4;

    hlInfo.style.top = infoTop + 'px';
    hlInfo.style.left = infoLeft + 'px';

    if (firstShow) {
      // 强制 reflow，让无过渡的定位生效
      void hlBox.offsetWidth;
      hlBox.style.transition =
        'top 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'left 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'width 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'height 80ms cubic-bezier(0.4,0,0.2,1)';
      hlInfo.style.transition =
        'top 80ms cubic-bezier(0.4,0,0.2,1), ' +
        'left 80ms cubic-bezier(0.4,0,0.2,1)';
    }
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      const s = '#' + CSS.escape(el.id);
      try { if (document.querySelectorAll(s).length === 1) return s; } catch { /* ignore */ }
    }
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 8) {
      let part = cur.localName;
      if (!part) break;
      if (cur.classList && cur.classList.length) {
        const cls = Array.from(cur.classList)
          .filter(c => /^[a-zA-Z_-][\w-]*$/.test(c))
          .slice(0, 2);
        if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.localName === cur.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    if (!parts.length) return null;
    const sel = parts.join(' > ');
    try { if (document.querySelectorAll(sel).length >= 1) return sel; } catch { /* ignore */ }
    return null;
  }

  function extractElementUrl(el) {
    if (!el || !el.getAttribute) return null;
    for (const attr of ['src', 'href', 'data-src', 'data-original']) {
      const v = el.getAttribute(attr);
      if (v && /^https?:/i.test(v)) return v;
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 轻提示 ----------
  let toastEl = null;
  let toastTimer = null;

  function showToast(text, kind) {
    try {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      if (toastEl) { toastEl.remove(); toastEl = null; }
      const host = document.body || document.documentElement;
      if (!host) return;

      const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const C = isDark
        ? { bg: '#1A1D21', text: '#E6E8EB', border: '#353B45', ok: '#5B7FFF', err: '#FF5C57' }
        : { bg: '#FFFFFF', text: '#1F2328', border: '#E1E4E8', ok: '#2E5BFF', err: '#E53935' };
      const accent = kind === 'error' ? C.err : C.ok;

      const el = document.createElement('div');
      el.id = '__df_toast';
      el.setAttribute('role', 'status');
      el.textContent = text;                       // 只用 textContent，不拼 HTML
      Object.assign(el.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
        width: '320px', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
        padding: '10px 14px', background: C.bg, color: C.text,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent}`, borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)', pointerEvents: 'none',
        opacity: '0', transform: 'translateY(6px)',
        transition: 'opacity 180ms ease, transform 180ms ease',
      });
      host.appendChild(el);
      toastEl = el;
      requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });

      toastTimer = setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => { el.remove(); if (toastEl === el) toastEl = null; }, 200);
        toastTimer = null;
      }, kind === 'error' ? 6000 : 3500);
    } catch { /* 页面 DOM 不可用时静默 */ }
  }

  // 后台返回的 netError → 给人看的说明
  function describeNetError(err) {
    const s = String(err || '');
    if (s.includes('预算')) return '规则预算已满，请先在设置页清理临时规则';
    if (s.includes('URL 无法转换')) return '该 URL 无法生成拦截规则';
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  // 选择器匹配数量达到这个值时，确认前再问一次
  const MANY_MATCH_THRESHOLD = 10;

  function showPanel(target) {
    if (panel) panel.remove();

    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const C = isDark ? {
      bg: '#1A1D21', text: '#E6E8EB', muted: '#9BA3AE',
      border: '#353B45', subtle: '#23272E', brand: '#5B7FFF', brandHover: '#7393FF', danger: '#FF5C57',
    } : {
      bg: '#FFFFFF', text: '#1F2328', muted: '#6B7280',
      border: '#E1E4E8', subtle: '#F7F8FA', brand: '#2E5BFF', brandHover: '#1E48E0', danger: '#E53935',
    };

    panel = document.createElement('div');
    panel.id = '__df_picker_panel';
    Object.assign(panel.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '340px',
      padding: '16px',
      background: C.bg,
      color: C.text,
      font: '13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      border: `1px solid ${C.border}`,
      borderRadius: '10px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      animation: '__df_panel_in 260ms cubic-bezier(0,0,0.2,1) both',
    });

    const sel = buildSelector(target);
    const url = extractElementUrl(target);
    let matchCount = 0;
    try { if (sel) matchCount = document.querySelectorAll(sel).length; } catch { /* 选择器非法 */ }

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <div style="width:20px;height:20px;border-radius:4px;background:${C.brand};flex-shrink:0"></div>
        <div style="font-weight:600;font-size:14px">元素拾取</div>
      </div>
      <div style="font-size:11px;color:${C.muted};margin-bottom:6px">选择器 · 按 ↑ 选父元素，Esc 退出</div>
      <div id="__df_sel" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:${C.subtle};padding:8px 10px;border-radius:6px;margin-bottom:6px;max-height:80px;overflow:auto;border:1px solid ${C.border}"></div>
      <div id="__df_count" style="font-size:11px;margin-bottom:12px;min-height:16px;color:${C.muted}"></div>
      ${url ? `
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px;cursor:pointer;padding:10px;background:${C.subtle};border-radius:6px;border:1px solid ${C.border};transition:border-color 150ms ease">
        <input type="checkbox" id="__df_net" style="margin-top:2px;accent-color:${C.brand}">
        <span style="font-size:12px;line-height:1.4">
          高级模式下同时拦截此元素的 URL 请求<br>
          <code style="font-size:10px;word-break:break-all;color:${C.muted};font-family:ui-monospace,monospace">${escapeHtml(url)}</code>
        </span>
      </label>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="__df_cancel" style="padding:6px 12px;font:inherit;font-size:12px;background:transparent;color:${C.text};border:1px solid ${C.border};border-radius:5px;cursor:pointer;transition:background-color 150ms ease,border-color 150ms ease">取消</button>
        <button id="__df_confirm" style="padding:6px 14px;font:inherit;font-size:12px;font-weight:500;background:${C.brand};color:#fff;border:0;border-radius:5px;cursor:pointer;transition:background-color 150ms ease,transform 120ms ease,box-shadow 150ms ease">隐藏元素</button>
      </div>
    `;

    const selEl = panel.querySelector('#__df_sel');
    selEl.textContent = sel || '（无法生成稳定选择器，请按 ↑ 选择父元素）';

    const countEl = panel.querySelector('#__df_count');
    if (sel && matchCount > 1) {
      countEl.textContent = `⚠ 此选择器匹配 ${matchCount} 个元素，将全部隐藏（可按 ↑ 换成父元素）`;
      countEl.style.color = C.danger;
    } else if (sel && matchCount === 1) {
      countEl.textContent = '匹配 1 个元素';
    }

    // 网络拦截只在高级模式下生效：没开时直接禁用勾选框并说明，免得"勾了却没效果"
    const netInput = panel.querySelector('#__df_net');
    if (netInput) {
      chrome.storage.local.get({ advancedMode: false }).then(v => {
        if (v.advancedMode || !netInput.isConnected) return;
        netInput.disabled = true;
        netInput.checked = false;
        const note = document.createElement('div');
        note.textContent = '未开启高级模式，此项暂不可用（在扩展弹窗里开启）';
        note.style.cssText = `font-size:10px;margin-top:4px;color:${C.danger}`;
        const label = netInput.closest('label');
        const span = label && label.querySelector('span');
        if (span) span.appendChild(note);
      }).catch(() => { /* 读取失败：保持可勾选，由后台决定 */ });
    }

    const cancelBtn = panel.querySelector('#__df_cancel');
    cancelBtn.onmouseenter = () => {
      cancelBtn.style.background = isDark ? '#2C323A' : '#F0F2F5';
      cancelBtn.style.borderColor = C.muted;
    };
    cancelBtn.onmouseleave = () => {
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.borderColor = C.border;
    };
    cancelBtn.onclick = () => stopPicker();

    const confirmBtn = panel.querySelector('#__df_confirm');
    if (matchCount > 1) confirmBtn.textContent = `隐藏 ${matchCount} 个元素`;
    confirmBtn.onmouseenter = () => {
      confirmBtn.style.background = C.brandHover;
      confirmBtn.style.boxShadow = `0 2px 8px ${isDark ? 'rgba(91,127,255,0.35)' : 'rgba(46,91,255,0.25)'}`;
    };
    confirmBtn.onmouseleave = () => {
      confirmBtn.style.background = C.brand;
      confirmBtn.style.boxShadow = 'none';
    };
    confirmBtn.onmousedown = () => { confirmBtn.style.transform = 'scale(0.97)'; };
    confirmBtn.onmouseup = () => { confirmBtn.style.transform = 'scale(1)'; };
    confirmBtn.onclick = async () => {
      if (!sel) { alert('无法为当前元素生成稳定选择器，请按 ↑ 选择父元素'); return; }
      let nowCount = matchCount;
      try { nowCount = document.querySelectorAll(sel).length; } catch { /* 沿用面板里的数量 */ }
      if (nowCount >= MANY_MATCH_THRESHOLD &&
          !confirm(`该选择器匹配 ${nowCount} 个元素，确定全部隐藏吗？`)) return;
      const netEl = panel.querySelector('#__df_net');
      const includeNet = !!(netEl && netEl.checked);

      const current = styleEl && styleEl.isConnected ? styleEl.textContent : '';
      const nextCss = current
        ? current + '\n' + `${sel} { display: none !important; }`
        : `${sel} { display: none !important; }`;
      const el = ensureStyle();
      if (el) el.textContent = nextCss;

      stopPicker();

      // 元素此刻已经在本页隐藏了；下面告诉用户"保存"和"网络拦截"各自有没有成功
      let res = null;
      let sendFailed = false;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'picker-add',
          hostname: location.hostname,
          selector: sel,
          url: includeNet ? url : null,
        });
      } catch { sendFailed = true; }

      if (sendFailed) {
        showToast('元素已在本页隐藏，但保存失败（扩展可能刚重新加载，请刷新页面后重试）', 'error');
      } else if (!res || res.ok === false) {
        showToast('元素已在本页隐藏，但保存失败' + (res && res.error ? '：' + describeNetError(res.error) : '') + '，刷新后会恢复显示', 'error');
      } else if (includeNet && res.netError) {
        showToast('元素已隐藏，但网络请求拦截失败：' + describeNetError(res.netError), 'error');
      } else if (includeNet) {
        showToast('已隐藏元素，并拦截该 URL 的网络请求');
      }
    };

    (document.body || document.documentElement).appendChild(panel);
    highlight(target);
  }
})();
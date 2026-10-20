// budget-manager.js — 动态 DNR 规则预算管理器
//
// 契约：
//   1. 所有 write 必须通过 admitAndApplyInternal，且调用方必须在 dnrQueue 内调用。
//      本文件不排队，避免死锁。
//   2. ID 由 allocateRuleId(pool) 分配；禁止手写 ID（唯一例外是 CORE 的 RULE_ID=1）。
//   3. 账本是内存态；SW 唤醒后 initBudgetLedger 从 getDynamicRules() 对账重建。
//   4. 对外导出（挂到 self）：
//        ensureBudgetReady, getBudgetLedger, resetBudgetLedger, getBudgetSnapshot,
//        admitAndApplyInternal, inferPoolFromId, analyzeRules,
//        POOL_ID_RANGES, DEFAULT_BUDGET_CONFIG, normalizeBudgetConfig
//
// 依赖：chrome.storage.local、chrome.declarativeNetRequest

(function (global) {
  'use strict';

  // ============================================================================
  // 配额上限（Chrome 121+；低版本为 5000，本文件以 30k 为准做份额计算）
  // ============================================================================
  const MAX_DYNAMIC_RULES = 30000;
  const MAX_UNSAFE_DYNAMIC_RULES = 5000;
  const MAX_REGEX_RULES = 1000;

  // ============================================================================
  // ID 分段（对账的唯一依据）
  // ============================================================================
  const POOL_ID_RANGES = {
    CORE:      { min: 1,       max: 999999 },
    CUSTOM:    { min: 1000000, max: 1999999 },
    TRANSIENT: { min: 3000000, max: 3999999 },
    RESERVE:   { min: 4000000, max: 4999999 },
  };

  // ============================================================================
  // 默认份额（形态 A）
  // ============================================================================
  const DEFAULT_BUDGET_CONFIG = {
    CORE:      { share: 0.15, regexShare: 0.05 },
    CUSTOM:    { share: 0.15, regexShare: 0.70 },
    TRANSIENT: { share: 0.30, regexShare: 0.15 },
    RESERVE:   { share: 0.40, regexShare: 0.10 },
  };

  const RESERVE_MIN_SHARE = 0.05;

  // ============================================================================
  // 工具：份额规范化
  // ============================================================================
  function deepCloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_BUDGET_CONFIG));
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v)));
  }

  /**
   * 规范化用户配置：
   *   - null/非法 → 默认
   *   - 缺失字段 → 用默认
   *   - share/regexShare 越界 → clamp 到 [0, 1]
   *   - RESERVE.share < 5% → clamp 到 5%
   *   - 总和 > 1.001 → 回退默认
   */
  function normalizeBudgetConfig(raw) {
    if (!raw || typeof raw !== 'object') return deepCloneDefault();

    const out = {};
    let total = 0;

    for (const k of Object.keys(DEFAULT_BUDGET_CONFIG)) {
      const v = raw[k] && typeof raw[k] === 'object' ? raw[k] : {};
      const d = DEFAULT_BUDGET_CONFIG[k];
      const share = v.share === undefined ? d.share : clamp01(v.share);
      const regexShare = v.regexShare === undefined ? d.regexShare : clamp01(v.regexShare);
      out[k] = { share, regexShare };
    }

    if (out.RESERVE.share < RESERVE_MIN_SHARE) out.RESERVE.share = RESERVE_MIN_SHARE;

    for (const k of Object.keys(out)) total += out[k].share;
    if (total > 1.001) return deepCloneDefault();

    return out;
  }

  // ============================================================================
  // 工具：ID → pool / 规则分析
  // ============================================================================
  function inferPoolFromId(id) {
    if (typeof id !== 'number' || !Number.isFinite(id)) return null;
    for (const [pool, r] of Object.entries(POOL_ID_RANGES)) {
      if (id >= r.min && id <= r.max) return pool;
    }
    return null;
  }

  function analyzeRules(rules) {
    let unsafe = 0;
    let regex = 0;
    for (const r of rules || []) {
      if (!r) continue;
      const t = r.action && r.action.type;
      if (t === 'redirect' || t === 'modifyHeaders') unsafe++;
      if (r.condition && r.condition.regexFilter) regex++;
    }
    return { unsafe, regex };
  }

  // ============================================================================
  // BudgetLedger
  // ============================================================================
  class BudgetLedger {
    constructor(config) {
      this.config = config || deepCloneDefault();
      this.limits = {
        totalSafe: MAX_DYNAMIC_RULES,
        unsafe: MAX_UNSAFE_DYNAMIC_RULES,
        regex: MAX_REGEX_RULES,
      };

      this.pools = {};
      for (const [name, c] of Object.entries(this.config)) {
        this.pools[name] = {
          softCap: Math.floor(MAX_DYNAMIC_RULES * c.share),
          regexSoftCap: Math.floor(MAX_REGEX_RULES * c.regexShare),
          used: 0,
          unsafeUsed: 0,
          regexUsed: 0,
          ruleIds: new Set(),
          nextId: POOL_ID_RANGES[name] ? POOL_ID_RANGES[name].min : 0,
        };
      }

      this.ruleMeta = new Map(); // id → { pool, unsafe, regex }
      this.totalDynamicUsed = 0;
      this.unsafeUsed = 0;
      this.regexUsed = 0;
    }

    get reserveCap() {
      return this.pools.RESERVE ? this.pools.RESERVE.softCap : 0;
    }

    // -------------------------------------------------------------------------
    // 准入检查
    // -------------------------------------------------------------------------
    canAdmit(poolName, count, { unsafe = 0, regex = 0 } = {}) {
      const p = this.pools[poolName];
      if (!p) return { ok: false, reason: 'unknown_pool' };
      if (count <= 0) return { ok: true };

      if (p.used + count > p.softCap) {
        return { ok: false, reason: 'pool_full' };
      }
      if (this.totalDynamicUsed + count > this.limits.totalSafe - this.reserveCap) {
        return { ok: false, reason: 'total_reserve_guard' };
      }
      if (this.unsafeUsed + unsafe > this.limits.unsafe) {
        return { ok: false, reason: 'unsafe_full' };
      }
      if (this.regexUsed + regex > this.limits.regex) {
        return { ok: false, reason: 'regex_full' };
      }
      if (p.regexUsed + regex > p.regexSoftCap) {
        return { ok: false, reason: 'pool_regex_full' };
      }
      return { ok: true };
    }

    // -------------------------------------------------------------------------
    // 提交（已写入 DNR 后的状态同步）
    // -------------------------------------------------------------------------
    commit(poolName, rules) {
      const p = this.pools[poolName];
      if (!p) throw new Error('commit: unknown pool ' + poolName);

      for (const r of rules || []) {
        if (!r || typeof r.id !== 'number') continue;
        if (this.ruleMeta.has(r.id)) continue; // 防御：同一 ID 不重复计入

        const unsafe = !!(r.action && (r.action.type === 'redirect' || r.action.type === 'modifyHeaders'));
        const regex = !!(r.condition && r.condition.regexFilter);

        this.ruleMeta.set(r.id, { pool: poolName, unsafe, regex });
        p.ruleIds.add(r.id);
        p.used++;
        this.totalDynamicUsed++;
        if (unsafe) { p.unsafeUsed++; this.unsafeUsed++; }
        if (regex) { p.regexUsed++; this.regexUsed++; }
        if (r.id >= p.nextId) p.nextId = r.id + 1;
      }
    }

    /** 对账用：根据 ID 反推 pool 并计入 */
    commitExisting(rule) {
      const pool = inferPoolFromId(rule.id);
      if (!pool) return;
      this.commit(pool, [rule]);
    }

    // -------------------------------------------------------------------------
    // 释放
    // -------------------------------------------------------------------------
    release(ids) {
      for (const id of ids || []) {
        const meta = this.ruleMeta.get(id);
        if (!meta) continue;
        const p = this.pools[meta.pool];
        if (p && p.ruleIds.has(id)) {
          p.ruleIds.delete(id);
          p.used--;
          this.totalDynamicUsed--;
          if (meta.unsafe) { p.unsafeUsed--; this.unsafeUsed--; }
          if (meta.regex) { p.regexUsed--; this.regexUsed--; }
        }
        this.ruleMeta.delete(id);
      }
    }

    // -------------------------------------------------------------------------
    // ID 分配（只递增 nextId，不影响计数）
    // -------------------------------------------------------------------------
    allocateRuleId(poolName) {
      const p = this.pools[poolName];
      if (!p) throw new Error('allocateRuleId: unknown pool ' + poolName);
      const range = POOL_ID_RANGES[poolName];
      if (!range) throw new Error('allocateRuleId: pool has no id range ' + poolName);
      if (p.nextId > range.max) throw new Error('allocateRuleId: id exhausted ' + poolName);
      const id = p.nextId;
      p.nextId++;
      return id;
    }

    // -------------------------------------------------------------------------
    // 快照 / 恢复（供 admitAndApplyInternal 回滚）
    // -------------------------------------------------------------------------
    snapshot() {
      const copy = new BudgetLedger(this.config);
      copy.totalDynamicUsed = this.totalDynamicUsed;
      copy.unsafeUsed = this.unsafeUsed;
      copy.regexUsed = this.regexUsed;

      for (const name of Object.keys(this.pools)) {
        const s = this.pools[name];
        const d = copy.pools[name];
        d.used = s.used;
        d.unsafeUsed = s.unsafeUsed;
        d.regexUsed = s.regexUsed;
        d.ruleIds = new Set(s.ruleIds);
        d.nextId = s.nextId;
      }
      copy.ruleMeta = new Map(this.ruleMeta);
      return copy;
    }

    restore(snap) {
      if (!snap) return;
      this.totalDynamicUsed = snap.totalDynamicUsed;
      this.unsafeUsed = snap.unsafeUsed;
      this.regexUsed = snap.regexUsed;

      for (const name of Object.keys(this.pools)) {
        const s = snap.pools[name];
        const d = this.pools[name];
        if (!s || !d) continue;
        d.used = s.used;
        d.unsafeUsed = s.unsafeUsed;
        d.regexUsed = s.regexUsed;
        d.ruleIds = new Set(s.ruleIds);
        d.nextId = s.nextId;
      }
      this.ruleMeta = new Map(snap.ruleMeta);
    }

    // -------------------------------------------------------------------------
    // 描述（供 UI 展示）
    // -------------------------------------------------------------------------
    describe() {
      const out = {};
      for (const [name, p] of Object.entries(this.pools)) {
        out[name] = {
          used: p.used,
          softCap: p.softCap,
          unsafeUsed: p.unsafeUsed,
          regexUsed: p.regexUsed,
          regexSoftCap: p.regexSoftCap,
        };
      }
      out._total = {
        used: this.totalDynamicUsed,
        safeLimit: this.limits.totalSafe,
        reserveCap: this.reserveCap,
        unsafeUsed: this.unsafeUsed,
        unsafeLimit: this.limits.unsafe,
        regexUsed: this.regexUsed,
        regexLimit: this.limits.regex,
      };
      return out;
    }
  }

  // ============================================================================
  // 全局状态与初始化
  // ============================================================================
  let __budgetLedger = null;
  let __budgetReady = null;

  async function initBudgetLedger() {
    const { budgetConfig } = await chrome.storage.local.get({ budgetConfig: null });
    const config = normalizeBudgetConfig(budgetConfig);
    const ledger = new BudgetLedger(config);

    let rules = [];
    try {
      rules = await chrome.declarativeNetRequest.getDynamicRules();
    } catch (e) {
      // 以空状态启动：后续写入时 DNR 自身会做最终的错误检查
      console.error('[Domain Firewall] getDynamicRules 失败，账本以空状态启动', e);
      rules = [];
    }

    for (const r of rules) ledger.commitExisting(r);

    __budgetLedger = ledger;
    console.log(
      '[Domain Firewall] 预算账本已初始化：',
      `total=${ledger.totalDynamicUsed}/${ledger.limits.totalSafe}`,
      `reserve=${ledger.reserveCap}`,
      `unsafe=${ledger.unsafeUsed}/${ledger.limits.unsafe}`,
      `regex=${ledger.regexUsed}/${ledger.limits.regex}`
    );
    return ledger;
  }

  function ensureBudgetReady() {
    if (!__budgetReady) {
      __budgetReady = initBudgetLedger().catch(e => {
        // 失败时清空，下次重试
        __budgetReady = null;
        __budgetLedger = null;
        throw e;
      });
    }
    return __budgetReady;
  }

  async function resetBudgetLedger() {
    __budgetReady = null;
    __budgetLedger = null;
    return ensureBudgetReady();
  }

  function getBudgetLedger() {
    if (!__budgetLedger) throw new Error('budget ledger 尚未初始化，请先 await ensureBudgetReady()');
    return __budgetLedger;
  }

  // ============================================================================
  // 准入 + 写入（必须在 dnrQueue 内调用）
  // ============================================================================
  async function admitAndApplyInternal(pool, { addRules = [], removeRuleIds = [] } = {}) {
    const ledger = await ensureBudgetReady();

    // 早失败：pool 必须存在
    if (!ledger.pools[pool]) {
      throw new Error(`admitAndApplyInternal: unknown pool ${pool}`);
    }

    const snap = ledger.snapshot();

    try {
      // 1. removeRuleIds 必须属于声明的 pool
      for (const id of removeRuleIds) {
        const p = inferPoolFromId(id);
        if (p !== pool) {
          throw new Error(`removeRuleId ${id} 属于 ${p}，不能由 ${pool} 释放`);
        }
      }

      // 2. 释放旧额度（在准入前，允许 same-call 的 remove + add）
      ledger.release(removeRuleIds);

      // 3. 准入检查
      const counts = analyzeRules(addRules);
      const check = ledger.canAdmit(pool, addRules.length, counts);
      if (!check.ok) {
        ledger.restore(snap);
        return { ok: false, reason: check.reason };
      }

      // 4. 写入 DNR
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });

      // 5. 提交账本
      ledger.commit(pool, addRules);
      return { ok: true };
    } catch (e) {
      ledger.restore(snap);
      throw e;
    }
  }

  // ============================================================================
  // 快照（供消息）
  // ============================================================================
  async function getBudgetSnapshot() {
    const ledger = await ensureBudgetReady();
    return ledger.describe();
  }

  // ============================================================================
  // 导出到全局（classic worker / window 均可）
  // ============================================================================
  global.BudgetLedger = BudgetLedger;
  global.POOL_ID_RANGES = POOL_ID_RANGES;
  global.DEFAULT_BUDGET_CONFIG = DEFAULT_BUDGET_CONFIG;
  global.normalizeBudgetConfig = normalizeBudgetConfig;
  global.inferPoolFromId = inferPoolFromId;
  global.analyzeRules = analyzeRules;

  global.ensureBudgetReady = ensureBudgetReady;
  global.resetBudgetLedger = resetBudgetLedger;
  global.getBudgetLedger = getBudgetLedger;
  global.admitAndApplyInternal = admitAndApplyInternal;
  global.getBudgetSnapshot = getBudgetSnapshot;

})(typeof self !== 'undefined' ? self : globalThis);
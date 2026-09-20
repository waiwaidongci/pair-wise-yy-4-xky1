/*
 * 数据保存层：负责读写持久存储、旧版数据迁移、事务串行化与并发去重。
 * 不依赖 DOM 事件，只暴露命令式 API；页面层订阅 state 变化后自行渲染。
 *
 * UMD：浏览器挂到 window.DiveStore，Node 下可注入内存存储用于测试。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rules.js"));
  } else root.DiveStore = factory(root.DiveRules);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  const STORAGE_KEY = "diveStation.state.v1";
  const LEGACY_KEY = "zfl30Marks"; // 旧版“水下考古潜水记录”的标记存储
  const PREFS_KEY = "diveStation.prefs.v1";

  function nowISO() { return new Date().toISOString(); }

  class Store {
    /**
     * @param storage  需具备 getItem/setItem 的对象（localStorage 或测试用内存版）
     * @param opts.now 可注入时钟，便于测试
     */
    constructor(storage, opts) {
      this.storage = storage;
      this.now = (opts && opts.now) || nowISO;
      this.listeners = new Set();
      this.queue = Promise.resolve();
      this.inflight = new Set(); // 一次性动作的在途标记：并发提交只成功一次
      this.state = this._load();
    }

    // ---------- 持久化 ----------

    _load() {
      let raw = null;
      try { raw = this.storage.getItem(STORAGE_KEY); } catch (_) { /* 隐私模式等 */ }
      if (raw) {
        try {
          const state = JSON.parse(raw);
          if (state && state.schema === 1) return this._repair(state);
        } catch (_) { /* 损坏则回退到种子 */ }
      }
      const migrated = this._migrateLegacy();
      const state = migrated || this._seed();
      this._persist(state);
      return state;
    }

    _persist(state) {
      state.version = (state.version || 0) + 1;
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (err) { console.error("保存失败（内存中仍保留本次修改）：", err); }
      return state;
    }

    _repair(state) {
      state.version = state.version || 0;
      state.divers ||= [];
      state.dives ||= [];
      for (const d of state.dives) {
        d.events ||= [];
        d.marks ||= [];
        d.reviewSeq ||= 0;
      }
      return state;
    }

    /** 把旧版扁平标记迁移成“潜水员 + 潜次 + 标记”结构（只执行一次） */
    _migrateLegacy() {
      let raw = null;
      try { raw = this.storage.getItem(LEGACY_KEY); } catch (_) { return null; }
      if (!raw) return null;
      let legacy;
      try { legacy = JSON.parse(raw); } catch (_) { return null; }
      if (!Array.isArray(legacy) || !legacy.length) return null;

      const state = R.createState();
      const ts = this.now();
      const lead = { id: R.uid(), name: "陈潜（迁移）", certDepth: 30 };
      const buddy = { id: R.uid(), name: "林溯（迁移）", certDepth: 25 };
      state.divers.push(lead, buddy);

      const groups = new Map();
      for (const m of legacy) groups.set(m.dive || "DIVE-OLD", [...(groups.get(m.dive || "DIVE-OLD") || []), m]);

      let i = 0;
      for (const [code, items] of groups) {
        i += 1;
        const marks = items.map(m => ({
          id: m.id || R.uid(),
          code: m.code || "M-" + i,
          type: R.MARK_TYPES.includes(m.type) ? m.type : "unknown",
          depth: parseDepth(m.depth),
          orientation: m.orientation || "",
          condition: m.condition || "",
          note: m.note || "",
          x: Number(m.x) || 50,
          y: Number(m.y) || 50
        }));
        const dive = {
          id: R.uid(), code,
          diverA: lead.id, diverB: buddy.id,
          plannedDepth: 18, limitDepth: Math.min(lead.certDepth, buddy.certDepth),
          status: R.STATUS.OPEN, marks, seal: null, review: null, reviewSeq: 0,
          events: [{ at: ts, type: "migrated", by: null, detail: "由旧版标记迁移，资料补齐后可封存" }]
        };
        state.dives.push(dive);
      }
      try { this.storage.removeItem(STORAGE_KEY); this.storage.removeItem(LEGACY_KEY); } catch (_) { /* ignore */ }
      return state;
    }

    _seed() {
      const state = R.createState();
      const t = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
      const addDiver = (name, certDepth) => {
        const d = { id: R.uid(), name, certDepth };
        state.divers.push(d);
        return d;
      };
      const chen = addDiver("陈潜", 30);
      const lin = addDiver("林溯", 20);
      const zhou = addDiver("周海", 40);

      const makeMarks = (specs) => specs.map((s, i) => ({
        id: R.uid(), code: s.code, type: s.type, depth: s.depth,
        orientation: s.orientation, condition: s.condition,
        note: s.note || "", x: s.x, y: s.y
      }));
      const snap = (marks) => marks.map(m => ({ ...m }));

      // 1) 计划超限：林溯持证仅 20m，计划 24m，不得开始
      state.dives.push({
        id: R.uid(), code: "DIVE-04",
        diverA: chen.id, diverB: lin.id,
        plannedDepth: 24, limitDepth: null,
        status: R.STATUS.PLANNING, marks: [], seal: null, review: null, reviewSeq: 0,
        events: [{ at: t(2), type: "created", by: chen.id, detail: "绑定陈潜、林溯，计划深度24m" }]
      });

      // 2) 进行中：登记了一个缺保存状态的标记，尚不能封存
      const openMarks = makeMarks([
        { code: "W-003", type: "wood", depth: 18.2, orientation: "西北", condition: "稳定", note: "疑似横梁", x: 42, y: 38 },
        { code: "M-012", type: "metal", depth: 19.0, orientation: "", condition: "", note: "", x: 55, y: 47 }
      ]);
      state.dives.push({
        id: R.uid(), code: "DIVE-03",
        diverA: zhou.id, diverB: chen.id,
        plannedDepth: 19, limitDepth: 30,
        status: R.STATUS.OPEN, marks: openMarks, seal: null, review: null, reviewSeq: 0,
        events: [
          { at: t(26), type: "created", by: zhou.id, detail: "绑定周海、陈潜，计划深度19m" },
          { at: t(25), type: "started", by: zhou.id, detail: "持证上限30m，计划深度19m" },
          { at: t(24), type: "added", by: chen.id, detail: "新增标记 W-003" }
        ]
      });

      // 3) 待复核：陈潜封存，等待林溯复核
      const sealedMarks = makeMarks([
        { code: "A-017", type: "ceramic", depth: 17.8, orientation: "东", condition: "边缘残缺", note: "靠近船肋", x: 48, y: 46 }
      ]);
      state.dives.push({
        id: R.uid(), code: "DIVE-01",
        diverA: chen.id, diverB: lin.id,
        plannedDepth: 18, limitDepth: 20,
        status: R.STATUS.SEALED, marks: sealedMarks,
        seal: { by: chen.id, at: t(5), snapshot: snap(sealedMarks) },
        review: null, reviewSeq: 0,
        events: [
          { at: t(8), type: "created", by: chen.id, detail: "绑定陈潜、林溯，计划深度18m" },
          { at: t(7.5), type: "started", by: chen.id, detail: "持证上限20m，计划深度18m" },
          { at: t(6), type: "added", by: chen.id, detail: "新增标记 A-017" },
          { at: t(5), type: "sealed", by: chen.id, detail: "封存1个标记，等待另一人复核" }
        ]
      });

      // 4) 已复核
      const revMarks = makeMarks([
        { code: "W-001", type: "wood", depth: 15.5, orientation: "西南", condition: "表层海蛎附着", note: "", x: 36, y: 55 },
        { code: "A-021", type: "ceramic", depth: 16.1, orientation: "东北偏北", condition: "完整", note: "青瓷碗", x: 61, y: 40 }
      ]);
      state.dives.push({
        id: R.uid(), code: "DIVE-02",
        diverA: lin.id, diverB: chen.id,
        plannedDepth: 16.5, limitDepth: 20,
        status: R.STATUS.REVIEWED, marks: revMarks,
        seal: { by: lin.id, at: t(30), snapshot: snap(revMarks) },
        review: { by: chen.id, at: t(29), snapshot: snap(revMarks) },
        reviewSeq: 1,
        events: [
          { at: t(32), type: "created", by: lin.id, detail: "绑定林溯、陈潜，计划深度16.5m" },
          { at: t(31.5), type: "started", by: lin.id, detail: "持证上限20m，计划深度16.5m" },
          { at: t(31), type: "added", by: lin.id, detail: "新增标记 W-001、A-021" },
          { at: t(30), type: "sealed", by: lin.id, detail: "封存2个标记，等待另一人复核" },
          { at: t(29), type: "reviewed", by: chen.id, detail: "第1次复核确认" }
        ]
      });

      return state;
    }

    // ---------- 对外 API ----------

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    getState() { return this.state; }

    /**
     * 所有写操作串行执行：同一时刻只有一个事务进入规则层，
     * 对封存/复核这类一次性动作做在途拦截 —— 并发提交只有第一次会成功。
     */
    mutate(action, payload) {
      const guardKey = this._guardKey(action, payload);
      if (guardKey && this.inflight.has(guardKey)) {
        return Promise.reject(new R.DomainError("CONCURRENT",
          "已有相同的" + (action === "sealDive" ? "封存" : "复核") + "请求在处理中，请勿重复提交"));
      }
      if (guardKey) this.inflight.add(guardKey);

      const run = this.queue.then(() => {
        const ctx = { now: this.now, uid: R.uid };
        // 规则层直接改 draft；若抛错则丢弃 draft（未持久化），保证原子性
        const draft = JSON.parse(JSON.stringify(this.state));
        const result = R.dispatch(draft, action, payload, ctx);
        this._persist(draft);
        this.state = draft;
        this.listeners.forEach(fn => fn(this.state));
        return result;
      });
      this.queue = run.then(() => undefined, () => undefined);
      if (guardKey) {
        // 分别接成功/失败分支，避免 finally 派生 Promise 产生未处理拒绝
        run.then(() => this.inflight.delete(guardKey),
          () => this.inflight.delete(guardKey));
      }
      return run;
    }

    _guardKey(action, payload) {
      if (action === "sealDive") return "seal:" + payload.diveId;
      if (action === "confirmReview") return "review:" + payload.diveId;
      return null;
    }

    prefs() {
      try { return JSON.parse(this.storage.getItem(PREFS_KEY) || "{}"); }
      catch (_) { return {}; }
    }

    savePrefs(prefs) {
      try { this.storage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ }
    }
  }

  function parseDepth(v) {
    if (typeof v === "number") return v;
    const n = parseFloat(String(v).replace(/[米mM]/g, ""));
    return Number.isFinite(n) ? n : "";
  }

  return { Store, STORAGE_KEY, LEGACY_KEY, PREFS_KEY };
});

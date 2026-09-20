/*
 * 潜次封存与标记复核台 —— 准入规则层（纯逻辑，无 DOM、无存储依赖）
 *
 * 业务规则：
 *  1. 每个潜次绑定两名不同潜水员，各有持证深度，潜次上限取两人较浅值；
 *     计划深度超过持证上限，潜次不得开始。
 *  2. 潜次内标记编号唯一；深度、朝向、保存状态缺任一项，不能封存。
 *  3. 封存后潜次进入“待复核”，须由封存人之外的另一名绑定潜水员复核确认；
 *     确认前台面始终显示封存原值（已复核后更正的，显示上一次确认值）。
 *  4. 封存后新增/更正/删除标记，潜次回到“待复核”；重复封存沿用首次封存结果。
 *
 * UMD：浏览器挂到 window.DiveRules，Node 下 module.exports 供测试使用。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiveRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATUS = {
    PLANNING: "planning", // 计划中（尚未开始）
    OPEN: "open",         // 进行中（可增改标记）
    SEALED: "sealed",     // 待复核（封存原值冻结）
    REVIEWED: "reviewed"  // 已复核（确认值生效）
  };

  const STATUS_NAMES = {
    planning: "计划中",
    open: "进行中",
    sealed: "待复核",
    reviewed: "已复核"
  };

  const MARK_TYPES = ["ceramic", "wood", "metal", "unknown"];
  const TYPE_NAMES = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };

  const ORIENTATIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北",
    "东北偏北", "东北偏东", "东南偏南", "西北偏北"];

  class DomainError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = "DomainError";
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function createState() {
    return { schema: 1, version: 0, divers: [], dives: [] };
  }

  // ---------- 只读查询 ----------

  function diverById(state, id) {
    return state.divers.find(d => d.id === id) || null;
  }

  function getDive(state, id) {
    const dive = state.dives.find(d => d.id === id);
    if (!dive) throw new DomainError("DIVE_NOT_FOUND", "潜次不存在");
    return dive;
  }

  /** 潜次持证深度上限 = 两名绑定潜水员持证深度的较浅值 */
  function certLimit(state, diverA, diverB) {
    const a = diverById(state, diverA);
    const b = diverById(state, diverB);
    if (!a || !b) throw new DomainError("DIVER_MISSING", "两名潜水员都必须在花名册中");
    if (a.id === b.id) throw new DomainError("DIVER_SAME", "必须绑定两名不同的潜水员");
    return Math.min(Number(a.certDepth), Number(b.certDepth));
  }

  function startReadiness(state, dive) {
    const errors = [];
    if (dive.status !== STATUS.PLANNING) {
      errors.push("潜次已经开始");
      return { ok: false, errors };
    }
    if (!dive.diverA || !dive.diverB) errors.push("尚未绑定两名潜水员");
    else {
      try {
        const limit = certLimit(state, dive.diverA, dive.diverB);
        if (!(Number(dive.plannedDepth) > 0)) errors.push("计划深度未填写");
        else if (Number(dive.plannedDepth) > limit) {
          errors.push("计划深度 " + fmtDepth(dive.plannedDepth) +
            " 超过持证上限 " + fmtDepth(limit) + "，不得开始");
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /** 封存前检查：至少一个标记、编号唯一、深度/朝向/保存状态齐全 */
  function sealReadiness(dive) {
    const errors = [];
    if (dive.status === STATUS.PLANNING) errors.push("潜次尚未开始，不能封存");
    if (dive.marks.length === 0) errors.push("潜次内还没有标记，至少登记一个");

    const seen = new Map();
    for (const m of dive.marks) {
      const code = (m.code || "").trim();
      if (!code) { errors.push("存在没有编号的标记"); continue; }
      if (seen.has(code)) errors.push("编号重复：" + code + "（潜次内编号必须唯一）");
      seen.set(code, m.id);
      const missingDepth = m.depth === "" || m.depth === null || m.depth === undefined ||
        !Number.isFinite(Number(m.depth));
      if (missingDepth) errors.push("标记 " + code + " 缺少深度");
      if (!(m.orientation || "").trim()) errors.push("标记 " + code + " 缺少朝向");
      if (!(m.condition || "").trim()) errors.push("标记 " + code + " 缺少保存状态");
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * 台面应显示的标记值（原值）：
   *  - 计划中/进行中：实时工作值；
   *  - 待复核（从未确认）：首次封存快照；
   *  - 已复核：最近一次确认的快照；
   *  - 已复核后更正、回到待复核：仍显示上一次确认值，直到新复核确认。
   */
  function effectiveMarks(dive) {
    if (dive.status === STATUS.PLANNING || dive.status === STATUS.OPEN) return dive.marks;
    if (dive.review) return dive.review.snapshot;
    if (dive.seal) return dive.seal.snapshot;
    return dive.marks;
  }

  /** 冻结值与工作值不一致的标记 id（新增或更正后等待复核） */
  function pendingMarkIds(dive) {
    if (dive.status !== STATUS.SEALED && dive.status !== STATUS.REVIEWED) return new Set();
    const frozen = effectiveMarks(dive);
    const frozenMap = new Map(frozen.map(m => [m.id, m]));
    const ids = new Set();
    for (const m of dive.marks) {
      const f = frozenMap.get(m.id);
      if (!f || !sameMark(m, f)) ids.add(m.id);
    }
    return ids;
  }

  function sameMark(a, b) {
    const keys = ["code", "type", "depth", "orientation", "condition", "note", "x", "y"];
    return keys.every(k => String(a[k] ?? "") === String(b[k] ?? ""));
  }

  function fmtDepth(v) {
    return (Math.round(Number(v) * 10) / 10) + "m";
  }

  function boundDiverIds(dive) {
    return [dive.diverA, dive.diverB];
  }

  // ---------- 变更（由保存层在单一事务中调用） ----------

  function pushEvent(dive, type, by, now, detail) {
    dive.events.push({ at: now, type, by: by || null, detail: detail || null });
  }

  const handlers = {
    addDiver(state, payload, ctx) {
      const name = (payload.name || "").trim();
      const certDepth = Number(payload.certDepth);
      if (!name) throw new DomainError("BAD_INPUT", "潜水员姓名不能为空");
      if (!(certDepth > 0)) throw new DomainError("BAD_INPUT", "持证深度必须是大于 0 的米数");
      const diver = { id: ctx.uid(), name, certDepth };
      state.divers.push(diver);
      return { diver };
    },

    createDive(state, payload, ctx) {
      const code = (payload.code || "").trim();
      if (!code) throw new DomainError("BAD_INPUT", "潜次编号不能为空");
      if (state.dives.some(d => d.code.toLowerCase() === code.toLowerCase())) {
        throw new DomainError("DIVE_CODE_DUP", "潜次编号已存在：" + code);
      }
      // 绑定阶段就强制两名不同潜水员（开始前可改派，故先校验存在性与互异）
      if (!payload.diverA || !payload.diverB) {
        throw new DomainError("DIVER_MISSING", "必须绑定两名潜水员");
      }
      certLimit(state, payload.diverA, payload.diverB); // 互异且在册校验
      const plannedDepth = Number(payload.plannedDepth);
      if (!(plannedDepth > 0)) throw new DomainError("BAD_INPUT", "计划深度必须是大于 0 的米数");

      const dive = {
        id: ctx.uid(),
        code,
        diverA: payload.diverA,
        diverB: payload.diverB,
        plannedDepth,
        limitDepth: null, // 开始瞬间才固化持证上限
        status: STATUS.PLANNING,
        marks: [],
        seal: null,
        review: null,
        reviewSeq: 0,
        events: []
      };
      pushEvent(dive, "created", payload.by || null, ctx.now(),
        "绑定 " + diverById(state, dive.diverA).name + "、" + diverById(state, dive.diverB).name +
        "，计划深度 " + fmtDepth(plannedDepth));
      state.dives.push(dive);
      return { dive };
    },

    /** 计划阶段改派潜水员或调整计划深度（开始后固化，不允许修改） */
    updatePlan(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);
      if (dive.status !== STATUS.PLANNING) {
        throw new DomainError("DIVE_STARTED", "潜次已经开始，绑定与计划深度不可修改");
      }
      if (payload.diverA && payload.diverB) {
        certLimit(state, payload.diverA, payload.diverB);
        dive.diverA = payload.diverA;
        dive.diverB = payload.diverB;
      }
      if (payload.plannedDepth !== undefined) {
        const plannedDepth = Number(payload.plannedDepth);
        if (!(plannedDepth > 0)) throw new DomainError("BAD_INPUT", "计划深度必须是大于 0 的米数");
        dive.plannedDepth = plannedDepth;
      }
      pushEvent(dive, "planned", payload.by || null, ctx.now(), "调整潜次计划");
      return { dive };
    },

    startDive(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);
      const ready = startReadiness(state, dive);
      if (!ready.ok) throw new DomainError("START_BLOCKED", ready.errors[0], { errors: ready.errors });
      dive.limitDepth = certLimit(state, dive.diverA, dive.diverB);
      dive.status = STATUS.OPEN;
      pushEvent(dive, "started", payload.by || null, ctx.now(),
        "持证上限 " + fmtDepth(dive.limitDepth) + "，计划深度 " + fmtDepth(dive.plannedDepth));
      return { dive };
    },

    upsertMark(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);
      if (dive.status === STATUS.PLANNING) {
        throw new DomainError("DIVE_NOT_STARTED", "潜次尚未开始，不能登记标记");
      }
      const data = payload.data || {};
      const code = (data.code || "").trim();
      if (!code) throw new DomainError("BAD_INPUT", "标记编号不能为空");
      const dup = dive.marks.find(m =>
        m.code.trim().toLowerCase() === code.toLowerCase() && m.id !== (data.id || null));
      if (dup) throw new DomainError("MARK_CODE_DUP", "该潜次内编号已存在：" + code);
      const type = MARK_TYPES.includes(data.type) ? data.type : "unknown";
      const depth = data.depth === "" || data.depth === undefined || data.depth === null
        ? "" : Number(data.depth);

      let mark, action;
      if (data.id) {
        mark = dive.marks.find(m => m.id === data.id);
        if (!mark) throw new DomainError("MARK_NOT_FOUND", "标记不存在");
        const next = {
          code, type, depth,
          orientation: (data.orientation || "").trim(),
          condition: (data.condition || "").trim(),
          note: data.note || "",
          x: clampPos(data.x, mark.x), y: clampPos(data.y, mark.y)
        };
        const changed = Object.keys(next).some(k => String(mark[k] ?? "") !== String(next[k] ?? ""));
        if (!changed && (dive.status === STATUS.SEALED || dive.status === STATUS.REVIEWED)) {
          return { mark, amended: false, unchanged: true }; // 原值保存不算更正
        }
        Object.assign(mark, next);
        action = "edited";
      } else {
        mark = {
          id: ctx.uid(), code, type, depth,
          orientation: (data.orientation || "").trim(),
          condition: (data.condition || "").trim(),
          note: data.note || "",
          x: clampPos(data.x, 50), y: clampPos(data.y, 50)
        };
        dive.marks.push(mark);
        action = "added";
      }

      const amended = dive.status === STATUS.SEALED || dive.status === STATUS.REVIEWED;
      if (amended) {
        // 新增或更正：回到待复核；封存快照（首次结果）保持不动
        dive.status = STATUS.SEALED;
        pushEvent(dive, "amended", payload.by || null, ctx.now(),
          (action === "added" ? "新增标记 " : "更正标记 ") + code);
      }
      return { mark, amended, action };
    },

    deleteMark(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);
      if (dive.status === STATUS.PLANNING) {
        throw new DomainError("DIVE_NOT_STARTED", "潜次尚未开始");
      }
      const idx = dive.marks.findIndex(m => m.id === payload.markId);
      if (idx < 0) throw new DomainError("MARK_NOT_FOUND", "标记不存在");
      const [removed] = dive.marks.splice(idx, 1);
      const amended = dive.status === STATUS.SEALED || dive.status === STATUS.REVIEWED;
      if (amended) {
        dive.status = STATUS.SEALED;
        pushEvent(dive, "amended", payload.by || null, ctx.now(), "删除标记 " + removed.code);
      }
      return { removed, amended };
    },

    sealDive(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);

      // 重复封存沿用首次结果：快照、封存人、时间一律不变
      if (dive.seal) return { reused: true, seal: dive.seal, dive };

      const ready = sealReadiness(dive);
      if (!ready.ok) {
        throw new DomainError("SEAL_NOT_READY", "尚不能封存：" + ready.errors[0], { errors: ready.errors });
      }
      if (!payload.by || !boundDiverIds(dive).includes(payload.by)) {
        throw new DomainError("FORBIDDEN", "封存须由本潜次绑定的潜水员操作");
      }
      dive.seal = {
        by: payload.by,
        at: ctx.now(),
        snapshot: dive.marks.map(m => ({ ...m })) // 封存原值冻结
      };
      dive.status = STATUS.SEALED;
      pushEvent(dive, "sealed", payload.by, dive.seal.at, "封存 " + dive.marks.length + " 个标记，等待另一人复核");
      return { reused: false, seal: dive.seal, dive };
    },

    confirmReview(state, payload, ctx) {
      const dive = getDive(state, payload.diveId);
      if (!dive.seal) throw new DomainError("NOT_SEALED", "尚未封存，不能复核");

      // 已经是最新确认、且没有新增/更正时，重复确认沿用已有结果
      if (dive.status === STATUS.REVIEWED) {
        return { reused: true, review: dive.review, dive };
      }
      if (dive.status !== STATUS.SEALED) {
        throw new DomainError("BAD_STATE", "当前状态不能复核");
      }
      const reviewer = payload.by;
      if (!reviewer || !boundDiverIds(dive).includes(reviewer)) {
        throw new DomainError("FORBIDDEN", "复核须由本潜次绑定的潜水员操作");
      }
      if (reviewer === dive.seal.by) {
        throw new DomainError("REVIEWER_SAME", "复核人必须是封存人之外的另一名潜水员");
      }
      const ready = sealReadiness(dive); // 更正期间可能删空或改缺字段
      if (!ready.ok) {
        throw new DomainError("SEAL_NOT_READY", "数据不完整，不能确认复核：" + ready.errors[0],
          { errors: ready.errors });
      }
      dive.review = {
        by: reviewer,
        at: ctx.now(),
        snapshot: dive.marks.map(m => ({ ...m }))
      };
      dive.reviewSeq += 1;
      dive.status = STATUS.REVIEWED;
      pushEvent(dive, "reviewed", reviewer, dive.review.at,
        "第 " + dive.reviewSeq + " 次复核确认（封存后有过更正时显示新值）");
      return { reused: false, review: dive.review, dive };
    }
  };

  function clampPos(v, fallback) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(100, Math.max(0, n));
    return fallback;
  }

  function dispatch(state, action, payload, ctx) {
    const handler = handlers[action];
    if (!handler) throw new DomainError("UNKNOWN_ACTION", "未知操作：" + action);
    return handler(state, payload || {}, ctx || { now: () => new Date().toISOString(), uid });
  }

  return {
    STATUS, STATUS_NAMES, MARK_TYPES, TYPE_NAMES, ORIENTATIONS,
    DomainError, uid, createState, dispatch,
    diverById, getDive, certLimit, startReadiness, sealReadiness,
    effectiveMarks, pendingMarkIds, boundDiverIds, fmtDepth, handlers
  };
});

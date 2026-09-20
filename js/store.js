/* 数据保存层：localStorage 持久化，所有写操作经互斥锁串行化。
   并发提交只成功一次：优先 Web Locks（跨标签页互斥），退化为页内队列；
   每次变更在锁内重读最新状态再判定，重复封存沿用首次结果。 */
window.UWStore = (() => {
  const R = window.UWRules;
  const KEY = "uwArchive.v1";
  const LOCK = "uw-archive-lock";
  const listeners = new Set();

  function uid() {
    return (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  let state = load() || seed();

  function persist() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { listeners.forEach(fn => fn(state)); }
  function getState() { return state; }

  const hasLocks = typeof navigator !== "undefined" && navigator.locks && navigator.locks.request;
  let queue = Promise.resolve();
  function enqueue(job) {
    if (hasLocks) return navigator.locks.request(LOCK, job);
    const p = queue.then(job, job);
    queue = p.catch(() => {});
    return p;
  }

  /* 全部写操作入口：锁内重读 → 规则校验/变更 → 持久化 → 通知 */
  function mutate(recipe) {
    return enqueue(() => {
      state = load() || state;
      const result = recipe(state) || { ok: true };
      if (result.persist !== false) persist();
      emit();
      return result;
    });
  }

  const actor = (st) => st.ui.currentUserId;
  const log = (dive, by, event, detail) => dive.history.push({ at: Date.now(), by, event, detail });

  function markerFields(data) {
    return {
      code: String(data.code || "").trim(),
      type: data.type,
      depth: R.blank(data.depth) ? "" : Number(data.depth),
      orientation: String(data.orientation || "").trim(),
      condition: String(data.condition || "").trim(),
      note: String(data.note || "").trim()
    };
  }

  /* 待封存中标记被改缺/删缺 → 退回进行中 */
  function demoteIfIncomplete(st, d, by) {
    if (d.status !== R.STATUS.PENDING_SEAL) return;
    if (!R.completeness(st, d.id).ok) {
      d.status = R.STATUS.ACTIVE;
      log(d, by, "reopened", "标记资料不全，退回进行中");
    }
  }

  /* 已确认潜次新增或更正 → 回到待复核 */
  function reopenIfConfirmed(d, by, detail) {
    if (d.status === R.STATUS.CONFIRMED) {
      d.status = R.STATUS.PENDING_REVIEW;
      log(d, by, "reopened", detail);
    }
  }

  const api = { subscribe, getState };

  api.setUi = (patch) => mutate(st => {
    Object.assign(st.ui, patch);
    return { ok: true };
  });

  api.addDive = (data) => mutate(st => {
    const check = R.validateDiveInput(st, data);
    if (!check.ok) return check;
    const d = {
      id: uid(),
      code: String(data.code).trim(),
      diverAId: data.diverAId,
      diverBId: data.diverBId,
      plannedDepth: Number(data.plannedDepth),
      status: R.STATUS.PLANNED,
      seal: null,
      review: null,
      createdAt: Date.now(),
      history: []
    };
    log(d, actor(st), "created", "创建潜次");
    st.dives.push(d);
    st.ui.formDiveId = d.id;
    return { ok: true, dive: d };
  });

  api.startDive = (diveId) => mutate(st => {
    const check = R.canStart(st, diveId);
    if (!check.ok) return check;
    const d = R.dive(st, diveId);
    d.status = R.STATUS.ACTIVE;
    log(d, actor(st), "started", "潜次开始");
    return { ok: true };
  });

  api.submitSeal = (diveId) => mutate(st => {
    const check = R.canSubmitSeal(st, diveId);
    if (!check.ok) return check;
    const d = R.dive(st, diveId);
    d.status = R.STATUS.PENDING_SEAL;
    log(d, actor(st), "submitted", "转待封存");
    return { ok: true };
  });

  api.sealDive = (diveId) => mutate(st => {
    const check = R.canSeal(st, diveId);
    if (!check.ok) return check;
    const d = R.dive(st, diveId);
    if (d.seal) return { ok: true, reused: true, seal: d.seal }; // 重复封存沿用首次结果
    d.seal = {
      by: actor(st),
      at: Date.now(),
      snapshot: R.diveMarkers(st, diveId).map(m => R.committed(m))
    };
    d.status = R.STATUS.PENDING_REVIEW;
    log(d, actor(st), "sealed", "封存潜次");
    return { ok: true, reused: false, seal: d.seal };
  });

  api.confirmDive = (diveId) => mutate(st => {
    const check = R.canConfirm(st, diveId, actor(st));
    if (!check.ok) return check;
    const d = R.dive(st, diveId);
    for (const m of st.markers.filter(m => m.diveId === diveId && m.pending)) {
      if (!m.pending.add && m.pending.fields) Object.assign(m, m.pending.fields); // 复核确认后更正生效
      m.pending = null;
    }
    d.status = R.STATUS.CONFIRMED;
    d.review = { by: actor(st), at: Date.now() };
    log(d, actor(st), "confirmed", "复核确认");
    return { ok: true };
  });

  api.saveMarker = (data) => mutate(st => {
    const check = R.validateMarkerInput(st, data, data.id || null);
    if (!check.ok) return check;
    const d = R.dive(st, data.diveId);
    const mode = R.editMode(d);
    const by = actor(st);
    if (data.id) {
      const m = st.markers.find(x => x.id === data.id);
      if (!m) return R.fail("标记不存在");
      if (m.diveId !== d.id) return R.fail("标记不属于该潜次");
      if (mode === "direct") {
        Object.assign(m, markerFields(data));
        log(d, by, "edited", "更正标记 " + m.code);
        demoteIfIncomplete(st, d, by);
        return { ok: true, pendingReview: false };
      }
      // 已封存：存为待复核更正，确认前仍显示原值
      m.pending = { add: false, by, at: Date.now(), fields: markerFields(data) };
      if (d.status === R.STATUS.CONFIRMED) reopenIfConfirmed(d, by, "更正标记 " + m.code + "，回到待复核");
      else log(d, by, "edited", "提交标记更正 " + m.code + "（待复核）");
      return { ok: true, pendingReview: true };
    }
    const marker = Object.assign(
      { id: uid(), diveId: d.id, x: data.x, y: data.y, createdAt: Date.now(), pending: null },
      markerFields(data)
    );
    if (mode === "review") {
      marker.pending = { add: true, by, at: Date.now(), fields: null };
      if (d.status === R.STATUS.CONFIRMED) reopenIfConfirmed(d, by, "新增标记 " + marker.code + "，回到待复核");
      else log(d, by, "added", "新增标记 " + marker.code + "（待复核）");
    } else {
      log(d, by, "added", "新增标记 " + marker.code);
    }
    st.markers.push(marker);
    demoteIfIncomplete(st, d, by);
    return { ok: true, pendingReview: mode === "review", marker };
  });

  api.deleteMarker = (id) => mutate(st => {
    const m = st.markers.find(x => x.id === id);
    if (!m) return R.fail("标记不存在");
    const d = R.dive(st, m.diveId);
    const mode = R.editMode(d);
    if (mode === "none") return R.fail("潜次尚未开始");
    if (mode === "review" && !(m.pending && m.pending.add)) {
      return R.fail("潜次已封存，标记不可删除，可通过更正流程修改");
    }
    st.markers = st.markers.filter(x => x.id !== id);
    log(d, actor(st), "deleted", "删除标记 " + m.code);
    demoteIfIncomplete(st, d, actor(st));
    return { ok: true };
  });

  api.resetAll = () => mutate(st => {
    const fresh = seed();
    for (const k of Object.keys(st)) delete st[k];
    Object.assign(st, fresh);
    return { ok: true };
  });

  /* 其他标签页写入后同步刷新，保证各页面一致 */
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", (e) => {
      if (e.key !== KEY) return;
      const fresh = load();
      if (fresh) { state = fresh; emit(); }
    });
  }

  if (!load()) persist(); // 首次使用写入种子数据

  return api;

  function seed() {
    const now = Date.now();
    const h = 3600000;
    const day = 24 * h;
    const people = [
      { id: "p-zhang", name: "张海", certifiedDepth: 30 },
      { id: "p-li", name: "李岚", certifiedDepth: 30 },
      { id: "p-wang", name: "王潜", certifiedDepth: 18 },
      { id: "p-chen", name: "陈瑚", certifiedDepth: 40 }
    ];
    const dives = [
      {
        id: "d-1", code: "DIVE-01", diverAId: "p-zhang", diverBId: "p-li",
        plannedDepth: 18, status: "active", seal: null, review: null,
        createdAt: now - 3 * day,
        history: [
          { at: now - 3 * day, by: "p-zhang", event: "created", detail: "创建潜次" },
          { at: now - 3 * day + h, by: "p-zhang", event: "started", detail: "潜次开始" }
        ]
      },
      {
        id: "d-2", code: "DIVE-02", diverAId: "p-wang", diverBId: "p-chen",
        plannedDepth: 24, status: "planned", seal: null, review: null,
        createdAt: now - 2 * day,
        history: [{ at: now - 2 * day, by: "p-chen", event: "created", detail: "创建潜次" }]
      },
      {
        id: "d-3", code: "DIVE-03", diverAId: "p-zhang", diverBId: "p-chen",
        plannedDepth: 20, status: "pending_review",
        seal: {
          by: "p-li", at: now - day,
          snapshot: [{ id: "m-c011", diveId: "d-3", code: "C-011", type: "ceramic", x: 45, y: 40, depth: 20.1, orientation: "北", condition: "完好", note: "舱内成摞", createdAt: now - 2 * day }]
        },
        review: null,
        createdAt: now - 4 * day,
        history: [
          { at: now - 4 * day, by: "p-zhang", event: "created", detail: "创建潜次" },
          { at: now - 4 * day + h, by: "p-zhang", event: "started", detail: "潜次开始" },
          { at: now - 2 * day, by: "p-chen", event: "submitted", detail: "转待封存" },
          { at: now - day, by: "p-li", event: "sealed", detail: "封存潜次" },
          { at: now - 5 * h, by: "p-chen", event: "edited", detail: "提交标记更正 C-011（待复核）" }
        ]
      }
    ];
    const markers = [
      { id: "m-a017", diveId: "d-1", code: "A-017", type: "ceramic", x: 42, y: 46, depth: 17.8, orientation: "东", condition: "边缘残缺", note: "靠近船肋", createdAt: now - 3 * day + 2 * h, pending: null },
      { id: "m-w003", diveId: "d-1", code: "W-003", type: "wood", x: 58, y: 39, depth: 18.2, orientation: "西北", condition: "稳定", note: "疑似横梁", createdAt: now - 3 * day + 3 * h, pending: null },
      { id: "m-m003", diveId: "d-1", code: "M-003", type: "metal", x: 50, y: 60, depth: 18, orientation: "东南", condition: "", note: "", createdAt: now - 3 * day + 4 * h, pending: null },
      {
        id: "m-c011", diveId: "d-3", code: "C-011", type: "ceramic", x: 45, y: 40, depth: 20.1, orientation: "北", condition: "完好", note: "舱内成摞",
        createdAt: now - 2 * day,
        pending: { add: false, by: "p-chen", at: now - 5 * h, fields: { code: "C-011", type: "ceramic", depth: 20.6, orientation: "北", condition: "局部附着珊瑚", note: "舱内成摞" } }
      }
    ];
    return {
      people, dives, markers,
      ui: { filterType: "", filterDive: "", view: "list", currentUserId: "p-zhang", formDiveId: "d-1" }
    };
  }
})();

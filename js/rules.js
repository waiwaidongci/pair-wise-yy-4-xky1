/* 准入规则层：纯函数，只依赖传入的状态，不触碰 DOM 与存储。
   所有"能不能做"的判定都在这里，供数据层与页面层共同调用。 */
window.UWRules = (() => {
  const STATUS = {
    PLANNED: "planned",           // 计划中
    ACTIVE: "active",             // 进行中
    PENDING_SEAL: "pending_seal", // 待封存
    PENDING_REVIEW: "pending_review", // 待复核
    CONFIRMED: "confirmed"        // 已确认
  };
  const STATUS_NAMES = {
    planned: "计划中",
    active: "进行中",
    pending_seal: "待封存",
    pending_review: "待复核",
    confirmed: "已确认"
  };
  // 待封存前必须齐全的标记字段
  const REQUIRED_FIELDS = [
    ["code", "编号"],
    ["depth", "深度"],
    ["orientation", "朝向"],
    ["condition", "保存状态"]
  ];
  const MARKER_FIELDS = ["code", "type", "depth", "orientation", "condition", "note"];

  const ok = (extra) => Object.assign({ ok: true }, extra);
  const fail = (reason) => ({ ok: false, reason });
  const blank = (v) => v === undefined || v === null || String(v).trim() === "";

  const person = (state, id) => state.people.find(p => p.id === id) || null;
  const personName = (state, id) => { const p = person(state, id); return p ? p.name : "未知人员"; };
  const dive = (state, diveId) => state.dives.find(d => d.id === diveId) || null;
  const diveMarkers = (state, diveId) => state.markers.filter(m => m.diveId === diveId);

  /* 潜次持证深度：两名潜水员持证深度的较低值 */
  function certifiedDepth(state, d) {
    const a = person(state, d.diverAId);
    const b = person(state, d.diverBId);
    if (!a || !b) return null;
    return Math.min(a.certifiedDepth, b.certifiedDepth);
  }

  /* 潜次绑定两名不同潜水员 */
  function validateDiveInput(state, data) {
    if (blank(data.code)) return fail("潜次编号不能为空");
    if (state.dives.some(d => d.code === String(data.code).trim())) return fail("潜次编号已存在");
    if (blank(data.diverAId) || blank(data.diverBId)) return fail("潜次须绑定两名潜水员");
    if (data.diverAId === data.diverBId) return fail("两名潜水员不能是同一人");
    if (!person(state, data.diverAId) || !person(state, data.diverBId)) return fail("所选潜水员不存在");
    if (!(Number(data.plannedDepth) > 0)) return fail("计划深度必须为正数");
    return ok();
  }

  /* 计划深度超限不得开始 */
  function canStart(state, diveId) {
    const d = dive(state, diveId);
    if (!d) return fail("潜次不存在");
    if (d.status !== STATUS.PLANNED) return fail("仅计划中的潜次可以开始");
    if (d.diverAId === d.diverBId) return fail("两名潜水员不能是同一人");
    const limit = certifiedDepth(state, d);
    if (limit === null) return fail("潜水员信息缺失");
    if (d.plannedDepth > limit) return fail("计划深度 " + d.plannedDepth + "m 超过持证深度 " + limit + "m，不得开始");
    return ok();
  }

  /* 标记缺了哪些必填项（深度/朝向/保存状态等） */
  function markerIssues(marker) {
    return REQUIRED_FIELDS.filter(([key]) => blank(marker[key])).map(([, label]) => label);
  }

  /* 确认前仍显示原值：展示与导出都取已确认值，忽略待复核更正 */
  function committed(marker) {
    const { pending, ...rest } = marker;
    return rest;
  }

  /* 潜次内编号唯一 + 深度/朝向/保存状态齐全 */
  function completeness(state, diveId) {
    const markers = diveMarkers(state, diveId);
    if (!markers.length) return fail("潜次内暂无标记，不能待封存");
    const incomplete = markers.filter(m => markerIssues(m).length);
    if (incomplete.length) {
      const parts = incomplete.map(m => (m.code || "（未编号）") + " 缺 " + markerIssues(m).join("/"));
      return fail("标记 " + parts.join("；") + "，不能待封存");
    }
    const seen = new Set();
    for (const m of markers) {
      if (seen.has(m.code)) return fail("编号 " + m.code + " 在潜次内重复");
      seen.add(m.code);
    }
    return ok();
  }

  function canSubmitSeal(state, diveId) {
    const d = dive(state, diveId);
    if (!d) return fail("潜次不存在");
    if (d.status !== STATUS.ACTIVE) return fail("仅进行中的潜次可转待封存");
    return completeness(state, diveId);
  }

  function canSeal(state, diveId) {
    const d = dive(state, diveId);
    if (!d) return fail("潜次不存在");
    if (d.seal) return ok({ reused: true }); // 重复封存沿用首次结果
    if (d.status !== STATUS.PENDING_SEAL) return fail("潜次不在待封存状态");
    return completeness(state, diveId);
  }

  /* 封存后由另一人复核 */
  function canConfirm(state, diveId, userId) {
    const d = dive(state, diveId);
    if (!d) return fail("潜次不存在");
    if (!d.seal) return fail("潜次尚未封存");
    if (d.status !== STATUS.PENDING_REVIEW) return fail("潜次不在待复核状态");
    if (d.seal.by === userId) return fail("须由另一人复核（封存人：" + personName(state, d.seal.by) + "）");
    return ok();
  }

  /* 标记编辑方式：进行中/待封存直接改；已封存（待复核/已确认）走待复核更正 */
  function editMode(d) {
    if (d.status === STATUS.ACTIVE || d.status === STATUS.PENDING_SEAL) return "direct";
    if (d.status === STATUS.PENDING_REVIEW || d.status === STATUS.CONFIRMED) return "review";
    return "none";
  }

  function validateMarkerInput(state, data, exceptId) {
    const d = dive(state, data.diveId);
    if (!d) return fail("潜次不存在");
    if (editMode(d) === "none") return fail("潜次尚未开始，不能登记标记");
    if (blank(data.code)) return fail("编号不能为空");
    const code = String(data.code).trim();
    if (state.markers.some(m => m.diveId === data.diveId && m.id !== exceptId && m.code === code)) {
      return fail("编号 " + code + " 在该潜次内已存在");
    }
    if (!blank(data.depth) && !(Number(data.depth) >= 0)) return fail("深度需为不小于 0 的数字");
    return ok();
  }

  return {
    STATUS, STATUS_NAMES, REQUIRED_FIELDS, MARKER_FIELDS,
    ok, fail, blank,
    person, personName, dive, diveMarkers,
    certifiedDepth, validateDiveInput, canStart,
    markerIssues, committed, completeness,
    canSubmitSeal, canSeal, canConfirm, editMode, validateMarkerInput
  };
})();

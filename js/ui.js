/* 页面交互层：只负责渲染与事件，所有变更通过 UWStore 提交，
   展示一律取已确认值（确认前仍显示原值），待复核内容以徽标/ diff 标出。 */
(() => {
  const R = window.UWRules;
  const S = window.UWStore;
  const $ = (sel) => document.querySelector(sel);

  const TYPE_NAMES = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  const FIELD_LABELS = { code: "编号", type: "类型", depth: "深度", orientation: "朝向", condition: "保存状态", note: "备注" };

  const mapEl = $("#map");
  const formEl = $("#form");
  const els = formEl.elements;
  const diveForm = $("#diveForm");
  const diveEls = diveForm.elements;
  const diveListEl = $("#diveList");
  const listEl = $("#list");
  const listTitle = $("#listTitle");
  const filterType = $("#filterType");
  const filterDive = $("#filterDive");
  const viewSel = $("#view");
  const userSelect = $("#userSelect");
  const markerHint = $("#markerHint");
  const diveHint = $("#diveHint");
  const saveMarkerBtn = $("#saveMarkerBtn");
  const deleteBtn = $("#deleteBtn");
  const toastEl = $("#toast");

  let editingId = null;   // 表单正在编辑的标记
  let pendingPos = null;  // 地图点击落下的新标记坐标
  let toastTimer = null;

  /* —— 工具 —— */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtTime = (ts) => { const d = new Date(ts); return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const fmtDepth = (v) => (v === "" || v === null || v === undefined ? "—" : v + "m");

  function toast(text, isError) {
    toastEl.textContent = text;
    toastEl.className = "toast" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3800);
  }
  async function call(p) {
    try { return await p; }
    catch (e) { console.error(e); toast("操作失败：" + (e && e.message ? e.message : e), true); return null; }
  }

  /* —— 渲染 —— */
  function render() {
    const state = S.getState();
    renderPeople(state);
    renderFilters(state);
    renderDives(state);
    renderMap(state);
    renderList(state);
    syncFormChrome(state);
  }

  const peopleOptions = (state) =>
    state.people.map(p => '<option value="' + p.id + '">' + esc(p.name) + "（持证 " + p.certifiedDepth + "m）</option>").join("");

  function renderPeople(state) {
    userSelect.innerHTML = peopleOptions(state);
    userSelect.value = state.ui.currentUserId;
    for (const sel of [diveEls.diverAId, diveEls.diverBId]) {
      const prev = sel.value;
      sel.innerHTML = peopleOptions(state);
      sel.value = prev && state.people.some(p => p.id === prev) ? prev : state.people[0].id;
    }
    if (diveEls.diverAId.value === diveEls.diverBId.value && state.people.length > 1) {
      diveEls.diverBId.value = state.people.find(p => p.id !== diveEls.diverAId.value).id;
    }
    syncDiveHint(state);
  }

  function renderFilters(state) {
    filterType.value = state.ui.filterType;
    filterDive.innerHTML = '<option value="">全部潜次</option>' +
      state.dives.map(d => '<option value="' + d.id + '">' + esc(d.code) + "</option>").join("");
    filterDive.value = state.ui.filterDive;
    viewSel.value = state.ui.view;
    // 标记表单只列出可登记标记的潜次
    const editable = state.dives.filter(d => R.editMode(d) !== "none");
    els.diveId.innerHTML = editable.map(d =>
      '<option value="' + d.id + '">' + esc(d.code) + "（" + R.STATUS_NAMES[d.status] + "）</option>").join("");
    els.diveId.value = editable.some(d => d.id === state.ui.formDiveId)
      ? state.ui.formDiveId
      : (editable[0] ? editable[0].id : "");
  }

  function renderDives(state) {
    diveListEl.innerHTML = state.dives.map(d => diveCard(state, d)).join("");
  }

  function diveCard(state, d) {
    const limit = R.certifiedDepth(state, d);
    const markers = R.diveMarkers(state, d.id);
    const incomplete = markers.filter(m => R.markerIssues(m).length).length;
    const pendings = markers.filter(m => m.pending).length;
    const over = limit !== null && d.plannedDepth > limit;
    const acts = {
      planned: ["start", "开始潜次"],
      active: ["submit", "转待封存"],
      pending_seal: ["seal", "封存"],
      pending_review: ["confirm", "复核确认"]
    };
    let gate = "";
    if (d.status === "planned") { const c = R.canStart(state, d.id); if (!c.ok) gate = c.reason; }
    if (d.status === "active") { const c = R.canSubmitSeal(state, d.id); if (!c.ok) gate = c.reason; }
    if (d.status === "pending_review") { const c = R.canConfirm(state, d.id, state.ui.currentUserId); if (!c.ok) gate = c.reason; }
    const sealLine = (d.seal ? "封存 " + esc(R.personName(state, d.seal.by)) + " " + fmtTime(d.seal.at) : "") +
      (d.review ? " · 复核 " + esc(R.personName(state, d.review.by)) + " " + fmtTime(d.review.at) : "");
    return '<div class="dive-card' + (state.ui.formDiveId === d.id ? " selected" : "") + '" data-id="' + d.id + '">'
      + '<div class="dive-head"><b>' + esc(d.code) + '</b><span class="pill st-' + d.status + '">' + R.STATUS_NAMES[d.status] + "</span></div>"
      + '<div class="muted">' + esc(R.personName(state, d.diverAId)) + " / " + esc(R.personName(state, d.diverBId))
      + " · 计划 " + d.plannedDepth + "m / 持证 " + (limit === null ? "—" : '<span class="' + (over ? "danger" : "") + '">' + limit + "m</span>") + "</div>"
      + '<div class="muted">标记 ' + markers.length
      + (incomplete ? ' · <span class="danger">资料不全 ' + incomplete + "</span>" : "")
      + (pendings ? ' · <span class="review-text">待复核 ' + pendings + "</span>" : "") + "</div>"
      + (sealLine ? '<div class="muted">' + sealLine + "</div>" : "")
      + (gate ? '<div class="gate">' + esc(gate) + "</div>" : "")
      + (acts[d.status] ? '<div class="dive-actions"><button type="button" data-act="' + acts[d.status][0] + '">' + acts[d.status][1] + "</button></div>" : "")
      + "</div>";
  }

  const filteredMarkers = (state) => state.markers.filter(m =>
    (!state.ui.filterType || m.type === state.ui.filterType) &&
    (!state.ui.filterDive || m.diveId === state.ui.filterDive));

  function renderMap(state) {
    mapEl.querySelectorAll(".marker").forEach(el => el.remove());
    for (const m of filteredMarkers(state)) {
      const c = R.committed(m);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + c.type
        + (m.pending ? (m.pending.add ? " pend-add" : " pend-chg") : "")
        + (m.id === editingId ? " selected" : "");
      el.style.left = c.x + "%";
      el.style.top = c.y + "%";
      el.textContent = c.code.slice(0, 2);
      el.title = c.code + " · " + (TYPE_NAMES[c.type] || c.type) + (m.pending ? "（待复核）" : "");
      el.addEventListener("click", (ev) => { ev.stopPropagation(); edit(m.id); });
      mapEl.appendChild(el);
    }
  }

  function badges(m) {
    const out = [];
    const issues = R.markerIssues(m);
    if (issues.length) out.push('<span class="pill warn">缺' + issues.join("/") + "</span>");
    if (m.pending && m.pending.add) out.push('<span class="pill review">新增待复核</span>');
    else if (m.pending) out.push('<span class="pill review">更正待复核</span>');
    return out.join(" ");
  }

  function dispField(k, v) {
    if (v === "" || v === null || v === undefined) return "—";
    if (k === "depth") return v + "m";
    if (k === "type") return TYPE_NAMES[v] || v;
    return String(v);
  }

  function diffLine(m) {
    if (!m.pending || m.pending.add || !m.pending.fields) return "";
    const parts = [];
    for (const k of Object.keys(FIELD_LABELS)) {
      if (String(m[k] ?? "") !== String(m.pending.fields[k] ?? "")) {
        parts.push(FIELD_LABELS[k] + " " + dispField(k, m[k]) + "→" + dispField(k, m.pending.fields[k]));
      }
    }
    return parts.length ? '<div class="diff">待复核更正：' + esc(parts.join("；")) + "</div>" : "";
  }

  function renderList(state) {
    const marks = filteredMarkers(state);
    if (state.ui.view === "timeline") return renderTimeline(state, marks);
    listTitle.textContent = "标记列表";
    listEl.className = "list";
    listEl.innerHTML = marks.length ? marks.map(m => {
      const c = R.committed(m);
      const d = R.dive(state, m.diveId);
      return '<div class="item' + (m.id === editingId ? " active" : "") + '" data-id="' + m.id + '">'
        + "<b>" + esc(c.code) + '</b> <span class="pill">' + (TYPE_NAMES[c.type] || c.type) + "</span> " + badges(m)
        + '<div class="muted">' + esc(d ? d.code : "?") + " · " + fmtDepth(c.depth) + " · " + esc(c.orientation || "—") + "</div>"
        + "<div>" + esc(c.condition || "—") + "</div>"
        + diffLine(m)
        + "</div>";
    }).join("") : '<div class="muted">暂无标记</div>';
    listEl.querySelectorAll("[data-id]").forEach(el => el.addEventListener("click", () => edit(el.dataset.id)));
  }

  function renderTimeline(state, marks) {
    listTitle.textContent = "潜次时间线";
    listEl.className = "timeline";
    const dives = state.dives
      .filter(d => !state.ui.filterDive || d.id === state.ui.filterDive)
      .slice().sort((a, b) => a.createdAt - b.createdAt);
    listEl.innerHTML = dives.length ? dives.map(d => {
      const limit = R.certifiedDepth(state, d);
      const rows = marks.filter(m => m.diveId === d.id);
      return '<div class="item">'
        + "<b>" + esc(d.code) + '</b> <span class="pill st-' + d.status + '">' + R.STATUS_NAMES[d.status] + "</span>"
        + '<div class="muted">' + esc(R.personName(state, d.diverAId)) + " / " + esc(R.personName(state, d.diverBId))
        + " · 计划 " + d.plannedDepth + "m / 持证 " + (limit === null ? "—" : limit + "m") + "</div>"
        + '<div class="events">' + d.history.map(h =>
          '<div class="muted">' + fmtTime(h.at) + " · " + esc(R.personName(state, h.by)) + " · " + esc(h.detail) + "</div>").join("") + "</div>"
        + (rows.length ? '<div class="tl-marks">' + rows.map(m => {
            const c = R.committed(m);
            return "<div>" + esc(c.code) + " · " + (TYPE_NAMES[c.type] || c.type) + " · " + fmtDepth(c.depth) + " " + badges(m) + "</div>";
          }).join("") + "</div>" : "")
        + "</div>";
    }).join("") : '<div class="muted">暂无潜次</div>';
  }

  function syncFormChrome(state) {
    state = state || S.getState();
    const d = els.diveId.value ? R.dive(state, els.diveId.value) : null;
    const mode = d ? R.editMode(d) : "none";
    els.diveId.disabled = !!editingId;
    saveMarkerBtn.disabled = !d || mode === "none";
    saveMarkerBtn.textContent = mode === "review" ? (editingId ? "提交待复核更正" : "提交待复核新增") : "保存标记";
    deleteBtn.disabled = !editingId;
    let hint = "";
    if (!state.dives.length) hint = "请先新建潜次";
    else if (!d) hint = "暂无可登记标记的潜次（需先开始潜次）";
    else if (mode === "none") hint = "潜次尚未开始，不能登记标记";
    else if (mode === "review") hint = editingId ? "该潜次已封存：保存将提交待复核更正，确认前仍显示原值" : "该潜次已封存：新标记待复核确认后生效";
    else if (d.status === R.STATUS.PENDING_SEAL) hint = "潜次待封存中：若改缺深度/朝向/保存状态，将退回进行中";
    if (editingId) {
      const m = state.markers.find(x => x.id === editingId);
      if (m && m.pending && !m.pending.add) hint += (hint ? " " : "") + "该标记已有待复核更正。";
    }
    markerHint.textContent = hint;
  }

  function syncDiveHint(state) {
    const a = R.person(state, diveEls.diverAId.value);
    const b = R.person(state, diveEls.diverBId.value);
    const depth = Number(diveEls.plannedDepth.value);
    let msg = "", bad = false;
    if (a && b && a.id === b.id) { msg = "两名潜水员不能是同一人"; bad = true; }
    else if (a && b) {
      const limit = Math.min(a.certifiedDepth, b.certifiedDepth);
      msg = "持证深度 " + limit + "m";
      if (depth > limit) { msg += " · 计划深度超限，潜次将无法开始"; bad = true; }
    }
    diveHint.textContent = msg;
    diveHint.classList.toggle("bad", bad);
  }

  function suggestCode(state, diveId) {
    let i = state.markers.filter(m => m.diveId === diveId).length + 1;
    let code;
    do { code = "M-" + String(i).padStart(3, "0"); i++; }
    while (state.markers.some(m => m.diveId === diveId && m.code === code));
    return code;
  }

  function edit(id) {
    const state = S.getState();
    const m = state.markers.find(x => x.id === id);
    if (!m) return;
    const c = R.committed(m); // 编辑从已确认值出发
    editingId = m.id;
    pendingPos = { x: c.x, y: c.y };
    els.markerId.value = m.id;
    els.code.value = c.code;
    els.type.value = c.type;
    els.depth.value = c.depth === "" ? "" : c.depth;
    els.orientation.value = c.orientation;
    els.condition.value = c.condition;
    els.note.value = c.note;
    els.diveId.value = m.diveId;
    call(S.setUi({ formDiveId: m.diveId }));
    syncFormChrome(state);
  }

  function clearForm(state) {
    editingId = null;
    pendingPos = null;
    formEl.reset();
    els.markerId.value = "";
    els.diveId.value = state.ui.formDiveId;
    syncFormChrome(state);
  }

  /* —— 事件 —— */
  userSelect.addEventListener("change", () => call(S.setUi({ currentUserId: userSelect.value })));
  filterType.addEventListener("change", () => call(S.setUi({ filterType: filterType.value })));
  filterDive.addEventListener("change", () => call(S.setUi({ filterDive: filterDive.value })));
  viewSel.addEventListener("change", () => call(S.setUi({ view: viewSel.value })));
  els.diveId.addEventListener("change", () => call(S.setUi({ formDiveId: els.diveId.value })));

  diveListEl.addEventListener("click", async (ev) => {
    const card = ev.target.closest("[data-id]");
    if (!card) return;
    const diveId = card.dataset.id;
    const btn = ev.target.closest("button[data-act]");
    if (!btn) { await call(S.setUi({ formDiveId: diveId })); return; }
    btn.disabled = true; // 防止重复点击，并发由数据层互斥兜底
    const act = btn.dataset.act;
    let res = null;
    if (act === "start") res = await call(S.startDive(diveId));
    else if (act === "submit") res = await call(S.submitSeal(diveId));
    else if (act === "seal") res = await call(S.sealDive(diveId));
    else if (act === "confirm") res = await call(S.confirmDive(diveId));
    if (!res) return;
    if (!res.ok) { toast(res.reason, true); return; }
    if (act === "seal") {
      const st = S.getState();
      const d = R.dive(st, diveId);
      toast(res.reused
        ? "重复封存：沿用首次结果（" + R.personName(st, d.seal.by) + " " + fmtTime(d.seal.at) + "）"
        : d.code + " 已封存，待另一人复核");
    } else {
      toast({ start: "潜次已开始", submit: "已转待封存", confirm: "复核完成，待复核更正已生效" }[act] || "完成");
    }
  });

  $("#newDiveBtn").addEventListener("click", () => { diveForm.classList.toggle("hidden"); syncDiveHint(S.getState()); });
  $("#cancelDiveBtn").addEventListener("click", () => diveForm.classList.add("hidden"));
  diveForm.addEventListener("input", () => syncDiveHint(S.getState()));
  diveForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const res = await call(S.addDive({
      code: diveEls.code.value,
      diverAId: diveEls.diverAId.value,
      diverBId: diveEls.diverBId.value,
      plannedDepth: diveEls.plannedDepth.value
    }));
    if (!res) return;
    if (!res.ok) { toast(res.reason, true); return; }
    toast("潜次 " + res.dive.code + " 已创建");
    diveForm.reset();
    diveForm.classList.add("hidden");
  });

  mapEl.addEventListener("click", (ev) => {
    const state = S.getState();
    const editable = state.dives.filter(d => R.editMode(d) !== "none");
    if (!editable.length) { toast("请先创建并开始一个潜次", true); return; }
    const rect = mapEl.getBoundingClientRect();
    pendingPos = {
      x: Number(((ev.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((ev.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    editingId = null;
    formEl.reset();
    els.markerId.value = "";
    const diveId = editable.some(d => d.id === state.ui.formDiveId) ? state.ui.formDiveId : editable[0].id;
    els.diveId.value = diveId;
    els.code.value = suggestCode(state, diveId);
    call(S.setUi({ formDiveId: diveId }));
    syncFormChrome(state);
  });

  formEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const isEdit = !!els.markerId.value;
    const res = await call(S.saveMarker({
      id: els.markerId.value || null,
      diveId: els.diveId.value,
      code: els.code.value,
      type: els.type.value,
      depth: els.depth.value,
      orientation: els.orientation.value,
      condition: els.condition.value,
      note: els.note.value,
      x: pendingPos ? pendingPos.x : 50,
      y: pendingPos ? pendingPos.y : 50
    }));
    if (!res) return;
    if (!res.ok) { toast(res.reason, true); return; }
    if (res.pendingReview) toast(isEdit ? "更正已提交待复核，确认前仍显示原值" : "新增标记已提交，待复核确认后生效");
    else toast("标记已保存");
    clearForm(S.getState());
  });

  deleteBtn.addEventListener("click", async () => {
    if (!editingId) { toast("请先在列表或地图上选择标记", true); return; }
    const res = await call(S.deleteMarker(editingId));
    if (!res) return;
    if (!res.ok) { toast(res.reason, true); return; }
    toast("标记已删除");
    clearForm(S.getState());
  });

  $("#exportBtn").addEventListener("click", () => {
    const state = S.getState();
    const payload = {
      exportedAt: new Date().toISOString(),
      people: state.people.map(p => ({ name: p.name, certifiedDepth: p.certifiedDepth })),
      dives: state.dives.map(d => ({
        code: d.code,
        status: d.status,
        statusName: R.STATUS_NAMES[d.status],
        divers: [R.personName(state, d.diverAId), R.personName(state, d.diverBId)],
        plannedDepth: d.plannedDepth,
        certifiedDepth: R.certifiedDepth(state, d),
        sealedBy: d.seal ? R.personName(state, d.seal.by) : null,
        sealedAt: d.seal ? new Date(d.seal.at).toISOString() : null,
        confirmedBy: d.review ? R.personName(state, d.review.by) : null,
        confirmedAt: d.review ? new Date(d.review.at).toISOString() : null
      })),
      // 确认前仍显示原值：导出取已确认值，待复核更正单列
      markers: state.markers.map(m => {
        const c = R.committed(m);
        const d = R.dive(state, m.diveId);
        const out = {
          dive: d ? d.code : null,
          code: c.code,
          type: c.type,
          typeName: TYPE_NAMES[c.type] || c.type,
          depth: c.depth === "" ? null : c.depth,
          orientation: c.orientation || null,
          condition: c.condition || null,
          note: c.note || "",
          x: c.x,
          y: c.y,
          review: m.pending ? (m.pending.add ? "pending_add" : "pending_change") : "committed"
        };
        if (m.pending && !m.pending.add && m.pending.fields) out.pendingChange = m.pending.fields;
        return out;
      })
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "uw-archive.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出当前数据（待复核更正以原值导出）");
  });

  $("#resetBtn").addEventListener("click", async () => {
    if (!confirm("将清空全部数据并恢复示例，确定？")) return;
    await call(S.resetAll());
    clearForm(S.getState());
    toast("已恢复示例数据");
  });

  /* —— 初始化 —— */
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    mapEl.appendChild(rib);
  }
  S.subscribe(render);
  render();
})();

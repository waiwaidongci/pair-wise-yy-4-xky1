/*
 * 页面交互层：只负责表单、平面图、筛选/时间线/导出；
 * 所有业务判定调用规则层，所有读写经过保存层，本文件不直接改状态。
 */
(function () {
  "use strict";

  const { Store } = window.DiveStore;
  const R = window.DiveRules;
  const S = R.STATUS;

  const store = new Store(localStorage);
  let prefs = store.prefs();
  prefs = Object.assign({
    operator: "", currentDive: "", view: "list",
    typeFilter: "", scope: "current", markId: ""
  }, prefs);

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const depthText = v => (v === "" || v === null || v === undefined) ? "—" : R.fmtDepth(v);
  const diverName = id => { const d = R.diverById(store.getState(), id); return d ? d.name : "—"; };

  const mapEl = $("#map");
  const diverListEl = $("#diverList");
  const diveListEl = $("#diveList");
  const diveDetailEl = $("#diveDetail");
  const viewEl = $("#view");
  const typeFilterEl = $("#typeFilter");
  const scopeEl = $("#scope");
  const listTitleEl = $("#listTitle");
  const listEl = $("#list");
  const formEl = $("#markForm");
  const operatorEl = $("#operator");
  const toastEl = $("#toast");
  const exportEl = $("#exportBtn");

  // 平面图画船肋
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    mapEl.appendChild(rib);
  }

  let toastTimer = null;
  function toast(msg, ok) {
    toastEl.textContent = msg;
    toastEl.className = "toast show " + (ok === false ? "err" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }

  function currentDive() {
    const st = store.getState();
    return st.dives.find(d => d.id === prefs.currentDive) || st.dives[0] || null;
  }

  function savePrefs() { store.savePrefs(prefs); }

  /** 统一的命令入口：规则层/保存层错误在此转成提示 */
  function run(action, payload, okMsg) {
    return store.mutate(action, payload).then(result => {
      if (okMsg) toast(okMsg);
      return result;
    }).catch(err => {
      const msg = err.name === "DomainError" ? err.message : ("操作失败：" + err.message);
      toast(msg, false);
      throw err;
    });
  }

  // ---------- 渲染 ----------

  store.subscribe(() => render());

  function render() {
    renderOperator();
    renderDivers();
    renderDiveList();
    renderDetail();
    renderMap();
    renderList();
  }

  function renderOperator() {
    const st = store.getState();
    if (operatorEl.options.length !== st.divers.length + 1) {
      operatorEl.innerHTML = '<option value="">选择当前操作人…</option>' +
        st.divers.map(d => `<option value="${d.id}">${esc(d.name)}（持证 ${d.certDepth}m）</option>`).join("");
    }
    operatorEl.value = prefs.operator;
  }

  function renderDivers() {
    const st = store.getState();
    diverListEl.innerHTML = st.divers.map(d =>
      `<span class="pill">${esc(d.name)} · 持证 ${d.certDepth}m</span>`).join(" ") ||
      '<span class="muted">暂无潜水员</span>';
  }

  function statusPill(status) {
    return `<span class="pill status-${status}">${R.STATUS_NAMES[status]}</span>`;
  }

  function renderDiveList() {
    const st = store.getState();
    const cur = currentDive();
    diveListEl.innerHTML = st.dives.map(d => {
      const blocked = d.status === S.PLANNING && !R.startReadiness(st, d).ok;
      return `<div class="item dive-item ${cur && d.id === cur.id ? "active" : ""}" data-dive="${d.id}">
        <b>${esc(d.code)}</b> ${statusPill(d.status)}
        ${blocked ? '<span class="pill warn">超限</span>' : ""}
        <div class="muted">${esc(diverName(d.diverA))} × ${esc(diverName(d.diverB))}
          · 计划 ${depthText(d.plannedDepth)}</div>
      </div>`;
    }).join("") || '<div class="muted">还没有潜次，先新建一个。</div>';
  }

  function renderDetail() {
    const st = store.getState();
    const d = currentDive();
    if (!d) {
      diveDetailEl.innerHTML = '<p class="muted">请先在上方新建潜次。</p>';
      return;
    }
    const isPlanning = d.status === S.PLANNING;
    const ready = R.startReadiness(st, d);
    const sealReady = isPlanning ? { ok: false, errors: ["潜次尚未开始"] } : R.sealReadiness(d);
    const other = d.seal ? (d.seal.by === d.diverA ? d.diverB : d.diverA) : null;
    const me = prefs.operator;

    const diverOptions = (selected) => st.divers.map(x =>
      `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(x.name)}（${x.certDepth}m）</option>`).join("");

    let actions = "";
    if (d.status === S.PLANNING) {
      const limit = (d.diverA && d.diverB && d.diverA !== d.diverB)
        ? Math.min(R.diverById(st, d.diverA).certDepth, R.diverById(st, d.diverB).certDepth) : null;
      actions = `
        <div class="plan-grid">
          <label>潜水员甲<select data-plan="diverA">${diverOptions(d.diverA)}</select></label>
          <label>潜水员乙<select data-plan="diverB">${diverOptions(d.diverB)}</select></label>
          <label>计划深度(m)<input data-plan="plannedDepth" type="number" step="0.1" min="0" value="${d.plannedDepth}"></label>
        </div>
        <div class="muted">持证上限：${limit === null ? "需先选择两名不同潜水员" : R.fmtDepth(limit)}</div>
        ${ready.ok ? "" : `<div class="blocked">⛔ ${ready.errors.map(esc).join("；")}</div>`}
        <button data-act="start" ${ready.ok ? "" : "disabled"}>准入检查通过 · 开始潜次</button>`;
    } else {
      const sealInfo = d.seal
        ? `<div class="frozen">封存：${esc(diverName(d.seal.by))} · ${fmtTime(d.seal.at)}
             （重复封存沿用首次结果，不会改变原值）</div>` : "";
      const reviewInfo = d.review
        ? `<div class="frozen ok">复核确认：${esc(diverName(d.review.by))} · ${fmtTime(d.review.at)}</div>` : "";
      actions = `
        ${sealInfo}${reviewInfo}
        <ul class="checklist">
          ${sealReady.ok ? '<li class="ok">✓ 编号唯一、深度/朝向/保存状态齐全，可封存</li>'
            : sealReady.errors.map(e => `<li>✗ ${esc(e)}</li>`).join("")}
        </ul>
        <div class="btn-row">
          <button data-act="seal" ${sealReady.ok ? "" : "disabled"}>
            ${d.seal ? "再次封存（沿用首次结果）" : "封存潜次"}</button>
          <button data-act="review" class="secondary"
            ${d.status === S.SEALED && other && me === other ? "" : "disabled"}
            title="${d.status !== S.SEALED ? "仅待复核潜次可确认"
              : "复核人须为封存人之外的另一绑定潜水员"}">
            复核确认${d.status === S.SEALED && other ? "（由" + esc(diverName(other)) + "）" : ""}
          </button>
        </div>`;
    }

    const marksShown = R.effectiveMarks(d);
    diveDetailEl.innerHTML = `
      <div class="detail-head">
        <h2>${esc(d.code)} ${statusPill(d.status)}</h2>
        <div class="muted">${esc(diverName(d.diverA))} 与 ${esc(diverName(d.diverB))}
          · 计划 ${depthText(d.plannedDepth)}${d.limitDepth ? " · 持证上限 " + R.fmtDepth(d.limitDepth) : ""}</div>
      </div>
      ${actions}
      <h3>台面标记（${d.status === S.OPEN ? "实时值" : d.review ? "最近确认值" : "封存原值"}，共 ${marksShown.length} 项）</h3>
      <div class="mini-marks">${marksShown.map(m => renderMiniMark(d, m)).join("") || '<span class="muted">无</span>'}</div>
    `;
  }

  function renderMiniMark(d, m) {
    const pending = R.pendingMarkIds(d).has(m.id);
    return `<div class="mini-mark ${prefs.markId === m.id ? "active" : ""}" data-mark="${m.id}">
      <b>${esc(m.code)}</b> <span class="pill">${R.TYPE_NAMES[m.type] || "未知物"}</span>
      ${pending ? '<span class="pill changed">待复核改动</span>' : ""}
      <span class="muted">${depthText(m.depth)} · ${esc(m.orientation) || "—"} · ${esc(m.condition) || "—"}</span>
    </div>`;
  }

  function renderMap() {
    mapEl.querySelectorAll(".marker").forEach(el => el.remove());
    const d = currentDive();
    if (!d) return;
    const shown = R.effectiveMarks(d);
    const pending = R.pendingMarkIds(d);
    shown.forEach(m => {
      if (prefs.typeFilter && m.type !== prefs.typeFilter) return;
      const el = document.createElement("button");
      el.className = "marker " + m.type + (prefs.markId === m.id ? " selected" : "") +
        (pending.has(m.id) ? " changed" : "");
      el.style.left = m.x + "%";
      el.style.top = m.y + "%";
      el.textContent = (m.code || "??").slice(0, 2);
      el.title = m.code + (pending.has(m.id) ? "（有等待复核的改动）" : "");
      el.onclick = e => { e.stopPropagation(); selectMark(m.id); };
      mapEl.appendChild(el);
    });
  }

  function renderList() {
    viewEl.value = prefs.view;
    typeFilterEl.value = prefs.typeFilter;
    scopeEl.value = prefs.scope;

    const dives = scopedDives();
    if (prefs.view === "timeline") {
      listTitleEl.textContent = prefs.scope === "all" ? "全部潜次时间线" : "本潜次时间线";
      listEl.className = "timeline";
      listEl.innerHTML = dives.map(renderTimelineDive).join("") || '<div class="muted">暂无事件</div>';
    } else {
      listTitleEl.textContent = "标记列表（台面显示值）";
      listEl.className = "list";
      const rows = dives.flatMap(d =>
        R.effectiveMarks(d)
          .filter(m => !prefs.typeFilter || m.type === prefs.typeFilter)
          .map(m => ({ d, m })));
      listEl.innerHTML = rows.map(({ d, m }) => {
        const changed = R.pendingMarkIds(d).has(m.id);
        return `<div class="item ${prefs.markId === m.id ? "active" : ""}" data-listmark="${m.id}" data-dive="${d.id}">
          <b>${esc(m.code)}</b> <span class="pill">${R.TYPE_NAMES[m.type] || "未知物"}</span>
          <span class="pill">${esc(d.code)}</span>${changed ? '<span class="pill changed">待复核改动</span>' : ""}
          <div class="muted">${depthText(m.depth)} · ${esc(m.orientation) || "—"} · ${esc(m.condition) || "—"}</div>
          <div>${esc(m.note)}</div>
        </div>`;
      }).join("") || '<div class="muted">没有符合筛选条件的标记</div>';
    }
  }

  function scopedDives() {
    const st = store.getState();
    if (prefs.scope === "all") return st.dives;
    const d = currentDive();
    return d ? [d] : [];
  }

  function renderTimelineDive(d) {
    const marks = R.effectiveMarks(d).filter(m => !prefs.typeFilter || m.type === prefs.typeFilter);
    const events = d.events.slice().reverse();
    return `<div class="item">
      <b>${esc(d.code)}</b> ${statusPill(d.status)}
      <div class="events">${events.map(e =>
        `<div class="event"><span class="muted">${fmtTime(e.at)}</span>
          <span class="ev ev-${e.type}">${eventLabel(e)}</span></div>`).join("")}</div>
      ${marks.length ? `<div class="muted">台面标记：${marks.map(m => esc(m.code)).join("、")}</div>` : ""}
    </div>`;
  }

  const EVENT_LABELS = {
    created: "建次", planned: "改计划", started: "准入开始",
    added: "新增标记", edited: "更正标记", amended: "封存后改动",
    sealed: "封存", reviewed: "复核确认", migrated: "旧数据迁移"
  };
  function eventLabel(e) {
    const tag = EVENT_LABELS[e.type] || e.type;
    const who = e.by ? diverName(e.by) : "系统";
    return `${tag} · ${esc(who)}${e.detail ? "：" + esc(e.detail) : ""}`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 标记表单 ----------

  function fillForm(mark) {
    formEl.reset();
    formEl.querySelector('[name="id"]').value = mark.id;
    for (const k of ["code", "type", "depth", "orientation", "condition", "note", "x", "y"]) {
      if (formEl.elements[k]) formEl.elements[k].value = mark[k] ?? "";
    }
  }

  function clearForm() {
    formEl.reset();
    formEl.querySelector('[name="id"]').value = "";
    const d = currentDive();
    if (d) {
      const used = new Set(d.marks.map(m => m.code.toLowerCase()));
      for (let i = d.marks.length + 1; ; i++) {
        const code = "M-" + String(i).padStart(3, "0");
        if (!used.has(code.toLowerCase())) { formEl.elements.code.value = code; break; }
      }
      formEl.elements.depth.value = d.plannedDepth || "";
    }
  }

  function selectMark(markId) {
    const d = currentDive();
    if (!d) return;
    // 台面点的是冻结值；若该标记在工作集中仍存在则编辑工作值（封存态保存即触发更正）
    const work = d.marks.find(m => m.id === markId);
    if (!work) {
      toast("该标记在工作集中已删除，复核确认前台面仍显示封存原值", false);
      return;
    }
    prefs.markId = markId; savePrefs();
    fillForm(work);
    renderList(); renderMap(); renderDetail();
  }

  // ---------- 事件绑定 ----------

  operatorEl.onchange = () => { prefs.operator = operatorEl.value; savePrefs(); renderDetail(); };

  $("#addDiverBtn").onclick = () => {
    const name = prompt("潜水员姓名：");
    if (!name) return;
    const certDepth = Number(prompt("持证最大深度（米）："));
    run("addDiver", { name, certDepth }, "已加入潜水员花名册").then(({ diver }) => {
      prefs.operator = diver.id; savePrefs();
      render();
    }).catch(() => {});
  };

  $("#newDiveBtn").onclick = () => {
    const st = store.getState();
    if (st.divers.length < 2) { toast("请先登记至少两名潜水员", false); return; }
    const code = prompt("潜次编号（例如 DIVE-05）：",
      "DIVE-" + String(st.dives.length + 1).padStart(2, "0"));
    if (!code) return;
    const diverA = st.divers[0].id;
    const diverB = st.divers[1].id;
    const plannedDepth = Number(prompt("计划深度（米）：", "18"));
    run("createDive", { code, diverA, diverB, plannedDepth, by: prefs.operator || null }, "潜次已建立（计划中）")
      .then(({ dive }) => { prefs.currentDive = dive.id; savePrefs(); render(); })
      .catch(() => {});
  };

  diveListEl.onclick = e => {
    const item = e.target.closest("[data-dive]");
    if (!item) return;
    prefs.currentDive = item.dataset.dive;
    prefs.markId = "";
    savePrefs(); clearForm(); render();
  };

  diveDetailEl.onclick = e => {
    const mini = e.target.closest("[data-mark]");
    if (mini) { selectMark(mini.dataset.mark); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const d = currentDive();
    const me = prefs.operator;
    if (!me) { toast("请先在右上角选择当前操作人", false); return; }

    if (btn.dataset.act === "start") {
      run("startDive", { diveId: d.id, by: me }, "准入检查通过，潜次已开始").catch(() => {});
    } else if (btn.dataset.act === "seal") {
      const reused = !!d.seal;
      run("sealDive", { diveId: d.id, by: me }, reused ? "沿用首次封存结果（原值未变）" : "已封存，等待另一名潜水员复核")
        .catch(() => {});
    } else if (btn.dataset.act === "review") {
      const reused = d.status === S.REVIEWED;
      run("confirmReview", { diveId: d.id, by: me },
        reused ? "已是最新复核结果" : "复核确认完成，台面显示确认值").catch(() => {});
    }
  };

  // 计划中的改派/深度调整
  diveDetailEl.onchange = e => {
    const el = e.target.closest("[data-plan]");
    if (!el) return;
    const d = currentDive();
    const payload = { diveId: d.id, by: prefs.operator || null };
    if (el.dataset.plan === "plannedDepth") {
      payload.plannedDepth = el.value;
    } else {
      payload.diverA = diveDetailEl.querySelector('[data-plan="diverA"]').value;
      payload.diverB = diveDetailEl.querySelector('[data-plan="diverB"]').value;
      payload.plannedDepth = diveDetailEl.querySelector('[data-plan="plannedDepth"]').value;
    }
    store.mutate("updatePlan", payload).then(() => render())
      .catch(err => { toast(err.message, false); render(); });
  };

  listEl.onclick = e => {
    const row = e.target.closest("[data-listmark]");
    if (!row) return;
    if (row.dataset.dive !== prefs.currentDive) {
      prefs.currentDive = row.dataset.dive;
      savePrefs();
    }
    selectMark(row.dataset.listmark);
  };

  // 点击平面图：准备新标记（必须在已开始的潜次中）
  mapEl.onclick = event => {
    const d = currentDive();
    if (!d) { toast("请先建立潜次", false); return; }
    if (d.status === S.PLANNING) {
      const r = R.startReadiness(store.getState(), d);
      toast(r.ok ? "潜次尚未开始" : "不能开始：" + r.errors[0], false);
      return;
    }
    const rect = mapEl.getBoundingClientRect();
    const x = Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2));
    const y = Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2));
    clearForm();
    formEl.elements.x.value = x;
    formEl.elements.y.value = y;
    prefs.markId = ""; savePrefs();
    renderMap(); renderList();
    formEl.elements.code.focus();
  };

  formEl.onsubmit = e => {
    e.preventDefault();
    const d = currentDive();
    if (!d) { toast("请先选择潜次", false); return; }
    if (d.status === S.PLANNING) { toast("潜次尚未通过准入检查，不能登记标记", false); return; }
    const f = new FormData(formEl);
    const data = Object.fromEntries(f.entries());
    if (data.x === "") data.x = 50;
    if (data.y === "") data.y = 50;
    store.mutate("upsertMark", { diveId: d.id, data, by: prefs.operator || null })
      .then(res => {
        prefs.markId = res.mark.id; savePrefs();
        if (res.unchanged) toast("内容与原值一致，未产生更正");
        else if (res.amended) toast("已保存；潜次回到待复核，需另一名潜水员重新确认");
        else toast(res.action === "added" ? "标记已登记" : "标记已更新");
        clearForm(); render();
      })
      .catch(err => toast(err.message, false));
  };

  $("#deleteMarkBtn").onclick = () => {
    const id = formEl.elements.id.value;
    if (!id) return;
    const d = currentDive();
    if (!confirm("删除该标记？" + (d.seal ? "删除后潜次将回到待复核。" : ""))) return;
    store.mutate("deleteMark", { diveId: d.id, markId: id, by: prefs.operator || null })
      .then(res => {
        prefs.markId = ""; savePrefs();
        toast(res.amended ? "已删除；潜次回到待复核" : "标记已删除");
        clearForm(); render();
      })
      .catch(err => toast(err.message, false));
  };

  typeFilterEl.onchange = () => { prefs.typeFilter = typeFilterEl.value; savePrefs(); renderMap(); renderList(); };
  viewEl.onchange = () => { prefs.view = viewEl.value; savePrefs(); renderList(); };
  scopeEl.onchange = () => { prefs.scope = scopeEl.value; savePrefs(); renderList(); };

  exportEl.onclick = () => {
    // 导出与当前筛选严格一致的台面快照；displayMarks 即台面上实际显示的原值/确认值
    const type = prefs.typeFilter || null;
    const dives = scopedDives().map(d => {
      const displayMarks = R.effectiveMarks(d).filter(m => !type || m.type === type);
      return {
        id: d.id, code: d.code, status: d.status,
        diverA: d.diverA, diverB: d.diverB,
        plannedDepth: d.plannedDepth, limitDepth: d.limitDepth,
        seal: d.seal, review: d.review,
        displayMarks,
        pendingMarkIds: [...R.pendingMarkIds(d)].filter(id =>
          displayMarks.some(m => m.id === id) || d.marks.some(m => m.id === id)),
        events: d.events
      };
    });
    const payload = {
      exportedAt: new Date().toISOString(),
      filter: { type, scope: prefs.scope, view: prefs.view },
      divers: store.getState().divers,
      dives
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dive-station-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已按当前筛选导出台面快照 JSON");
  };

  // 初始化：保证当前潜次有效并渲染
  if (prefs.currentDive && !store.getState().dives.some(d => d.id === prefs.currentDive)) {
    prefs.currentDive = ""; savePrefs();
  }
  clearForm();
  render();
})();

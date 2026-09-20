/* 端到端冒烟：用最小 DOM 垫片在 Node 中加载三段脚本，
 * 验证页面层 → 保存层 → 规则层的真实调用路径（node test/smoke.js，非 node:test 套件）。 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

// ---------- 极简 DOM：innerHTML 渲染为字符串，点击通过 closest(selector) 委托 ----------
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = makeClassList(this);
    this._listeners = {};
    this._html = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.options = [];
    this.name = "";
    this.title = "";
    this.id = "";
    this.parentNode = null;
    this._elements = null;
  }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  set innerHTML(v) {
    this._html = String(v);
    // 解析 data-* / id / name / disabled 等供测试与委托使用的轻量结构
    this._nodes = parseNodes(String(v));
  }
  get innerHTML() { return this._html; }
  _walk(nodes, pred, out) {
    for (const n of nodes) { if (pred(n)) out.push(n); this._walk(n.children, pred, out); }
    return out;
  }
  querySelectorAll(sel) {
    if (sel === ".marker") return this.children.filter(c => c.classList.contains("marker"));
    return this._walk(this._nodes || [], n => matches(n, sel), []);
  }
  querySelector(sel) {
    if (this._elements && sel.startsWith("[name=")) {
      const name = sel.slice(7, -2);
      return this._elements[name] || null;
    }
    return this.querySelectorAll(sel)[0] || null;
  }
  /** 从点击源（带任意属性的虚拟节点）向上找选择器；顶层元素自身也算 */
  delegateClick(sel, extra) {
    const all = this._walk(this._nodes || [], n => matches(n, sel), []);
    return all[0] || null;
  }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  set onsubmit(fn) { this._onsubmit = fn; }
  set onclick(fn) { this._onclick = fn; }
  set onchange(fn) { this._onchange = fn; }
  dispatch(type, event) {
    const ev = Object.assign({ preventDefault() {}, stopPropagation() {} }, event);
    const handler = this["_on" + type];
    if (handler) {
      // innerHTML 区域：用虚拟 target 上的 closest
      const wrapped = wrapEventTarget(ev, this);
      return handler(wrapped);
    }
    (this._listeners[type] || []).forEach(fn => fn(ev));
  }
  click(event) { return this.dispatch("click", event); }
  change(event) { return this.dispatch("change", event); }
  submit(event) { return this.dispatch("submit", event || {}); }
  reset() { if (this._elements) for (const k of Object.keys(this._elements)) this._elements[k].value = ""; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
}

function wrapEventTarget(ev, root) {
  if (!ev.target) return ev;
  const t = ev.target;
  t.closest = sel => matches(t, sel) ? t : null;
  ev.currentTarget = root;
  return ev;
}

function parseNodes(html) {
  // 只提取带 data-* 或 id 的开标签，满足 closest("[data-act]") 类委托
  const nodes = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[2]))) attrs[a[1]] = a[2];
    if (/(^|\s)disabled(\s|$)/.test(m[2])) attrs.disabled = "";
    nodes.push({ tag: m[1], attrs, children: [], dataset: dataAttrs(attrs),
      get className() { return attrs.class || ""; } });
  }
  return nodes;
}
function dataAttrs(attrs) {
  const out = {};
  for (const k of Object.keys(attrs)) if (k.startsWith("data-")) out[camel(k.slice(5))] = attrs[k];
  return out;
}
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

function matches(n, sel) {
  const s = sel.trim();
  let mm;
  if ((mm = s.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/))) {
    const key = "data-" + mm[1];
    return key in n.attrs && (mm[2] === undefined || n.attrs[key] === mm[2]);
  }
  if ((mm = s.match(/^\[name="([^"]+)"\]$/))) return n.attrs.name === mm[1];
  if ((mm = s.match(/^\.([\w-]+)$/))) return (n.attrs.class || "").split(/\s+/).includes(mm[1]);
  if ((mm = s.match(/^#([\w-]+)$/))) return n.attrs.id === mm[1];
  return false;
}
function makeClassList(el) {
  return {
    add(...c) { el._cls = new Set([...(el._cls || []), ...c]); },
    remove(...c) { c.forEach(x => el._cls && el._cls.delete(x)); },
    contains(c) { return el._cls ? el._cls.has(c) : false; }
  };
}

function buildDom() {
  const ids = {};
  const byId = id => ids[id] || (ids[id] = new El("div"));
  const form = new El("form");
  ids.markForm = form;
  const elements = {};
  ["id", "code", "type", "depth", "orientation", "condition", "note", "x", "y"].forEach(n => {
    const i = new El(n === "type" || n === "orientation" ? "select" : "input");
    i.name = n; elements[n] = i;
  });
  form._elements = elements;
  Object.defineProperty(form, "elements", { get: () => elements });
  form.querySelector = sel => sel === '[name="id"]' ? elements.id : null;
  ["map", "diverList", "diveList", "diveDetail", "view", "typeFilter", "scope",
    "listTitle", "list", "operator", "toast", "exportBtn", "addDiverBtn", "newDiverBtn",
    "deleteMarkBtn"].forEach(id => { ids[id] = new El("div"); ids[id].id = id; });

  const document = {
    querySelector: sel => {
      if (sel.startsWith("#")) return byId(sel.slice(1));
      if (sel === '[name="orientation"]') return elements.orientation;
      return null;
    },
    createElement: tag => new El(tag)
  };
  const data = {};
  const localStorage = {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    _data: data
  };
  return { ids, document, localStorage, form };
}

function loadApp(dom) {
  const ctx = {
    document: dom.document, localStorage: dom.localStorage,
    console, setTimeout: (fn, ms) => (ms === undefined ? fn() : 0), clearTimeout() {},
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Date, Math, JSON, Object, Array, String, Number, Promise, Error,
    FormData: class {
      constructor(formEl) {
        this.entries = () => Object.keys(formEl._elements)
          .map(k => [k, formEl._elements[k].value]);
      }
    },
    confirm: () => true
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["js/rules.js", "js/store.js", "js/app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), ctx, { filename: f });
  }
  return ctx;
}
const tick = () => new Promise(r => setTimeout(r, 1));

/** 委托点击：从元素 innerHTML 中找第一个匹配 selector 的虚拟节点 */
function delegateClick(el, sel) {
  const node = el.delegateClick(sel);
  assert.ok(node, "期望在 innerHTML 中找到 " + sel + "\n" + el.innerHTML.slice(0, 400));
  el.click({ target: node });
  return node;
}

async function main() {
  const dom = buildDom();
  const ctx = loadApp(dom);
  const st0 = JSON.parse(dom.localStorage.getItem("diveStation.state.v1"));
  assert.equal(st0.dives.length, 4, "种子应含4个潜次");
  assert.ok(dom.ids.diveList.innerHTML.includes("DIVE-04"), "潜次列表渲染");
  assert.ok(dom.ids.diveList.innerHTML.includes("超限"), "计划超限潜次显示超限标记");
  const chen = st0.divers.find(d => d.name === "陈潜");
  const lin = st0.divers.find(d => d.name === "林溯");
  const zhou = st0.divers.find(d => d.name === "周海");

  dom.ids.operator.value = chen.id;
  dom.ids.operator.change();

  // 1) 计划超限：开始按钮禁用并显示原因
  clickDiveNode(dom, "DIVE-04");
  assert.match(dom.ids.diveDetail.innerHTML, /超过持证上限/);
  assert.equal(delegateDisabled(dom.ids.diveDetail, '[data-act="start"]'), true);

  // 2) DIVE-03 资料不齐：封存按钮禁用
  clickDiveNode(dom, "DIVE-03");
  assert.equal(delegateDisabled(dom.ids.diveDetail, '[data-act="seal"]'), true);

  // 3) DIVE-01 待复核：封存人陈潜不能复核，台面显示封存原值
  clickDiveNode(dom, "DIVE-01");
  assert.equal(delegateDisabled(dom.ids.diveDetail, '[data-act="review"]'), true);
  assert.ok(dom.ids.diveDetail.innerHTML.includes("17.8"));

  // 4) 切换林溯可复核，点击后状态变为 reviewed
  dom.ids.operator.value = lin.id;
  dom.ids.operator.change();
  assert.equal(delegateDisabled(dom.ids.diveDetail, '[data-act="review"]'), false);
  delegateClick(dom.ids.diveDetail, '[data-act="review"]');
  await tick();
  let st = JSON.parse(dom.localStorage.getItem("diveStation.state.v1"));
  assert.equal(st.dives.find(d => d.code === "DIVE-01").status, "reviewed");

  // 5) DIVE-03 补齐标记字段后封存；并发双提交只成功一次
  clickDiveNode(dom, "DIVE-03");
  const d3 = st.dives.find(d => d.code === "DIVE-03");
  const mid = d3.marks.find(m => m.code === "M-012").id;
  const f = dom.form;
  Object.assign(f._elements.id, { value: mid });
  Object.assign(f._elements.code, { value: "M-012" });
  Object.assign(f._elements.type, { value: "metal" });
  Object.assign(f._elements.depth, { value: "19" });
  Object.assign(f._elements.orientation, { value: "南" });
  Object.assign(f._elements.condition, { value: "轻微锈蚀" });
  Object.assign(f._elements.note, { value: "" });
  Object.assign(f._elements.x, { value: "55" });
  Object.assign(f._elements.y, { value: "47" });
  f.submit();
  await tick();
  const store = new ctx.DiveStore.Store(dom.localStorage);
  const results = await Promise.allSettled([
    store.mutate("sealDive", { diveId: d3.id, by: zhou.id }),
    store.mutate("sealDive", { diveId: d3.id, by: zhou.id })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "CONCURRENT");

  // 7) 完整流程：DIVE-04 计划超限 → 改浅计划 → 开始 → 登记 → 封存 → 更正在即显原值 → 另一人复核
  //    全部经保存层事务驱动（模拟页面上的真实动作序列）
  const fresh = () => new ctx.DiveStore.Store(dom.localStorage);
  let cur = JSON.parse(dom.localStorage.getItem("diveStation.state.v1"));
  const d4id = cur.dives.find(d => d.code === "DIVE-04").id;
  await fresh().mutate("updatePlan", { diveId: d4id, plannedDepth: 18, diverA: chen.id, diverB: lin.id, by: chen.id });
  await fresh().mutate("startDive", { diveId: d4id, by: chen.id });
  await fresh().mutate("upsertMark", {
    diveId: d4id, by: chen.id,
    data: { code: "C-009", type: "ceramic", depth: 17.5, orientation: "东", condition: "完好", x: 25, y: 25 }
  });
  await fresh().mutate("sealDive", { diveId: d4id, by: chen.id });
  cur = JSON.parse(dom.localStorage.getItem("diveStation.state.v1"));
  const cid = cur.dives.find(d => d.code === "DIVE-04").marks[0].id;
  await fresh().mutate("upsertMark", {
    diveId: d4id, by: lin.id,
    data: { id: cid, code: "C-009", type: "ceramic", depth: 18.8, orientation: "东", condition: "完好", x: 25, y: 25 }
  });
  const d4b = JSON.parse(dom.localStorage.getItem("diveStation.state.v1")).dives.find(d => d.code === "DIVE-04");
  assert.equal(d4b.status, "sealed");
  assert.equal(ctx.DiveRules.effectiveMarks(d4b)[0].depth, 17.5, "确认前台面显示封存原值");
  assert.equal(d4b.seal.snapshot[0].depth, 17.5, "首次封存快照不变");
  await fresh().mutate("confirmReview", { diveId: d4id, by: lin.id });
  const d4c = JSON.parse(dom.localStorage.getItem("diveStation.state.v1")).dives.find(d => d.code === "DIVE-04");
  assert.equal(d4c.status, "reviewed");
  assert.equal(ctx.DiveRules.effectiveMarks(d4c)[0].depth, 18.8, "确认后台面显示新值");

  // 8) 新页面实例上验证导出按当前筛选裁剪：仅当前潜次(DIVE-04) + 陶片
  const domExp = buildDom();
  domExp.localStorage._data["diveStation.state.v1"] = dom.localStorage._data["diveStation.state.v1"];
  domExp.localStorage._data["diveStation.prefs.v1"] = JSON.stringify({ currentDive: d4id });
  const ctxExp = loadApp(domExp);
  domExp.ids.scope.value = "current";
  domExp.ids.scope.change();
  domExp.ids.typeFilter.value = "ceramic";
  domExp.ids.typeFilter.change();
  let captured;
  ctxExp.Blob = class { constructor(parts) { captured = JSON.parse(parts[0]); } };
  domExp.ids.exportBtn.click();
  assert.ok(captured, "导出被触发");
  assert.equal(captured.filter.scope, "current");
  assert.equal(captured.filter.type, "ceramic");
  assert.equal(captured.dives.length, 1, "仅导出当前潜次");
  assert.ok(captured.dives[0].displayMarks.every(m => m.type === "ceramic"));
  assert.equal(captured.dives[0].displayMarks[0].depth, 18.8);

  // 9) 刷新后数据与筛选偏好一致
  const dom2 = buildDom();
  dom2.localStorage._data["diveStation.state.v1"] = dom.localStorage._data["diveStation.state.v1"];
  dom2.localStorage._data["diveStation.prefs.v1"] = dom.localStorage._data["diveStation.prefs.v1"];
  loadApp(dom2);
  const st2 = JSON.parse(dom2.localStorage.getItem("diveStation.state.v1"));
  assert.equal(st2.dives.find(d => d.code === "DIVE-01").status, "reviewed");
  assert.equal(JSON.parse(dom2.localStorage.getItem("diveStation.prefs.v1")).operator, lin.id);
  // DIVE-04 已走完准入→复核，列表应反映“已复核”；种子其余潜次状态也在
  assert.ok(dom2.ids.diveList.innerHTML.includes("DIVE-04"));
  assert.ok(dom2.ids.diveList.innerHTML.includes("已复核"));

  console.log("e2e smoke OK");
}

function clickDiveNode(dom, code) {
  const node = parseNodes(dom.ids.diveList.innerHTML).find(n =>
    n.attrs["data-dive"] && snippet(dom.ids.diveList.innerHTML, n).includes(code));
  assert.ok(node, "找不到潜次 " + code);
  dom.ids.diveList.click({ target: node });
}
function snippet(html, node) {
  const idx = html.indexOf('<div class="item dive-item');
  // 简单按 data-dive 切块
  const blocks = html.split(/(?=<div class="item dive-item)/);
  return blocks.find(b => b.includes('data-dive="' + node.attrs["data-dive"] + '"')) || "";
}
function delegateDisabled(el, sel) {
  const n = el.delegateClick(sel);
  assert.ok(n, "缺少按钮 " + sel);
  return "disabled" in n.attrs;
}

main().catch(err => { console.error(err); process.exit(1); });

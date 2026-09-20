/* 规则层 + 数据层冒烟测试：node tests/smoke.js */
const assert = require("assert");

/* —— 浏览器环境桩 —— */
const mem = new Map();
global.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
global.window = { addEventListener: () => {} };

require("../js/rules.js");
require("../js/store.js");

const R = global.window.UWRules;
const S = global.window.UWStore;

async function main() {
  /* 种子数据与持证深度 */
  let st = S.getState();
  assert.equal(st.dives.length, 3, "种子含 3 个潜次");
  assert.equal(R.certifiedDepth(st, R.dive(st, "d-2")), 18, "潜次持证深度取两名潜水员较低值");

  /* 计划深度超限不得开始 */
  let res = await S.startDive("d-2"); // 计划 24m > 持证 18m
  assert(!res.ok && /超过持证深度/.test(res.reason), "计划深度超限不得开始");

  /* 未开始的潜次不能登记标记 */
  res = await S.saveMarker({ diveId: "d-2", code: "X-001", type: "metal", depth: 10, orientation: "东", condition: "好", note: "", x: 1, y: 1 });
  assert(!res.ok && /尚未开始/.test(res.reason), "潜次未开始不能登记标记");

  /* 潜次内编号唯一 */
  res = await S.saveMarker({ diveId: "d-1", code: "A-017", type: "metal", depth: 10, orientation: "东", condition: "好", note: "", x: 1, y: 1 });
  assert(!res.ok && /已存在/.test(res.reason), "潜次内编号唯一");

  /* 深度/朝向/保存状态缺一项不能待封存（M-003 缺保存状态） */
  res = await S.submitSeal("d-1");
  assert(!res.ok && /不能待封存/.test(res.reason), "缺一项不能待封存");

  /* 补全后可转待封存 */
  res = await S.saveMarker({ id: "m-m003", diveId: "d-1", code: "M-003", type: "metal", depth: 18, orientation: "东南", condition: "附着贝类", note: "" });
  assert(res.ok, "补全标记");
  res = await S.submitSeal("d-1");
  assert(res.ok, "资料齐全可转待封存");
  assert.equal(R.dive(S.getState(), "d-1").status, "pending_seal");

  /* 待封存中改缺 → 退回进行中 */
  res = await S.saveMarker({ id: "m-m003", diveId: "d-1", code: "M-003", type: "metal", depth: 18, orientation: "东南", condition: "", note: "" });
  assert(res.ok);
  assert.equal(R.dive(S.getState(), "d-1").status, "active", "待封存中改缺退回进行中");
  await S.saveMarker({ id: "m-m003", diveId: "d-1", code: "M-003", type: "metal", depth: 18, orientation: "东南", condition: "附着贝类", note: "" });
  await S.submitSeal("d-1");

  /* 并发封存只成功一次 */
  const [r1, r2] = await Promise.all([S.sealDive("d-1"), S.sealDive("d-1")]);
  assert.equal([r1, r2].filter(r => r.ok && !r.reused).length, 1, "并发封存只成功一次");
  assert.equal([r1, r2].filter(r => r.ok && r.reused).length, 1, "并发其余沿用首次结果");

  /* 重复封存沿用首次结果 */
  const firstSeal = R.dive(S.getState(), "d-1").seal;
  res = await S.sealDive("d-1");
  assert(res.ok && res.reused, "重复封存返回首次结果");
  const again = R.dive(S.getState(), "d-1").seal;
  assert.equal(again.at, firstSeal.at, "沿用首次封存时间");
  assert.equal(again.by, firstSeal.by, "沿用首次封存人");

  /* 封存人本人不得复核 */
  res = await S.confirmDive("d-1"); // 当前用户 p-zhang = 封存人
  assert(!res.ok && /另一人复核/.test(res.reason), "须由另一人复核");

  /* 另一人复核 → 已确认 */
  await S.setUi({ currentUserId: "p-li" });
  res = await S.confirmDive("d-1");
  assert(res.ok, "另一人复核通过");
  assert.equal(R.dive(S.getState(), "d-1").status, "confirmed");

  /* 已确认潜次更正 → 回到待复核，确认前仍显示原值 */
  res = await S.saveMarker({ id: "m-a017", diveId: "d-1", code: "A-017", type: "ceramic", depth: 19.1, orientation: "东", condition: "边缘残缺", note: "靠近船肋" });
  assert(res.ok && res.pendingReview, "更正进入待复核");
  st = S.getState();
  assert.equal(R.dive(st, "d-1").status, "pending_review", "更正让潜次回到待复核");
  const a017 = st.markers.find(m => m.id === "m-a017");
  assert.equal(R.committed(a017).depth, 17.8, "确认前仍显示原值");
  assert.equal(a017.pending.fields.depth, 19.1, "更正暂存于待复核");

  /* 已确认/待复核潜次新增 → 待复核新增 */
  res = await S.saveMarker({ diveId: "d-1", code: "M-004", type: "wood", depth: 18.4, orientation: "北", condition: "稳定", note: "", x: 60, y: 55 });
  assert(res.ok && res.pendingReview);
  assert(S.getState().markers.find(m => m.code === "M-004").pending.add, "新增标记待复核");

  /* 复核确认后更正与新增生效（封存人 p-zhang，当前 p-li） */
  res = await S.confirmDive("d-1");
  assert(res.ok);
  st = S.getState();
  assert.equal(st.markers.find(m => m.id === "m-a017").depth, 19.1, "复核后更正生效");
  assert.equal(st.markers.find(m => m.code === "M-004").pending, null, "复核后新增转正");
  assert.equal(R.dive(st, "d-1").status, "confirmed");

  /* 种子 DIVE-03：待复核更正显示原值，复核后生效 */
  const c011 = S.getState().markers.find(m => m.id === "m-c011");
  assert.equal(R.committed(c011).depth, 20.1, "种子更正确认前显示原值");
  res = await S.confirmDive("d-3"); // 封存人 p-li，当前 p-li
  assert(!res.ok && /另一人复核/.test(res.reason), "种子潜次同样须另一人复核");
  await S.setUi({ currentUserId: "p-zhang" });
  res = await S.confirmDive("d-3");
  assert(res.ok);
  assert.equal(S.getState().markers.find(m => m.id === "m-c011").depth, 20.6, "复核后更正生效");

  /* 已封存潜次不可直接删除标记 */
  res = await S.deleteMarker("m-c011");
  assert(!res.ok && /不可删除/.test(res.reason), "已封存标记不可删除");

  /* 两名潜水员不能是同一人 */
  res = await S.addDive({ code: "DIVE-09", diverAId: "p-zhang", diverBId: "p-zhang", plannedDepth: 10 });
  assert(!res.ok && /同一人/.test(res.reason), "两名潜水员不能是同一人");

  /* 持久化：模拟刷新（重新加载数据层）后状态一致 */
  const before = JSON.stringify(S.getState());
  delete require.cache[require.resolve("../js/store.js")];
  require("../js/store.js");
  const S2 = global.window.UWStore;
  assert.equal(JSON.stringify(S2.getState()), before, "刷新后筛选/时间线/导出数据一致");

  console.log("✔ 全部冒烟测试通过（" + 18 + " 组断言）");
}

main().catch(e => { console.error("✘ 测试失败:", e.message); process.exit(1); });

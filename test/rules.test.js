/* 规则层 + 保存层的 Node 测试：node --test test/ （或直接 node test/rules.test.js） */
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/rules.js");
const { Store } = require("../js/store.js");

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    _data: data
  };
}

function freshStore(clock) {
  let n = 0;
  return new Store(memStorage(), { now: clock || (() => "2026-09-20T0" + Math.min(n++, 8) + ":00:00.000Z") });
}

function setupDive(store, plannedDepth, diverIdx = [0, 1]) {
  const s = store.getState();
  return store.mutate("createDive", {
    code: "D-" + Math.random().toString(36).slice(2, 6),
    diverA: s.divers[diverIdx[0]].id,
    diverB: s.divers[diverIdx[1]].id,
    plannedDepth
  }).then(r => r.dive);
}

test("两名潜水员必须不同，持证深度取较浅值", () => {
  const s = R.createState();
  R.dispatch(s, "addDiver", { name: "甲", certDepth: 30 }, { now: () => "t", uid: () => "a" });
  R.dispatch(s, "addDiver", { name: "乙", certDepth: 20 }, { now: () => "t", uid: () => "b" });
  assert.equal(R.certLimit(s, "a", "b"), 20);
  assert.throws(() => R.certLimit(s, "a", "a"), /不同的潜水员/);
});

test("计划深度超持证上限不得开始；改浅后可以开始", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 24); // 陈潜30 / 林溯20 → 上限20
  let err;
  try { await store.mutate("startDive", { diveId: dive.id, by: dive.diverA }); }
  catch (e) { err = e; }
  assert.equal(err.code, "START_BLOCKED");
  assert.match(err.message, /超过持证上限/);
  assert.equal(store.getState().dives.find(d => d.id === dive.id).status, "planning");

  await store.mutate("updatePlan", { diveId: dive.id, plannedDepth: 18 });
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });
  const after = store.getState().dives.find(d => d.id === dive.id);
  assert.equal(after.status, "open");
  assert.equal(after.limitDepth, 20);
});

test("深度/朝向/保存状态缺一项不能封存；潜次内编号唯一", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 18);
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });

  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "", x: 40, y: 40 }
  });
  await assert.rejects(
    store.mutate("sealDive", { diveId: dive.id, by: dive.diverA }),
    e => e.code === "SEAL_NOT_READY" && /保存状态/.test(e.errors.join())
  );

  // 补全保存状态后再重复编号
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { id: store.getState().dives.find(d => d.id === dive.id).marks[0].id,
      code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "完好", x: 40, y: 40 }
  });
  // 编号重复在登记时即被拒绝
  await assert.rejects(
    store.mutate("upsertMark", {
      diveId: dive.id, by: dive.diverA,
      data: { code: "A-1", type: "wood", depth: 17, orientation: "西", condition: "残", x: 41, y: 41 }
    }),
    /编号已存在/
  );
  // 改成不重复编号后，重复编号的封存障碍消除
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-2", type: "wood", depth: 17, orientation: "西", condition: "残", x: 41, y: 41 }
  });
  const ready = R.sealReadiness(store.getState().dives.find(d => d.id === dive.id));
  assert.equal(ready.ok, true);
});

test("封存后确认前显示原值；另一人复核确认；封存人本人不能复核", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 18);
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "完好", x: 40, y: 40 }
  });
  await store.mutate("sealDive", { diveId: dive.id, by: dive.diverA });

  // 封存后更正：工作值变了，但台面原值不变
  const mid = store.getState().dives.find(d => d.id === dive.id).marks[0].id;
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverB,
    data: { id: mid, code: "A-1", type: "ceramic", depth: 19, orientation: "西", condition: "碎", x: 40, y: 40 }
  });
  const cur = store.getState().dives.find(d => d.id === dive.id);
  assert.equal(cur.status, "sealed");
  assert.equal(R.effectiveMarks(cur)[0].depth, 17);
  assert.deepEqual([...R.pendingMarkIds(cur)], [mid]);

  await assert.rejects(
    store.mutate("confirmReview", { diveId: dive.id, by: dive.diverA }),
    /另一名潜水员/
  );
  await store.mutate("confirmReview", { diveId: dive.id, by: dive.diverB });
  const done = store.getState().dives.find(d => d.id === dive.id);
  assert.equal(done.status, "reviewed");
  assert.equal(R.effectiveMarks(done)[0].depth, 19);
});

test("已复核后更正回到待复核，且仍显示上一次确认值", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 18);
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "完好", x: 40, y: 40 }
  });
  await store.mutate("sealDive", { diveId: dive.id, by: dive.diverA });
  await store.mutate("confirmReview", { diveId: dive.id, by: dive.diverB });

  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-2", type: "metal", depth: 16, orientation: "南", condition: "锈蚀", x: 42, y: 42 }
  });
  const cur = store.getState().dives.find(d => d.id === dive.id);
  assert.equal(cur.status, "sealed");
  assert.equal(R.effectiveMarks(cur).length, 1); // 仍显示上一次确认值
  assert.ok(cur.seal.snapshot.length === 1);    // 首次封存结果保持不动
});

test("重复封存沿用首次结果（快照、封存人、时间不变）", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 18);
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "完好", x: 40, y: 40 }
  });
  const r1 = await store.mutate("sealDive", { diveId: dive.id, by: dive.diverA });
  assert.equal(r1.reused, false);

  // 更正后再封存：仍沿用首次封存
  const mid = store.getState().dives.find(d => d.id === dive.id).marks[0].id;
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverB,
    data: { id: mid, code: "A-1", type: "ceramic", depth: 18, orientation: "东", condition: "完好", x: 40, y: 40 }
  });
  const r2 = await store.mutate("sealDive", { diveId: dive.id, by: dive.diverA });
  assert.equal(r2.reused, true);
  const cur = store.getState().dives.find(d => d.id === dive.id);
  assert.equal(cur.seal.snapshot[0].depth, 17);
  assert.equal(cur.seal.at, r1.seal.at);
  assert.equal(cur.events.filter(e => e.type === "sealed").length, 1);
});

test("并发封存/复核只成功一次", async () => {
  const store = freshStore();
  const dive = await setupDive(store, 18);
  await store.mutate("startDive", { diveId: dive.id, by: dive.diverA });
  await store.mutate("upsertMark", {
    diveId: dive.id, by: dive.diverA,
    data: { code: "A-1", type: "ceramic", depth: 17, orientation: "东", condition: "完好", x: 40, y: 40 }
  });

  const results = await Promise.allSettled([
    store.mutate("sealDive", { diveId: dive.id, by: dive.diverA }),
    store.mutate("sealDive", { diveId: dive.id, by: dive.diverA })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "CONCURRENT");

  // 串行的重复封存允许进入规则层，并被识别为沿用首次结果
  const again = await store.mutate("sealDive", { diveId: dive.id, by: dive.diverA });
  assert.equal(again.reused, true);

  const rs = await Promise.allSettled([
    store.mutate("confirmReview", { diveId: dive.id, by: dive.diverB }),
    store.mutate("confirmReview", { diveId: dive.id, by: dive.diverB })
  ]);
  assert.equal(rs.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(rs.find(r => r.status === "rejected").reason.code, "CONCURRENT");
});

test("数据刷新后仍在：重新装载 Store 保留状态", async () => {
  const ls = memStorage();
  let store = new Store(ls);
  const s = store.getState();
  const diveId = s.dives[0].id;
  store = new Store(ls);
  assert.ok(store.getState().dives.some(d => d.id === diveId));
});

test("旧版 zfl30Marks 数据一次性迁移为潜次结构", () => {
  const legacy = [
    { id: "x1", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46,
      depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
    { id: "x2", code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39,
      depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" }
  ];
  const ls = memStorage({ zfl30Marks: JSON.stringify(legacy) });
  const store = new Store(ls);
  const st = store.getState();
  assert.equal(st.dives.length, 2);
  assert.equal(st.dives[0].marks[0].depth, 17.8);
  assert.equal(st.dives.every(d => d.status === "open"), true);
  assert.equal(ls.getItem("zfl30Marks"), null); // 旧键已清理
  // 再次装载不再迁移
  const second = new Store(ls);
  assert.equal(second.getState().dives.length, 2);
});

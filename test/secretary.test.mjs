import assert from "node:assert/strict";
import test from "node:test";
import { createRecallSecretary, summarizeTraces } from "../src/index.mjs";
import { evidenceWindow, explicitRecallSignal, roundRobin } from "../src/policy.mjs";

class FakeMemory {
  constructor(rows) { this.rows = rows; }
  async search(query) {
    return this.rows.filter(row => (row.key + row.content).includes(query)).map((row, i) => ({ ...row, score: 10 - i }));
  }
}

test("explicit recall phrases are detected", () => {
  assert.equal(explicitRecallSignal("还记得上次坐夜班车吗"), true);
  assert.equal(explicitRecallSignal("夜班车几点发车"), false);
});

test("evidence window opens around the first preferred needle", () => {
  const text = "无关。".repeat(80) + "夜班车进隧道后断网。" + "结尾。".repeat(80);
  assert.match(evidenceWindow(text, ["夜班车"], 80), /夜班车/);
});

test("round robin prevents one broad query from filling the shortlist", () => {
  assert.deepEqual(roundRobin([[{ key: "a" }, { key: "b" }], [{ key: "x" }]], 3).map(x => x.key), ["a", "x", "b"]);
});

test("event candidates are judged first and selected memory is not repeated", async () => {
  const memory = new FakeMemory([
    { key: "note:夜班车购票", content: "夜班车购票页面改版" },
    { key: "episodic:第一次坐夜班车", content: "第一次坐夜班车，进隧道后断网，于是约好每站报平安。" },
  ]);
  let firstKey;
  const judge = async ({ candidates }) => { firstKey = candidates[0].key; return [{ i: 0, relevant: true, why: "同一次夜班车经历" }]; };
  const secretary = createRecallSecretary({ memory, judge, eventWords: ["第一次坐夜班车"], maxDeliver: 1 });
  const one = await secretary.recall("还记得第一次坐夜班车吗？", { sessionId: "s" });
  assert.equal(firstKey, "episodic:第一次坐夜班车");
  assert.equal(one.items.length, 1);
  assert.match(one.text, /只作证据不作处方/);
  const two = await secretary.recall("还记得第一次坐夜班车吗？", { sessionId: "s" });
  assert.ok(!two.items.some(item => item.key === one.items[0].key));
});

test("judge rejection injects nothing", async () => {
  const memory = new FakeMemory([{ key: "note:雨天", content: "一次雨天散步" }]);
  const secretary = createRecallSecretary({ memory, judge: async () => [] });
  const result = await secretary.recall("今天是雨天，想出去散步", { sessionId: "s" });
  assert.equal(result.text, "");
  assert.equal(result.trace.status, "rejected");
});

test("reset starts a new visibility window", async () => {
  const memory = new FakeMemory([{ key: "note:香草种植", content: "阳台香草种植记录" }]);
  const secretary = createRecallSecretary({ memory, judge: async () => [{ i: 0, relevant: true, why: "同一计划" }] });
  assert.equal((await secretary.recall("香草种植", { sessionId: "s" })).items.length, 1);
  assert.equal((await secretary.recall("香草种植", { sessionId: "s" })).items.length, 0);
  await secretary.reset("s");
  assert.equal((await secretary.recall("香草种植", { sessionId: "s" })).items.length, 1);
});

test("health summary contains no query or memory text", () => {
  const summary = summarizeTraces([
    { status: "selected", selected: 1, ms: 20, privateText: "不应进入汇总" },
    { status: "rejected", selected: 0, ms: 10 },
  ]);
  assert.deepEqual(summary, {
    total: 2, selectedItems: 1, averageMs: 15,
    statuses: { selected: 1, rejected: 1, no_hit: 0, skipped: 0, failed: 0 },
  });
  assert.ok(!JSON.stringify(summary).includes("不应进入汇总"));
});

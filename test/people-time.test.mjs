import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRecallSecretary, createFileSeenStore, parseTimeWindow, clearlyNamed, findPeople } from "../src/index.mjs";
import { normalizePeople } from "../src/people.mjs";

class Mem {
  constructor(rows) { this.rows = rows; }
  async search(q) { return this.rows.filter(r => (r.key + r.content).includes(q)).map((r, i) => ({ ...r, score: 10 - i })); }
  async get(key) { return this.rows.find(r => r.key === key)?.content; }
}
const people = {
  cards: { "阿梨": "people:阿梨:profile", "石头": "people:石头:profile", "妈妈": "people:妈妈:profile" },
  aliases: { "梨梨子": "阿梨" },
  ambiguous: ["石头"],
  kin: ["妈妈"],
};
const rows = [
  { key: "people:阿梨:profile", content: "阿梨，人类的大学室友。\n\n现在：在外地读研，常寄明信片。" },
  { key: "people:石头:profile", content: "石头，一起下棋的笔友。" },
  { key: "people:妈妈:profile", content: "人类的妈妈，喜欢种花。" },
  { key: "episodic:2026-05-02:和阿梨去看海", content: "五一和阿梨去看海，捡了一袋贝壳。" },
  { key: "episodic:2026-09-20:贝壳风铃", content: "把贝壳串成风铃挂在阳台。" },
];
const rejectAll = async () => [];

test("名字直接点到：人物卡不过判官直接递", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), people, judge: rejectAll });
  const r = await s.recall("阿梨今天给我打电话了", { sessionId: "a" });
  assert.equal(r.items[0].key, "people:阿梨:profile");
  assert.match(r.items[0].why, /阿梨/);
});

test("用别名叫也认得出来", () => {
  const book = normalizePeople(people);
  assert.equal(findPeople("梨梨子说她到家了", book).get("阿梨"), "梨梨子");
});

test("像普通词的名字：随口提到要过判官，明摆着问这个人就直递", async () => {
  const book = normalizePeople(people);
  assert.equal(clearlyNamed("石头", "石头", "你记得石头吗", book), true);
  assert.equal(clearlyNamed("石头", "石头", "你记得石头剪刀布吗", book), false);
  const s = createRecallSecretary({ memory: new Mem(rows), people, judge: rejectAll, mustPushOnRecall: false });
  assert.equal((await s.recall("我们来玩石头剪刀布", { sessionId: "b" })).items.length, 0);
  assert.equal((await s.recall("你还记得石头吗", { sessionId: "c" })).items[0].key, "people:石头:profile");
});

test("「你妈妈」说的不是这家的妈妈", () => {
  const book = normalizePeople(people);
  assert.equal(findPeople("你妈妈今天来了吗", book).has("妈妈"), false);
  assert.equal(findPeople("妈妈今天来了", book).has("妈妈"), true);
});

test("搜索和人物卡带回同一个 key：留人物卡那份", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), people, judge: rejectAll, mustPushOnRecall: false });
  const r = await s.recall("阿梨", { sessionId: "d" });
  assert.equal(r.items.filter(i => i.key === "people:阿梨:profile").length, 1);
  assert.equal(r.items[0].lane, "person");
});

test("明确追忆而判官全拦：递最接近的一条并写明不一定是", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), judge: rejectAll });
  const r = await s.recall("还记得贝壳风铃吗", { sessionId: "e" });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].unsure, true);
  assert.match(r.text, /不一定是同一件事/);
});

test("点名喊秘书、自己没说翻什么：拿前几句当题目", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), summonNames: ["小秘书"], judge: async ({ candidates }) => [{ i: 0, relevant: true, why: "同一串风铃" }] });
  const r = await s.recall("小秘书快翻一下！", { sessionId: "f", context: [{ role: "user", text: "阳台那串贝壳风铃" }] });
  assert.equal(r.items[0].key, "episodic:2026-09-20:贝壳风铃");
});

test("说了月份就只看那个月的记忆；系统时间戳不算人说的", async () => {
  const now = new Date("2026-10-17T12:00:00");
  assert.deepEqual(parseTimeWindow("五一那会儿，5月去看海", now), { from: "2026-05", to: "2026-05", said: "2026-05" });
  assert.equal(parseTimeWindow("[2026-10-17 14:30] 今天好累".replace(/^\[[^\]]+\]\s*/, ""), now), null);
  const s = createRecallSecretary({ memory: new Mem(rows), now: () => now, judge: async ({ candidates }) => candidates.map((c, i) => ({ i, relevant: true, why: "贝壳" })) });
  const r = await s.recall("[2026-10-17 14:30] 5月捡的贝壳还在吗", { sessionId: "g" });
  assert.deepEqual(r.items.map(i => i.key), ["episodic:2026-05-02:和阿梨去看海"]);
  assert.equal(r.trace.timeWindow.mode, "hard");
});

test("已递名单落盘，重启还在；reset 清空", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seen-"));
  const store = createFileSeenStore(dir);
  const mk = () => createRecallSecretary({ memory: new Mem(rows), people, seenStore: store, judge: rejectAll, mustPushOnRecall: false });
  assert.equal((await mk().recall("阿梨", { sessionId: "h" })).items.length, 1);
  assert.equal((await mk().recall("阿梨", { sessionId: "h" })).items.length, 0);   // 新实例 = 重启
  const s = mk(); await s.reset("h");
  assert.equal((await s.recall("阿梨", { sessionId: "h" })).items.length, 1);
});

test("很短但点了人名的话不当低信息跳过", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), people, judge: rejectAll });
  assert.equal((await s.recall("阿梨！", { sessionId: "i" })).items[0]?.key, "people:阿梨:profile");
});

test("判官抛错或回包坏形状：不递保底，返回 failed", async () => {
  const boom = createRecallSecretary({ memory: new Mem(rows), judge: async () => { throw new Error("timeout"); } });
  const r1 = await boom.recall("还记得贝壳风铃吗", { sessionId: "j1" });
  assert.equal(r1.trace.status, "failed"); assert.equal(r1.items.length, 0);
  const bad = createRecallSecretary({ memory: new Mem(rows), judge: async () => ({ nope: 1 }) });
  assert.equal((await bad.recall("还记得贝壳风铃吗", { sessionId: "j2" })).trace.status, "failed");
  // 有直递人物卡时照常递卡，判官的错留在 trace
  const withCard = createRecallSecretary({ memory: new Mem(rows), people, judge: async () => { throw new Error("timeout"); } });
  const r3 = await withCard.recall("还记得阿梨和贝壳吗", { sessionId: "j3" });
  assert.equal(r3.items[0].key, "people:阿梨:profile"); assert.equal(r3.trace.judgeError, "timeout");
});

test("已递名单文件形状不对：直接报错，不当空", async () => {
  for (const bad of ["{}", "[null]", "[\"ok\",3]", "\"x\""]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seenbad-"));
    fs.writeFileSync(path.join(dir, "k.json"), bad);
    const s = createRecallSecretary({ memory: new Mem(rows), people, seenStore: createFileSeenStore(dir), judge: rejectAll });
    await assert.rejects(s.recall("阿梨", { sessionId: "k" }), /string array/);
  }
});

test("时长不是时间；月份份工资算时间，三条路口径一致", () => {
  const now = new Date("2026-10-17T12:00:00");
  for (const t of ["宝宝 3 个月了", "再等2个月", "宝宝3个月大", "第3月"]) assert.equal(parseTimeWindow(t, now), null, t);
  assert.equal(parseTimeWindow("3月份的工资发了吗", now).from, "2026-03");
  assert.equal(parseTimeWindow("3月份工资", now).from, "2026-03");
  assert.equal(parseTimeWindow("去年3月份工资", now).from, "2025-03");
  assert.equal(parseTimeWindow("2025年3月份工资", now).from, "2025-03");
});

test("别名和卡名重叠：长的先认", () => {
  const book = normalizePeople({ cards: { "阿雨点": "people:阿雨点:profile", "小B": "people:小B:profile" }, aliases: { "阿雨": "小B" } });
  const hits = findPeople("阿雨点今天来了", book);
  assert.equal(hits.has("阿雨点"), true); assert.equal(hits.has("小B"), false);
  assert.equal(findPeople("阿雨今天来了", book).has("小B"), true);
});

test("亲属称呼用别名叫也一样：「你妈咪」不认，「妈咪来了」要认", () => {
  const book = normalizePeople({ ...people, aliases: { ...people.aliases, "妈咪": "妈妈" } });
  assert.equal(findPeople("你妈咪今天来了吗", book).has("妈妈"), false);
  assert.equal(findPeople("妈咪来了", book).get("妈妈"), "妈咪");
});

test("名单存盘失败：这一轮抛错，内存里也不算递过，下次还能递", async () => {
  let fail = true; const saved = [];
  const store = { async load() { return []; }, async save(id, keys) { if (fail) throw new Error("disk full"); saved.push(keys); } };
  const s = createRecallSecretary({ memory: new Mem(rows), people, seenStore: store, judge: rejectAll, mustPushOnRecall: false });
  await assert.rejects(s.recall("阿梨", { sessionId: "m" }), /disk full/);
  assert.deepEqual(await s.seen("m"), []);
  fail = false;
  assert.equal((await s.recall("阿梨", { sessionId: "m" })).items[0].key, "people:阿梨:profile");
});

test("reset 存盘失败：内存名单保持原样", async () => {
  let fail = false;
  const store = { async load() { return []; }, async save() { if (fail) throw new Error("disk full"); } };
  const s = createRecallSecretary({ memory: new Mem(rows), people, seenStore: store, judge: rejectAll, mustPushOnRecall: false });
  await s.recall("阿梨", { sessionId: "n" });
  fail = true;
  await assert.rejects(s.reset("n"), /disk full/);
  assert.deepEqual(await s.seen("n"), ["people:阿梨:profile"]);
});

test("不存在的月份不生成时间窗", () => {
  const now = new Date("2026-10-17T12:00:00");
  for (const t of ["2025年13月", "去年0月", "13月的事", "2025年13月份"]) assert.equal(parseTimeWindow(t, now), null, t);
});

test("空 sessionId 和 default 是同一本账", async () => {
  const s = createRecallSecretary({ memory: new Mem(rows), people, judge: rejectAll, mustPushOnRecall: false });
  await s.recall("阿梨", { sessionId: "" });
  assert.deepEqual(await s.seen("default"), ["people:阿梨:profile"]);
  await s.reset("");
  assert.deepEqual(await s.seen("default"), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRecallSecretary, createScoreJudge, nameIn, matchGlossary } from "../src/index.mjs";
import { normalizePeople, findPeople } from "../src/people.mjs";

class FakeMemory {
  constructor(rows) { this.rows = rows; }
  async search(query) { return this.rows.filter(r => (r.key + r.content).includes(query)).map((r, i) => ({ ...r, score: 10 - i })); }
  async get(key) { return this.rows.find(r => r.key === key)?.content; }
}

test("names: English names need word edges, mixed names too, spaces are flexible", () => {
  assert.equal(nameIn("这周在 evaluate 新模型", "Eva"), false);
  assert.equal(nameIn("Eva 说她到家了", "Eva"), true);
  assert.equal(nameIn("WeChat 小葵", "Chat 小葵"), false);
  assert.equal(nameIn("去找 Chat  \n小葵 玩", "Chat 小葵"), true);
  assert.equal(nameIn("用C++写", "C++"), true);
  assert.equal(nameIn("阿梨呀", "阿梨"), true);
});

test("people: an English alias inside another word is not a hit", () => {
  const book = normalizePeople({ cards: { Eva: "people:Eva:profile" } });
  assert.equal(findPeople("evaluate 跑完了", book).size, 0);
  assert.equal(findPeople("eva 回信了", book).size, 1);
});

test("glossary: attached even when the judge rejects everything, capped, card names excluded", async () => {
  const memory = new FakeMemory([{ key: "note:晚饭", content: "一起做晚饭" }, { key: "people:阿梨:profile", content: "阿梨是朋友" }]);
  const glossary = { "月影": "人类自己的网名", "阿梨": "朋友（旧注解）", ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["词条" + i + "号", "注解" + i])) };
  const secretary = createRecallSecretary({ memory, judge: async () => [], glossary, people: { cards: { "阿梨": "people:阿梨:profile" } } });
  const r = await secretary.recall("月影：今晚吃什么 晚饭", { sessionId: "g" });
  assert.equal(r.trace.status, "rejected");
  assert.match(r.text, /月影：人类自己的网名/);
  const many = await secretary.recall(Array.from({ length: 10 }, (_, i) => "词条" + i + "号").join(" "), { sessionId: "g2" });
  assert.equal(many.items.filter(x => x.lane === "glossary").length, 6);
  assert.equal(many.trace.glossaryDropped, 4);
  const card = await secretary.recall("阿梨说她到家了", { sessionId: "g3" });
  assert.ok(!card.items.some(x => x.key === "glossary:阿梨"));
});

test("glossary: skip list respected", () => {
  assert.equal(matchGlossary("家里的系统叫小纸条", { "小纸条": "系统名" }, { skip: ["小纸条"] }).items.length, 0);
});

test("score judge: top over threshold is delivered even when the runner-up is close", async () => {
  const judge = createScoreJudge(async () => [0.64, 0.56, 0.1], { threshold: 0.6 });
  const out = await judge({ candidates: [{}, {}, {}], maxPick: 2 });
  assert.deepEqual(out.map(x => x.i), [0]);
  const strict = createScoreJudge(async () => [0.64, 0.56, 0.1], { threshold: 0.6, margin: 0.1 });
  assert.equal((await strict({ candidates: [{}, {}, {}], maxPick: 2 })).length, 0);
  const two = createScoreJudge(async () => [0.8, 0.75], { threshold: 0.6 });
  assert.equal((await two({ candidates: [{}, {}], maxPick: 2 })).length, 2);
});

test("lexical gate: small-room entries need a literal term overlap", async () => {
  const memory = { async search() { return [
    { key: "lesson:转义错字", content: "写中文别用转义", score: 9 },
    { key: "note:做客", content: "朋友来家里做客", score: 5 },
  ]; } };
  let seenKeys = [];
  const secretary = createRecallSecretary({ memory, lexicalGate: ["lesson:"], judge: async ({ candidates }) => { seenKeys = candidates.map(c => c.key); return []; } });
  const r = await secretary.recall("周末有朋友来做客", { sessionId: "l" });
  assert.deepEqual(seenKeys, ["note:做客"]);
  assert.equal(r.trace.lexicalGated, 1);
});

test("abort: a timed-out round delivers nothing and does not mark seen", async () => {
  const memory = new FakeMemory([{ key: "note:香草", content: "阳台香草" }]);
  const ac = new AbortController();
  const secretary = createRecallSecretary({ memory, glossary: { "香草": "植物" }, judge: async () => { ac.abort(); return [{ i: 0, relevant: true, why: "同一件" }]; } });
  const r = await secretary.recall("阳台香草", { sessionId: "a", signal: ac.signal });
  assert.equal(r.trace.status, "incomplete");
  assert.equal(r.text, "");
  assert.deepEqual(await secretary.seen("a"), []);
});

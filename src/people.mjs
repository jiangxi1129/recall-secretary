// 人物卡：消息里提到某个人，就把这个人的卡直接递上去，不必等搜索排到它。
// 线上踩过的几个坑都在这里：
//   1. 叫法不止一个（昵称、全名、外号）→ aliases 把别名指回卡名；
//   2. 有的名字本身是普通词（「石头」「晚晚」）→ ambiguous 里的名字要过判官，
//      除非这句话明摆着在说这个人：用别名叫的，或「记得/认识/想起」后面紧跟名字；
//   3. 亲属称呼前面贴着「你/他/她」时说的是别人家的（「你妈妈」）→ kin 里的名字遇到这种不认；
//   4. 长名字先认（别名和卡名放在一起排），认过的从句子里抠掉，免得「小雨点」又被认成「小雨」；
//   5. 卡太长会挤掉上下文 → 只递第一段和「现在：」那一段，封顶 600 字；
//   6. 英文名按子串认，「evaluate」里有「eva」→ 名字首尾是英文字母数字时要求边界（见 names.mjs）。

import { nameIn } from "./names.mjs";

const HAN = /\p{Script=Han}/u;
const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizePeople(people = {}) {
  const cards = { ...(people.cards || {}) };                 // { 卡名: 记忆 key }
  const aliases = { ...(people.aliases || {}) };             // { 别名: 卡名 }
  const ambiguous = new Set(people.ambiguous || []);
  const kin = new Set(people.kin || []);
  for (const name of kin) ambiguous.add(name);               // 亲属称呼一律算容易误会的名字
  return { cards, aliases, ambiguous, kin };
}

// 返回 Map(卡名 → 这句里是怎么叫的)
export function findPeople(text, people) {
  const hits = new Map();
  let rest = String(text || "").toLowerCase();
  // 别名和卡名合成一张表，统一按长度从长到短认：短别名「阿雨」不能先把卡名「阿雨点」吃掉
  const tokens = [
    ...Object.entries(people.aliases).map(([alias, name]) => ({ token: alias, name })),
    ...Object.keys(people.cards).map(name => ({ token: name, name })),
  ].filter(t => people.cards[t.name]).sort((x, y) => y.token.length - x.token.length);
  for (const { token, name } of tokens) {
    const t = token.toLowerCase();
    if (people.kin.has(name)) rest = rest.replace(new RegExp(`[你他她它]的?${escape(t)}`, "g"), "　");
    if (!nameIn(rest, t)) continue;
    if (!hits.has(name)) hits.set(name, token);
    rest = rest.split(t).join("　");
  }
  return hits;
}

// 名字像普通词，但这句明摆着在说这个人
export function clearlyNamed(name, calledAs, text, people) {
  if (people.kin.has(name)) return false;
  if (calledAs && calledAs !== name) return true;
  return new RegExp(`(记得|认识|想起)${escape(name)}(?=$|[^\\p{Script=Han}]|[吗呢吧啊嘛呀])`, "u").test(String(text || ""));
}

export function cardSnippet(full, cap = 600) {
  const t = String(full || "").trim();
  if (t.length <= cap) return t;
  const paras = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const first = paras[0] || "";
  const now = paras.find((p, i) => i > 0 && /^现在[:：]/.test(p));
  const joined = now ? `${first}\n\n${now}` : first;
  return joined.length <= cap ? joined : joined.slice(0, cap) + "…";
}

export { HAN };

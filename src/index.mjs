import { assertMemoryAdapter, JsonMemory } from "./json-memory.mjs";
import { lexicalJudge, createJsonJudge, buildJudgePrompt, createScoreJudge } from "./judges.mjs";
import { matchGlossary } from "./glossary.mjs";
import { evidenceWindow, explicitRecallSignal, extractTerms, roundRobin, shortlist, shouldSkip, stripEnvelope } from "./policy.mjs";
import { normalizePeople, findPeople, clearlyNamed, cardSnippet } from "./people.mjs";
import { parseTimeWindow, inWindow } from "./timewindow.mjs";

export const DEFAULT_HEADER = "[记忆秘书] 下面是可能相关的旧事，只作证据不作处方：不代表现在该怎么做，也不是当前正在发生的事。只在确实相关时自然带一句，不用提来源，不用逐条回应。这些是泡过水的碎片：每条是摘要，不是原话，要引用时先按 key 回原文核验；跟人类此刻说的有出入，以此刻为准；记不清就说记不清，没有比编的强。";
export const GLOSSARY_HEADER = "[名词对照] 人类亲手定的对照表，原文里出现了这些词：";
export const UNSURE_WHY = "人类在追忆，但判官没找到能确定的那件；这是最接近的一条，不一定是同一件事，对不上就说记不清";

function validResult(item) {
  return item && typeof item.key === "string" && item.key && typeof item.content === "string";
}

// 「小秘书，翻一下」这类点名：只把命令骨架剥掉，剩下的才是题目
function stripSummon(text, names) {
  let t = String(text || "");
  for (const n of names) t = t.split(n).join(" ");
  return t.replace(/(给|帮)?[我你他她]?(快|赶紧)?(翻|找|推|递|搜|查|上)(一下|一翻|翻|推|找)?[吧呀啊！!。，,\s]*/g, " ").trim();
}

export function createRecallSecretary({
  memory,
  judge = lexicalJudge,
  eventWords = [],
  people = {},
  summonNames = [],
  mustPushOnRecall = true,
  seenStore = null,
  now = () => new Date(),
  maxQueries = 6,
  perQuery = 6,
  maxCandidates = 10,
  maxDeliver = 2,
  evidenceChars = 220,
  header = DEFAULT_HEADER,
  shouldRecall = () => true,
  glossary = {},
  glossarySkip = [],
  maxGlossary = 6,
  glossaryChars = 1200,
  lexicalGate = [],
} = {}) {
  assertMemoryAdapter(memory);
  if (typeof judge !== "function") throw new TypeError("judge must be a function");
  const book = normalizePeople(people);
  if (Object.keys(book.cards).length && typeof memory.get !== "function") throw new TypeError("people.cards needs memory.get(key) -> content");
  const seenBySession = new Map();
  const sessionKey = id => String(id || "default");   // load/save/seen/reset 共用，空值一律归到 default

  async function sessionSeen(sessionId) {
    const id = sessionKey(sessionId);
    if (!seenBySession.has(id)) {
      const loaded = seenStore ? await seenStore.load(id) : [];
      if (!Array.isArray(loaded) || !loaded.every(k => typeof k === "string")) throw new Error(`seenStore.load(${id}) must return a string array`);
      seenBySession.set(id, new Set(loaded));
    }
    return seenBySession.get(id);
  }

  return {
    async reset(sessionId = "default") {
      const id = sessionKey(sessionId);
      if (seenStore) await seenStore.save(id, []);   // 先落盘，成功了再清内存，免得两边分叉
      seenBySession.set(id, new Set());
    },
    async seen(sessionId = "default") { return [...await sessionSeen(sessionId)]; },

    async recall(rawText, { sessionId = "default", context = [], signal = null } = {}) {
      const startedAt = Date.now();
      const text = stripEnvelope(rawText);
      const trace = { status: "skipped", terms: [], people: [], timeWindow: null, candidates: 0, judged: 0, selected: 0, glossary: [], ms: 0 };
      // 名词对照不看召回走到哪一步：跳过、没命中、判官全拒，原文里有对照表的词都附上（宿主超时放弃这一轮时除外）
      // 有人物卡的名字不走对照表（两套说法会打架，人物卡那份更新）
      const withGlossary = (result, { checkAbort = true } = {}) => {
        if (checkAbort && signal?.aborted) return { text: "", items: [], trace: { ...result.trace, status: "incomplete", reason: "aborted" } };
        const g = matchGlossary(text, glossary, { skip: glossarySkip, exclude: Object.keys(book.cards), maxItems: maxGlossary, maxChars: glossaryChars });
        if (!g.items.length) return result;
        const block = [GLOSSARY_HEADER, ...g.items.map(x => `- ${x.term}：${x.note}`)].join("\n");
        const items = [...result.items, ...g.items.map(x => ({ key: `glossary:${x.term}`, evidence: x.note, why: `原文出现「${x.term}」`, lane: "glossary" }))];
        return { text: result.text ? result.text + "\n" + block : block, items,
          trace: { ...result.trace, glossary: g.items.map(x => x.term), ...(g.dropped.length ? { glossaryDropped: g.dropped.length } : {}) } };
      };
      const finish = (status, extra = {}) => withGlossary({ text: "", items: [], trace: { ...trace, status, ms: Date.now() - startedAt, ...extra } });
      if (signal?.aborted) return { text: "", items: [], trace: { ...trace, status: "incomplete", reason: "aborted" } };

      const summoned = summonNames.some(n => text.includes(n));
      const hits = findPeople(text, book);
      trace.people = [...hits.keys()];
      // 「阿梨说她到家了」这种很短、却点了人名的话不能当低信息跳过
      if (!hits.size && !summoned && shouldSkip(text)) return finish("skipped", { reason: "low_information_or_tool_noise" });
      if (!summoned && !await shouldRecall(text, { context })) return finish("skipped", { reason: "policy" });

      const explicit = summoned || explicitRecallSignal(text);
      let topic = summoned ? stripSummon(text, summonNames) : text;
      // 点名却没说翻什么：拿前几句人类说的话当题目
      if (summoned && extractTerms(topic, { eventWords, max: 1 }).length === 0) {
        topic = context.filter(x => !x.role || x.role === "user" || x.role === "human").slice(-3).map(x => x.text || "").join("\n");
        if (!topic.trim()) return finish("no_hit", { reason: "summon_without_topic", explicit });
      }
      const matchedEvents = eventWords.filter(word => topic.toLowerCase().includes(String(word).toLowerCase()));
      const terms = extractTerms(topic, { eventWords, max: maxQueries });
      trace.terms = terms;
      const seen = await sessionSeen(sessionId);

      // 人物卡
      const cards = [];
      for (const [name, calledAs] of hits) {
        const key = book.cards[name];
        if (seen.has(key)) continue;
        const content = await memory.get(key);
        if (typeof content !== "string" || !content.trim()) continue;
        const direct = !book.ambiguous.has(name) || clearlyNamed(name, calledAs, text, book);
        cards.push({ key, lane: "person", direct, evidence: cardSnippet(content), why: `消息提到「${calledAs}」` });
      }

      // 搜索 + 时间窗
      let found = [];
      if (terms.length) {
        const groups = await Promise.all(terms.map(term => memory.search(term, { limit: perQuery })));
        found = roundRobin(groups.map(group => group.filter(validResult)), maxCandidates * 2).filter(item => !seen.has(item.key));
        // lexicalGate：小房间（比如一个只有十几条的「教训」房间）没有分数线，语义搜索搜什么都把那几条顶上来。
        // 线上一周 1140 轮里，教训占了 511 个候选位，真相关的只有 6 次；有一条来了 205 次，一次都不相关，白占普通记忆的名额。
        // 列在这里的 key 前缀，要求这一轮的搜索词至少有一个原样出现在 key 或正文里。
        if (lexicalGate.length) {
          const before = found.length;
          found = found.filter(item => !lexicalGate.some(p => item.key.startsWith(p))
            || terms.some(t => (item.key + "\n" + item.content).toLowerCase().includes(String(t).toLowerCase())));
          if (found.length < before) trace.lexicalGated = before - found.length;
        }
      }
      const win = parseTimeWindow(text, now());
      if (win) {
        const kept = found.filter(item => inWindow(item.key, win));
        trace.timeWindow = { ...win, mode: kept.length ? "hard" : "soft_no_match" };
        if (kept.length) found = kept;
      }
      // 同一个 key 搜索和人物卡都带回来时，留人物卡那份（它带着「为什么」和直递标记）
      const cardKeys = new Set(cards.map(c => c.key));
      found = found.filter(item => !cardKeys.has(item.key));
      const ordered = shortlist(found, matchedEvents, maxCandidates).map(item => ({
        key: item.key, score: item.score, lane: "memory",
        evidence: evidenceWindow(item.content, [...matchedEvents, ...terms], evidenceChars),
      }));
      const directCards = cards.filter(c => c.direct).slice(0, maxDeliver);
      const toJudge = [...cards.filter(c => !c.direct), ...ordered];
      trace.candidates = cards.length + ordered.length;
      if (!directCards.length && !toJudge.length) return finish("no_hit", { ...(terms.length ? {} : { reason: "no_terms" }), explicit });

      const picked = [...directCards];
      let judgeFailed = null;
      const room = maxDeliver - picked.length;
      if (room > 0 && toJudge.length) {
        let decisions;
        try { decisions = await judge({ query: text, context, candidates: toJudge, maxPick: room, explicit }); }
        catch (error) { judgeFailed = String(error?.message || error); }
        if (!judgeFailed && !Array.isArray(decisions)) judgeFailed = "judge_invalid";
        if (!judgeFailed) {
          trace.judged = toJudge.length;
          const used = new Set();
          for (const d of decisions) {
            const i = Number(d?.i);
            if (!Number.isInteger(i) || i < 0 || i >= toJudge.length || used.has(i) || d.relevant === false) continue;
            used.add(i); picked.push({ ...toJudge[i], why: String(d.why || toJudge[i].why || "判官认为是同一件事") });
            if (picked.length >= maxDeliver) break;
          }
        }
        // 人类明确在追忆（或点名喊了秘书），判官一条都没给：递最接近的一条，并写明「不一定是这件」
        // 判官没判成（抛错、回包坏形状）不算「看过但拿不准」：不递保底，下面按 failed 返回
        if (!picked.length && explicit && mustPushOnRecall && !judgeFailed) {
          picked.push({ ...toJudge[0], why: UNSURE_WHY, unsure: true });
          trace.mustPush = true;
        }
      }
      if (!picked.length) return judgeFailed ? finish("failed", { reason: "judge_error", error: judgeFailed, explicit }) : finish("rejected", { explicit });
      // 宿主已经超时放弃这一轮：不写已递名单，不交付（不然名单里记着递过，AI 其实没收到）
      if (signal?.aborted) return { text: "", items: [], trace: { ...trace, status: "incomplete", reason: "aborted", explicit } };

      // 先存新名单，存成功了再换掉内存里的；存失败就抛出去，这一轮没交付，下次还能递
      const nextSeen = new Set(seen);
      for (const item of picked) nextSeen.add(item.key);
      if (seenStore) await seenStore.save(sessionKey(sessionId), [...nextSeen]);
      seenBySession.set(sessionKey(sessionId), nextSeen);
      trace.selected = picked.length;
      if (judgeFailed) trace.judgeError = judgeFailed;
      const items = picked.map(({ key, evidence, score, why, lane, unsure }) => ({ key, evidence, score, why, lane, ...(unsure ? { unsure } : {}) }));
      const injected = [header, ...items.map(item => `- [${item.key}]（${item.why}）\n${item.evidence}`)].join("\n");
      return withGlossary({ text: injected, items, trace: { ...trace, status: "selected", explicit, ms: Date.now() - startedAt } }, { checkAbort: false });   // 已递名单已经写了，这里不能再改口成没交付
    },
  };
}

export { JsonMemory, lexicalJudge, createJsonJudge, buildJudgePrompt, createScoreJudge, matchGlossary };
export { nameIn, nameRe } from "./names.mjs";
export { summarizeTraces } from "./health.mjs";
export { findPeople, clearlyNamed, cardSnippet } from "./people.mjs";
export { parseTimeWindow } from "./timewindow.mjs";
export { createFileSeenStore } from "./seen-store.mjs";

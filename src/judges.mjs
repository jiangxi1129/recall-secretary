import { normalize } from "./policy.mjs";

const TOKENS = /[a-z0-9][a-z0-9._-]{2,}|[\p{Script=Han}]{2,}/gu;

function tokens(text) {
  const value = normalize(text);
  const result = new Set(value.match(TOKENS) || []);
  for (const run of value.match(/[\p{Script=Han}]{3,}/gu) || []) {
    for (let i = 0; i + 1 < run.length; i++) result.add(run.slice(i, i + 2));
  }
  return result;
}

// 零依赖后备判官，只适合演示和离线兜底。生产环境最好换成能判断语义的 judge。
export async function lexicalJudge({ query, candidates, maxPick = 2 }) {
  const queryTokens = tokens(query);
  const ranked = candidates.map((candidate, i) => {
    const haystack = tokens(candidate.key + "\n" + candidate.evidence);
    let overlap = 0;
    for (const token of queryTokens) if (haystack.has(token)) overlap++;
    return { i, overlap, score: Number(candidate.score) || 0 };
  }).filter(row => row.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.score - a.score);
  return ranked.slice(0, maxPick).map(row => ({ i: row.i, relevant: true, why: `有 ${row.overlap} 个具体词重合` }));
}

export function buildJudgePrompt({ query, context = [], candidates, maxPick = 2 }) {
  const history = context.length ? `【前几轮聊天】\n${context.map(x => `- ${x.role || "对话"}：${x.text || ""}`).join("\n")}\n\n` : "";
  const list = candidates.map((item, i) => `[${i}] (${item.key}) ${item.evidence}`).join("\n");
  return `你是记忆秘书。你要帮一台 AI 回答人类此刻这句话，只挑真正相关的旧记忆。\n\n${history}【人类这句】\n${query}\n\n【候选旧记忆】\n${list}\n\n先分别判断当前话题和每条记忆的话题。只有同一个人、同一件事，或人类明确在追忆这一次，才算相关。只出现同一个词、同一个人、同一个地点，讲的却是另一件事，判无关；要绕两步才能连上，判无关；拿不准也判无关。最多选 ${maxPick} 条。输出 JSON 数组，每项是 {"i":编号,"relevant":布尔值,"why":"具体理由"}，不要多余文字。`;
}

export function createJsonJudge(callModel) {
  if (typeof callModel !== "function") throw new TypeError("callModel must be a function");
  return async input => {
    const raw = await callModel(buildJudgePrompt(input));
    const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("judge did not return an array");
    const seen = new Set();
    return parsed.filter(item => {
      if (!item || !Number.isInteger(item.i) || item.i < 0 || item.i >= input.candidates.length || seen.has(item.i)) return false;
      seen.add(item.i); return item.relevant === true && String(item.why || "").trim().length >= 2;
    }).slice(0, input.maxPick);
  };
}

// 只给「相关概率」的判官（分类模型、打分接口）怎么换算成递不递。
// scoreFn({ query, context, candidates }) 返回和 candidates 等长的 0–1 数组。
// 规则：第一名过 threshold 就递；其余的要过 extra 才跟着递。
// margin 是「第一名还得比第二名高出多少」，默认 0。
// 线上踩过的坑：门槛已经抬到 0.6，还要求领先第二名 0.1——人类说「问问朋友们愿不愿意来我们家做客」，
// 「客厅重新布置」0.64、「门口挂的钟」0.56，两条都对得上，结果因为差距只有 0.08，一条都没递。
// 两条都相关反而交白卷。门槛低的时候 margin 能挡掉一片「都差不多像」的噪音；门槛已经够高，就别再叠这道。
export function createScoreJudge(scoreFn, { threshold = 0.6, margin = 0, extra = 0.7 } = {}) {
  if (typeof scoreFn !== "function") throw new TypeError("scoreFn must be a function");
  return async input => {
    const probs = await scoreFn(input);
    if (!Array.isArray(probs) || probs.length !== input.candidates.length || probs.some(p => typeof p !== "number")) throw new Error("scoreFn must return one number per candidate");
    const order = probs.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const top = order[0], runner = order.length > 1 ? probs[order[1]] : 0;
    let keep = [];
    if (probs[top] >= threshold && probs[top] - runner >= margin) keep = [top, ...order.slice(1).filter(i => probs[i] >= extra)];
    else if (probs[top] >= extra) keep = order.filter(i => probs[i] >= extra);
    return keep.slice(0, input.maxPick).map(i => ({ i, relevant: true, why: `判官打分 ${probs[i].toFixed(2)}` }));
  };
}

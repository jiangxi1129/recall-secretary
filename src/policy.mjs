const LOW_INFORMATION = /^(?:嗯+|哦+|好+|哈哈+|谢谢|收到|早安|晚安)[啊呀啦喔哦哈~～。！!？?\s]*$/i;
const TOOL_NOISE = /(?:tool_(?:use|result)|traceback|stderr|exit code|error calling tool|调用工具)/i;
const STOP_WORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "这些", "那些", "现在", "刚刚", "之前", "以前",
  "最近", "上次", "那次", "怎么", "为什么", "什么", "觉得", "好像", "还是", "就是", "已经",
  "可以", "不是", "一个", "一下", "事情", "时候", "今天", "昨天", "明天", "的人", "的话"
]);

export function stripEnvelope(text) {
  return String(text || "")
    .replace(/^\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/, "")
    .replace(/^\s*\[(?:system|系统|通知)[^\]\n]*\]\s*/i, "")
    .replace(/\[image \d+ attached:[^\]]*\]/gi, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function shouldSkip(text) {
  const value = stripEnvelope(text);
  return !value || LOW_INFORMATION.test(value) || TOOL_NOISE.test(value);
}

export function explicitRecallSignal(text) {
  const value = String(text || "").toLowerCase();
  return /(?:之前|以前|上次|那次|过去).{0,12}(?:聊过|说过|提过|发生|做过|去过)/.test(value)
    || /(?:聊过|说过|提过|发生过).{0,8}(?:吗|没|没有|来着)/.test(value)
    || /(?:什么时候|哪天|多久前).{0,8}(?:的事|发生|来着)/.test(value)
    || /(?:记不记得|还记得|记得吗|想得起来)/.test(value);
}

export function normalize(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function extractTerms(text, { eventWords = [], max = 6 } = {}) {
  const value = normalize(stripEnvelope(text)).replace(/\[[^\]]*\]/g, " ");
  const out = [];
  const add = term => {
    const clean = normalize(term);
    if (clean.length < 2 || STOP_WORDS.has(clean) || out.includes(clean)) return;
    out.push(clean);
  };
  // 事件词先放。线上踩过的坑是普通抽词把“看病、搬家、第一次出门”之类经历挤到候选末尾。
  for (const word of eventWords) if (value.includes(normalize(word))) add(word);
  for (const word of value.match(/[a-z0-9][a-z0-9._-]{2,}/g) || []) add(word);
  for (const run of value.match(/[\p{Script=Han}]{2,12}/gu) || []) {
    add(run);
    if (run.length > 4) for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2));
  }
  return out.slice(0, max);
}

export function evidenceWindow(text, needles, span = 220) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(value);
  if (chars.length <= span) return value;
  let hit = -1;
  for (const needle of needles || []) {
    const index = value.indexOf(String(needle || ""));
    if (index >= 0) { hit = index; break; }
  }
  if (hit < 0) return chars.slice(0, span).join("") + "…";
  const before = Array.from(value.slice(0, hit)).length;
  const start = Math.max(0, before - Math.floor(span / 3));
  return (start ? "…" : "") + chars.slice(start, start + span).join("") + (start + span < chars.length ? "…" : "");
}

export function roundRobin(groups, limit = 12) {
  const result = [], seen = new Set();
  const depth = Math.max(0, ...groups.map(group => group.length));
  for (let rank = 0; rank < depth && result.length < limit; rank++) {
    for (const group of groups) {
      const item = group[rank];
      if (!item?.key || seen.has(item.key)) continue;
      seen.add(item.key); result.push(item);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function shortlist(candidates, eventWords, limit = 10) {
  const isEvent = item => eventWords.some(word => normalize(item.key).includes(normalize(word)) || normalize(item.content).includes(normalize(word)));
  const events = candidates.filter(isEvent);
  const rest = candidates.filter(item => !isEvent(item));
  return [...events, ...rest].slice(0, limit);
}

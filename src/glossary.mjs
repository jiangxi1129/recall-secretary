// 名词对照表：原文里出现就直接附上，不过判官。
// 线上那次：人类转来一段聊天记录，记录里用的是人类自己的网名，AI 把那个网名当成了别人。
// 对照表里明明写着「这个网名就是人类本人」，可那条要和别的记忆一起排队、过判官，被判成无关丢了。
// 对照表本来就是人类亲手定的白名单，不该再让判官裁。
// 但要封顶：一大段聊天记录一次命中十几个词时，最多附 maxItems 条、总共 maxChars 字，剩下的记进 trace。
import { nameIn } from "./names.mjs";

export function matchGlossary(text, glossary = {}, { skip = [], exclude = [], maxItems = 6, maxChars = 1200 } = {}) {
  const skipSet = new Set(skip), excluded = new Set(exclude);
  const hits = Object.keys(glossary).filter(term =>
    term.length >= 2 && !skipSet.has(term) && !excluded.has(term) && typeof glossary[term] === "string" && nameIn(text, term));
  const items = [];
  let chars = 0;
  for (const term of hits) {
    if (items.length >= maxItems) break;
    const line = glossary[term];
    if (chars + line.length > maxChars) break;
    items.push({ term, note: line });
    chars += line.length;
  }
  return { items, dropped: hits.filter(t => !items.some(x => x.term === t)) };
}

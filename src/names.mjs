// 名字和词条在句子里认不认得出来。
// 线上踩过的坑：
//   1. 英文名按子串认，「evaluate」里有「eva」，一聊评测就递 Eva 的卡；
//   2. 中英混合的名字（「Chat 小葵」）按子串认，「WeChat 小葵」也算命中；
//   3. 名字中间的空格多打一个、或者换了行，又认不出来。
// 做法：名字首/尾是英文字母或数字，就在那一头要求边界；中间的空白认任意空白；纯中文名照旧按子串。
const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function nameRe(name) {
  const n = String(name).trim();
  const body = n.split(/\s+/).map(escape).join("\\s+");
  const pre = /^[a-z0-9]/i.test(n) ? "(?<![a-z0-9])" : "";
  const post = /[a-z0-9]$/i.test(n) ? "(?![a-z0-9])" : "";
  return new RegExp(pre + body + post, "iu");
}

export function nameIn(text, name) {
  return nameRe(name).test(String(text || ""));
}

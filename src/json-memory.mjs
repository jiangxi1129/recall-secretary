import fs from "node:fs";
import path from "node:path";
import { normalize } from "./policy.mjs";

function scoreRecord(record, terms) {
  const key = normalize(record.key), content = normalize(record.content);
  let score = 0;
  for (const term of terms) {
    const needle = normalize(term);
    if (!needle) continue;
    if (key.includes(needle)) score += 3;
    if (content.includes(needle)) score += 1;
  }
  return score;
}

export class JsonMemory {
  constructor(file) { this.file = path.resolve(file); }

  #load() {
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([key, content]) => ({ key, content }));
    return rows.filter(row => row && typeof row.key === "string" && typeof row.content === "string");
  }

  async search(query, { limit = 8 } = {}) {
    const terms = Array.isArray(query) ? query : [query];
    return this.#load().map(row => ({ ...row, score: scoreRecord(row, terms) }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .slice(0, limit);
  }
}

export function assertMemoryAdapter(memory) {
  if (!memory || typeof memory.search !== "function") throw new TypeError("memory must provide search(query) -> [{ key, content, score }]");
  return memory;
}

// 人物卡要按 key 直接取全文
JsonMemory.prototype.get = async function (key) {
  const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
  if (Array.isArray(raw)) return raw.find(row => row && row.key === key)?.content;
  return typeof raw[key] === "string" ? raw[key] : undefined;
};

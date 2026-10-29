import fs from "node:fs";
import path from "node:path";

// 「这一窗已经递过哪些」落盘，重启不丢。换窗、压缩时调 secretary.reset(sessionId) 清掉——
// 压缩之后 AI 已经看不到前面递过的证据，名单不清就会变成「递过但看不见、再也不递」。
// 读坏了不当空（当空会把旧卡全部再递一遍还没人知道）：抛出去让宿主决定。
export function createFileSeenStore(dir) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const file = id => path.join(root, encodeURIComponent(id) + ".json");
  return {
    async load(id) {
      let raw;
      try { raw = fs.readFileSync(file(id), "utf8"); }
      catch (e) { if (e.code === "ENOENT") return []; throw e; }
      const keys = JSON.parse(raw);
      if (!Array.isArray(keys) || !keys.every(k => typeof k === "string")) throw new Error(`seen file for ${id} is not a string array`);
      return keys;
    },
    async save(id, keys) {
      const f = file(id), tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 });
      fs.renameSync(tmp, f);
    },
  };
}

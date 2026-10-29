import { fileURLToPath } from "node:url";
import { createRecallSecretary, JsonMemory } from "../src/index.mjs";

const file = fileURLToPath(new URL("./memory.json", import.meta.url));
const secretary = createRecallSecretary({
  memory: new JsonMemory(file),
  eventWords: ["夜班车", "种植", "忘带伞"],
  people: { cards: { "阿梨": "people:阿梨:profile" }, aliases: { "梨梨子": "阿梨" } },
  summonNames: ["小秘书"],
});

for (const line of ["还记得上次坐夜班车时，我们怎么约定的吗？", "梨梨子说她下周回来"]) {
  const result = await secretary.recall(line, { sessionId: "demo" });
  console.log(`> ${line}\n${result.text || "（这轮没有相关旧事）"}\n`);
}

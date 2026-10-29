# Recall Secretary（记忆秘书）

给对话 AI 加一层克制的长期记忆召回：每轮先查记忆库，再由判官判断是不是同一件事，只有真正相关的旧事才放进上下文。

这不是一套“看到关键词就翻旧账”的 RAG 模板。核心原则是：**旧记忆只作证据，不作处方**。记忆能提醒 AI 曾经发生过什么，却不能替当前的人作决定，也不能压过人类此刻说的话。

## 能做什么

- 接任意记忆库，只要求实现 `search(query) -> [{ key, content, score }]`。
- 每轮从人类消息抽具体词，多路查询后交错合并，避免一个宽泛词塞满候选。
- 事件词优先，让“第一次出门、看病、搬家”这类经历不被普通搜索结果挤掉。
- 判官逐条判断“是不是同一个人、同一件事”，拿不准就不递。
- 消息里提到某个人，直接递这个人的人物卡；认得别名，名字像普通词的会多一道判官。
- 人类问「还记得……吗」，或者点名喊秘书，判官一条都没放时也会递最接近的一条，并写明「不一定是这件」。
- 人类说了「5 月」「去年」这类时间，只看那段时间的记忆。
- 同一会话窗口不重复递同一条；名单可以落盘，压缩或换窗口时 `reset()`。
- 名词对照表：人类亲手定的词条（网名、小名、家里的叫法），原文里出现就直接附上，不过判官。
- 只给概率的判官（分类模型、打分接口）有现成的换算规则，可以调门槛。
- 宿主超时放弃这一轮时传 `signal`，秘书不会把「没交付的」记成「递过了」。
- 自带本地 JSON 记忆库和零依赖词面判官，下载后可以直接跑。
- 可换成自己的向量库、全文索引、本地模型或云端模型。

## 三分钟跑起来

需要 Node.js 20 或以上。

```bash
git clone <你的仓库地址>
cd recall-secretary
npm test
npm run example
```

这个版本没有运行时依赖，不需要 `npm install`。示例记忆在 `examples/memory.json`，运行后会输出一段可以追加到 AI 提示词里的证据块。

最小接法：

```js
import { createRecallSecretary, JsonMemory } from "recall-secretary";

const secretary = createRecallSecretary({
  memory: new JsonMemory("./memory.json"),
  eventWords: ["第一次出门", "看病", "搬家", "生日"],
});

const recalled = await secretary.recall(humanMessage, {
  sessionId: conversationId,
  context: recentTurns,
});

const prompt = recalled.text
  ? `${humanMessage}\n\n${recalled.text}`
  : humanMessage;
```

如果对话被压缩、换窗，AI 已经看不到前半段上下文，就清掉那一窗的“已递过”名单：

```js
await secretary.reset(conversationId);
```

## 人物卡、点名、时间

```js
const secretary = createRecallSecretary({
  memory,                      // 用人物卡时 memory 还要有 get(key) -> 正文
  people: {
    cards: { "阿梨": "people:阿梨:profile", "石头": "people:石头:profile", "妈妈": "people:妈妈:profile" },
    aliases: { "梨梨子": "阿梨", "我妈": "妈妈" },   // 别名 → 卡名。人类说「我妈」不说「妈妈」，卡名对不上就认不出
    ambiguous: ["石头"],             // 名字本身是普通词：随口提到要过判官
    kin: ["妈妈"],                   // 亲属称呼：「你妈妈」不认
  },
  summonNames: ["小秘书"],          // 人类喊这个名字，就当成明确在翻旧事
  seenStore: createFileSeenStore("./.recall-seen"),   // 已递名单落盘
});
```

- **人物卡**：提到名字就递，不等搜索排名，也不过判官。卡只递第一段和以「现在：」开头那一段，最多 600 字，旧事留在卡的后半截，不挤占上下文。
- **像普通词的名字**：「我们来玩石头剪刀布」不该递石头的卡，所以 `ambiguous` 里的名字要过判官；但「你还记得石头吗」「梨梨子说……」这种明摆着在说这个人的，照样直递。
- **点名**：句子里出现 `summonNames` 就算明确追忆；只喊了名字没说翻什么，就拿前三句人类说的话当题目。
- **追忆时保底**：明确追忆、判官看过却一条都没放时，递最接近的一条（判官自己出错不算，那时返回 `failed`，不拿保底冒充），`why` 写的是「不一定是同一件事，对不上就说记不清」，`items[i].unsure = true`。不想要这一条就设 `mustPushOnRecall: false`。
- **时间窗**：人类说了「2025 年 3 月」「5 月」「3 月份的工资」「去年」（「3 个月」「几个月大」是时长，不算），只留 key 里日期落在这段的记忆（key 里要有 `YYYY-MM`）。筛完一条不剩就退回不筛，`trace.timeWindow.mode` 会写 `soft_no_match`。消息前面系统加的时间戳会先剥掉，不会被当成人类说的时间。

## 名词对照、打分判官、小房间、超时

```js
import { createRecallSecretary, createScoreJudge } from "recall-secretary";

const secretary = createRecallSecretary({
  memory,
  glossary: {                         // 人类亲手定的对照表：原文出现就附上
    "月影": "人类自己的网名。转来的聊天记录里「月影：」后面是人类本人在说话",
    "小纸条": "家里的便签系统",
  },
  glossarySkip: ["小纸条"],           // 表里有、但 AI 早就知道的，不必每次附
  judge: createScoreJudge(scoreFn, { threshold: 0.6 }),   // scoreFn 返回每条候选的 0–1 相关概率
  lexicalGate: ["lesson:"],           // 这类 key 要和搜索词有字面重合才进候选
});

const ac = new AbortController();
setTimeout(() => ac.abort(), 8000);
const recalled = await secretary.recall(humanMessage, { sessionId, context, signal: ac.signal });
```

- **名词对照**：不看召回走到哪一步，跳过、没命中、判官全拒都照附。最多 6 条、总共 1200 字（`maxGlossary` / `glossaryChars`），超出的条数记在 `trace.glossaryDropped`。有人物卡的名字不走对照表。
- **打分判官**：第一名过 `threshold` 就递，其余要过 `extra`（默认 0.7）才跟着递。`margin`（第一名要领先第二名多少）默认 0，原因见下面第 18 条。
- **小房间**：条目很少的房间（教训、规矩），语义搜索搜什么都会把那几条顶上来。列进 `lexicalGate` 的前缀，要求搜索词原样出现在 key 或正文里。
- **超时**：`signal` 中止后返回 `trace.status = "incomplete"`，不交付、不写已递名单，名词对照也不附。

## 换成自己的记忆库

适配器只有一个必需方法：

```js
const memory = {
  async search(query, { limit = 8 } = {}) {
    return [
      { key: "episodic:2026-04-09:雨天忘带伞", content: "完整记忆正文", score: 0.91 },
    ];
  },
};
```

字段含义来自现役接口的通用部分：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `key` | 是 | 稳定且唯一的记忆键，也用于回原文核验 |
| `content` | 是 | 记忆正文 |
| `score` | 否 | 搜索相关分，只用于同层排序，不能代替判官 |

不要把向量相似度直接当“可以递”。相似只说明词或语义靠近，不能证明在说同一件事。

## 换成语义判官

内置 `lexicalJudge` 只为离线演示准备。生产环境建议接一个本地模型，或在隐私允许时接云端模型：

```js
import { createJsonJudge, createRecallSecretary } from "recall-secretary";

const judge = createJsonJudge(async prompt => {
  // 把 prompt 交给你的模型，返回模型生成的 JSON 字符串。
  return await callYourModel(prompt);
});

const secretary = createRecallSecretary({ memory, judge });
```

判官收到 `{ query, context, candidates, maxPick, explicit }`，返回：

```js
[
  { i: 0, relevant: true, why: "人类明确在追忆同一次夜班车经历" },
]
```

如果记忆和对话含私人内容，优先用本地判官。换云端前要把“候选正文会离开本机”写进产品说明，别把这一步藏起来。

## 每条规矩从哪个坑里长出来

1. **先搜再判。** 只按关键词放行，会把同名的人、相邻国家、同一项目里另一件事都塞进对话。搜索只负责找候选，判官才决定递不递。
2. **判官先说清双方话题。** 模型很容易把“都提到某个人”误当相关。提示词要求比较当前话题和记忆话题，只认同一件事。
3. **只作证据，不作处方。** 旧记录会过期，人也会改主意。证据块明确告诉 AI：不要拿旧记忆反驳人类当前说法，不要照旧记录替人作决定。
4. **事件词优先。** 宽泛搜索常一次带回十几条，真正重要的生活经历反而排在后面。事件候选先进入短名单，但仍要经过判官。
5. **多路结果交错合并。** 一个热词可能独占前十名。按每个查询的名次轮流取，能给其他具体词留位置。
6. **只递证据窗口。** 整篇旧记录既浪费上下文，也容易让 AI 被旁枝带跑。窗口从优先词第一次命中的位置展开；需要逐字引用时，再按 key 回原文。
7. **同一窗口不重复递。** 人类连续聊同一件事时，每轮重复贴人物卡或旧事，会像坏掉的复读机。只在 AI 真正收到一条后记为 seen。
8. **压缩后重置 seen。** 上下文压缩后，AI 已经看不到早先递过的证据；名单若不清，记忆会永久“递过但不可见”。
9. **低信息消息不召回。** “嗯”“收到”和工具报错没有召回价值，硬搜只会制造幻觉连接。
10. **判官失败要显式留痕。** 这份实现返回 `trace.status = failed`，不会假装“没有记忆”。产品可以据此记日志或降级。
11. **人名在入口闸之前认。** 「阿梨！」只有三个字，原来被当低信息跳过，人物卡一起丢了。
12. **同一个 key 两条路都带回来时，留人物卡那份。** 搜索先把人物卡当普通记忆放进候选，人物卡那份被当重复扔掉，结果带着「为什么」和直递标记的那份没了，普通那份又被判官判了无关——人类问「你记得阿梨吗」，一张卡都没递。
13. **像普通词的名字，问到这个人时照样直递。** 只靠判官，判官会把「你记得石头吗」判成不相关。
14. **人类在追忆时不能交白卷。** 「你还记得吗」后面一条都不给，AI 只能硬编或说不知道；给一条最接近的，并老实标明可能不是。
15. **时间只认人类自己说的。** 系统时间戳、记忆正文里的日期都不算。
16. **名单读坏了不当空。** 当空等于把这一窗递过的卡全部再递一遍，还没人知道；`createFileSeenStore` 读坏会直接抛错。
17. **人类定的对照表不过判官。** 人类转来一段聊天记录，里面是人类自己的网名，AI 当成了别人。对照表里早写着这个网名是谁，可它和别的记忆一起排队过判官，被判无关丢了。
18. **门槛够高就别再要求「领先第二名」。** 门槛 0.6 之外还要求领先 0.1，人类说「问问朋友们愿不愿意来做客」，两条相关的记忆分别是 0.64 和 0.56，差 0.08，一条都没递。拿一周的记录重放：去掉这道，递出从 108 次变成 130 次，多出来的大多是之前该递没递的。
19. **小房间要字面重合。** 一个只有十几条的教训房间，一周 1140 轮里占了 511 个候选位，真相关的只有 6 次；有一条来了 205 次，一次都不相关。
20. **超时放弃的那一轮什么都不记。** 宿主已经按「这轮没有记忆」往下走了，秘书还把结果记成递过，前端卡片和已递名单就都在说假话。
21. **英文名要整词。** 「evaluate」里有「eva」。中英混合的名字首尾按英文边界认，中间的空格认任意空白。
22. **旧记忆是泡过水的碎片。** 证据块开头写明：摘要不是原话，引用先核原文；跟人类此刻说的有出入，以此刻为准。存的时候不必给每条标「事实还是推测」，想起来的时候先打折扣。

## 返回值

```js
{
  text: "[记忆秘书] ...", // 没有选中时为空串
  items: [{ key, evidence, score, why, lane, unsure? }],   // lane: person | memory | glossary
  trace: {
    status: "selected",    // skipped | no_hit | rejected | failed | incomplete | selected
    glossary: [],          // 这轮附上的对照表词条
    terms: ["夜班车"],
    people: [],           // 这句认出的人
    timeWindow: null,     // { from, to, said, mode }
    candidates: 3,
    judged: 3,
    selected: 1,
    ms: 12
  }
}
```

`trace` 不放完整记忆正文，方便记录健康数据时少泄漏一层私人内容。

## 目录

```text
src/index.mjs         主流程与公开 API
src/policy.mjs        入口过滤、抽词、证据窗口、候选排序
src/json-memory.mjs   最小本地 JSON 记忆库
src/judges.mjs        离线判官和 JSON 模型判官适配器
src/health.mjs        不含正文的健康数据汇总
src/people.mjs        人物卡：别名、像普通词的名字、亲属称呼、卡片裁切
src/names.mjs         名字认法：英文整词、中英混合名的边界
src/glossary.mjs      名词对照表直附
src/timewindow.mjs    人类说的时间 → 只看那段时间的记忆
src/seen-store.mjs    已递名单落盘
examples/             可直接运行的虚构数据
test/                 Node 内置测试
NOTES.md              从现役系统拆分时的取舍和待修问题
```

## 安全边界

- JSON 示例全是虚构内容。
- 项目不包含端口、令牌、代理、模型钥匙和家庭路径。
- 默认不联网。是否调用外部判官由接入方决定。
- 记忆内容可能比聊天更敏感，日志里尽量只记 key、数量、耗时和状态。

## 0.2 改了什么

- 新增人物卡（`people`）、点名（`summonNames`）、追忆保底（`mustPushOnRecall`）、时间窗、已递名单落盘（`seenStore` / `createFileSeenStore`）。
- `reset()` 和 `seen()` 现在返回 Promise，要 `await`。
- 用人物卡时，记忆库要多一个 `get(key)`。

## 0.3 改了什么

- 新增名词对照表（`glossary` / `glossarySkip` / `maxGlossary` / `glossaryChars`）、打分判官（`createScoreJudge`）、小房间字面闸（`lexicalGate`）、超时（`recall(..., { signal })`）。
- 英文名、中英混合名改成整词认（`nameIn` / `nameRe`），人物卡也用这套。
- 证据块开头加了「泡过水的碎片」「以此刻为准」。
- `trace.status` 多了 `incomplete`。

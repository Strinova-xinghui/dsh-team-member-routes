# dsh-team-member-routes

让 Agent Teams 队友可单独指定 LLM 路由的 DSH 外挂插件。

官方 `spawn_teammate` 创建的队友一律继承 Lead 的 provider/model，且**队友自己的
对话框里没有模型选择器**、Lead 也无法改已存在队友的模型。本插件补齐三件事：

| # | 能力 | 落点 |
|---|------|------|
| ① | 新建队友时指定 `provider` / `model` / `reasoning_effort` | host 工具 `spawn_teammate_route` |
| ② | 改**已停机**队友的模型与思考档位（工作中禁止改） | host 工具 `set_teammate_model` |
| ③ | 队友对话框里出现官方模型选择器 + 思考档位选择器 | client 半插件 |

## 安装

插件目录即本仓库。以 `link:` 依赖挂进 profile（`$DSH_PROFILE_DIR` 默认
`~/.dsh/profiles/<profile>`）：

1. 编辑 `$DSH_PROFILE_DIR/package.json`：
   - `dependencies` 增加 `"dsh-team-member-routes": "link:<本仓库绝对路径>"`；
   - `dsh.profile.bundles` 在 `@deepseek-ai/dsh-experimental-agent-team-profile`
     **之后**追加 `"dsh-team-member-routes"`（保证 agent-team/subagent 服务先加载）。
2. 在 profile 目录执行 `pnpm install` 刷新 link。
3. 重启 DSH（新 bundle 首次挂载需重启；改代码后也要重启，`link:` 不热更新）。

## 使用

### ① 新建带路由的队友（Lead）

```
spawn_teammate_route({
  "name": "reviewer",
  "description": "代码审查",
  "prompt": "……",
  "provider": "xxx",
  "model": "yyy",
  "reasoning_effort": "high"        // 可选
})
```

路由用 `list_subagent_models` 查询。`context: "fork"` + 改路由会失去与 Lead 的
KV 前缀复用（官方语义）；不指定 `reasoning_effort` 时由目标模型解析自身默认。

### ②③ 改已有队友的模型 / 档位——两种方式，都不用你敲命令

**方式 A：直接在队友对话框里点。** 队友对话框现在有官方模型选择器，点开含
「模型」和「推理强度（思考档位）」两栏（复用官方 `ModelSelect` 自带的双 pane）。
选一次即发 `remote.session.selectModel`，被本插件宿主半接管并落地路由。

**方式 B：直接跟 Lead 用自然语言说。** 例如「把 reviewer 换成 xxx 的 yyy，档位 high」，
Lead 自己调 `set_teammate_model`——这个工具是给 Lead 用的，不是给人手敲的。两条路
走同一套宿主落地逻辑。

**工作中禁止改**：队友 `running` / `provisioning` 时两种方式都被拒——先 `interrupt_agent`
停下再改。这是有意的：一轮进行中的请求已带旧路由，中途切换会让同一轮跨两个模型。
idle / inactive 的队友可改：idle 的活队友走官方 `selectForNextRequest`
（`model/selection` 事件，下一次请求即换）；inactive 的写入持久表，下次唤醒（冷恢复）生效。

两种方式的最终结果都写入 `$DSH_HOME/team-member-routes.json`（默认 `~/.dsh/`），
因此跨重启保持。

## 原理

### 为什么官方原本不给队友显示选择器 / 不允许改模型

两处独立拦截（DSH 0.1.6-alpha.1，标记均已在运行版 `app.asar` 核实）：

1. **客户端**：模型选择器、`/model`、slash 命令、技能列表的可用性都押在同一个判据
   `sessions.subagentAddress(sessionId) === void 0` 上——被寻址的 subagent 会话一律
   不渲染（`dsh-client-ui-model-selection/lib/client.js` L926/L951，`ModelSelect`
   L493 `return null`）。
2. **宿主**：`selectModel` → `resolveAgent` → `hasApiSessionSubagentOwner`，会话
   `header.origin === "subagent"` 直接拒绝，报 `session/agent-busy`
   "owned by subagent routing"（`dsh-api-session-controller/lib/index.js` L125-131/L268/L606）。

还有第三层：`foldSubagentDescriptor` 只认**第一个** `subagent/descriptor` 事件，事后
追加 descriptor 只改显示、不改真实路由——所以持久 override 必须落在 materialization 处。

### 本插件的解法（只复用官方接缝，零自有路由逻辑）

- **① 新建路由**：pending 表登记 `(Lead id, description) → 路由`，再走原封不动的官方
  `agentTeams.spawnTeammate`；实例级包装 `subagents.startContinuable` 命中即注入
  `request.agentOptions`（即焚，FIFO）。之后 descriptor 持久化 / 冷恢复 / UI 显示全官方。
- **③ 客户端选择器**：不 shadow slot、不重写组件，只**精准翻转** `subagentAddress`——
  对 `mode === "continuable"` 的队友会话返回 `undefined`，官方 `ModelSelect`（本就含
  模型 + 档位双 pane）照常渲染；普通会话与 one-shot 子代理不受影响。
- **② 宿主落地**：包装 `sessionController.selectModel`，只接管官方那个 ownership 拒绝
  分支，改用 `selectForNextRequest`（idle 活队友）或持久表（inactive）；包装
  `agents.create` / `agents.resume` 在 materialize 时用持久表覆盖 `agentOptions`，
  因此不依赖 descriptor 也能跨重启保持。
- 预检用官方同款 `llm.resolveCallConfig`，且在写名册 / 写存储**之前**，非法路由不留残留。

> **已知的连带效果（有意为之）**：`subagentAddress` 一个判据同时压着三个入口，翻转后
> 模型+档位选择器、`/` 斜杠命令列表、技能列表会在队友输入框里**一起打开**（官方 `/model`
> 命令也走同一宿主落地路径）。安全边界不变：宿主对 subagent 会话的 `session.prompt`、
> 队列改动、取消仍然拒绝（`hasApiSessionSubagentOwner` 未改），队友会话只能经 Team 路由驱动。

> **验收只看硬证据**：`list_agents` 对 inactive 队友会回退显示 Lead 的模型（官方
> `TeamRoster.list()` 行为），且模型自述普遍不可靠。以会话日志的 `request/header` 与
> `assistant/message.source` 为准。

## 开发

```
node test/selftest.mjs
```

纯 `node` 运行，用 mock Cordis context + `vm` 沙箱，不需要 DSH 宿主；若本机能访问
`$DSH_PROFILE_DIR` 下的 `dsh-tools`，会额外用官方 raw-schema 校验器验证工具 schema。

## 回滚

从 `dsh.profile.bundles` 移除并重启即可。已创建的队友路由写在各自 session descriptor
里，不依赖本插件会继续按指定模型运行；`$DSH_HOME/team-member-routes.json` 里的持久
override 也只在插件在位时生效。官方 `spawn_teammate` 与 `subagent` 全程未被修改。

## 兼容性

按 DSH 0.1.6-alpha.1 源码实现（`dsh-subagent`、`dsh-experimental-agent-team`、
`dsh-experimental-tool-agent-team`、`dsh-client-ui-model-selection`、`dsh-tools` 的
raw schema 子集）。上游签名漂移时安全退化（feature-detect + 一次性 warn），不会崩会话。
工具 schema 走 dsh-tools 的 raw JSON Schema 子集：`type/oneOf/properties/required/
additionalProperties/items/enum/const` + 注解 `description/title/default/examples`。

## License

MIT

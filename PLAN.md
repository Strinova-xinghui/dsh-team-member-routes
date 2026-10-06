# dsh-team-member-routes：让 Agent Teams 队友可单独指定模型的插件实现计划

> 起草：2026-10-06 ｜ 状态：**已实施（0.1.0，2026-10-06）**，见文末「10. 实施记录」
> 事实依据均为本会话从 `app.asar` 解包核实的官方源码，行号以 DSH 0.1.6-alpha.1 为准。

## 1. 目标与成功标准

在**不改 app.asar、不 fork 官方包**的前提下，新增外挂插件 `dsh-team-member-routes`，使 Team Lead 能在创建队友时逐个指定 `provider` / `model` / `reasoning_effort`。

验收标准：

1. Lead 调用新工具 `spawn_teammate_route`（带路由参数）创建的队友，其 `list_agents` 行与团队面板成员行显示的 `model` 即为指定模型；
2. 普通 `spawn_teammate`（官方工具）行为完全不变；`subagent` 工具不受影响；
3. 非法路由（provider 不存在 / 模型不存在）在成员写入名册**之前**失败，roster 无残留；
4. DSH 重启后队友仍按各自模型运行（冷恢复正确）；
5. 非 Lead 调用新工具被拒；卸载插件后存量队友按 descriptor 路由继续运行（可回滚）。

## 2. 已验证的机制依据（实现的事实基础）

| # | 事实 | 出处（app.asar 内源码，均已核实） |
|---|------|------|
| 1 | `startContinuable` 支持 per-child 覆盖：`resolveChildAgentOptions(parent, request.agentOptions, childDepth)`，`agentOptions` 含 `provider/model/reasoningEffort` | `dsh-subagent/lib/index.js` L1671-1680、L436-452 |
| 2 | 两个 in-process provider 均声明 `capabilities.agentOptions: true`；driver 真正消费 agentOptions | `dsh-subagent-spawn-in-process` L23-24、`fork-in-process` L37-38、`in-process-driver` L186 |
| 3 | 官方缺口：`spawnAdmitted` 硬编码 `request:{prompt,parent}` 不透传 agentOptions；`spawn_teammate` schema 无模型参数 | `dsh-experimental-agent-team` L573-582、`dsh-experimental-tool-agent-team` L245-266 |
| 4 | 路由三件套自动持久化进 descriptor（agentProvider/agentModel/agentReasoningEffort），冷恢复按 descriptor 还原；roster 不存路由 | `dsh-subagent/lib/index.js` L1684-1693、L1922-1927、L449 |
| 5 | 换路由未带 effort → effort 被清空，由新模型解析默认 | `resolveChildAgentOptions` L450 |
| 6 | Lead 身份校验在 spawnTeammate 内部（TEAM_LEAD_REQUIRED）；官方工具对所有成员暴露同一 schema、执行时鉴权 | `dsh-experimental-agent-team` L546 |
| 7 | spawnAdmitted 传给 startContinuable 的 `label` = 队友 `description`，`request.parent` = Lead agent（id 即 root.id）——包装层按键匹配的依据 | L551、L573-582 |
| 8 | 路由预检范式：`llm.resolveModelInfo(provider, model, signal)` | `dsh-tool-subagent` L501-506、`dsh-subagent` L1983 |
| 9 | 插件安装范式：ESM 命名导出 `{name, inject, apply}` + `package.json` 的 `dsh.bundle.patch` 指向 cordis.patch.yml（insert 行） | `dsh-tool-subagent`、`dsh-better-sidebar` 实测样板 |

## 3. 架构

三个部件，全部在一个 host-scope 插件内：

```
spawn_teammate_route 工具                startContinuable 实例包装               官方 TeamService
┌─────────────────────────┐   登记路由   ┌──────────────────────────┐  注入   ┌──────────────┐
│ 预检 resolveModelInfo    │ ──────────▶ │ pending Map 命中则        │ ──────▶ │ spawnTeammate │
│ capability 校验          │             │ spec.request.agentOptions │         │ (官方路径不变) │
│ pending.set(key, route)  │             │ = route，用完即删          │         └──────────────┘
│ 转调 agentTeams.spawn…   │             └──────────────────────────┘
└─────────────────────────┘
```

- 工具先在 pending 表登记路由，再走**原封不动的官方** `agentTeams.spawnTeammate(caller, request)`（名册、maxMembers、日志、初始身份前缀全官方）；
- `spawnAdmitted` 内部调用 `ctx.subagents.startContinuable(spec)` 时被我们的实例方法包装截获，命中 pending 则向 `spec.request` 注入 `agentOptions`，随后即焚；
- 注入后的一切（descriptor 持久化、冷恢复、UI 显示、effort 默认语义）都是官方既有行为，插件零维护。

## 4. 文件清单

源码放 `<插件目录>/`（工作区，便于版本管理），以 `link:` 依赖挂入 profile：

```
<插件目录>/
  package.json          # type:module, main lib/index.js, dsh.bundle.patch
  dsh.plugin.json       # 插件管理器元数据（仿 dsh-better-sidebar）
  cordis.patch.yml      # - insert: [- id: team-member-routes, name: 'dsh-team-member-routes']
  lib/index.js          # 全部实现（单文件，无需构建链）
  README.md
```

`package.json` 要点：

```json
{
  "name": "dsh-team-member-routes",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "*" },
  "engines": { "node": ">=20" }
}
```

`dsh.plugin.json`（仿 dsh-better-sidebar）：

```json
{
  "id": "dsh-external/dsh-team-member-routes",
  "version": "0.1.0",
  "main": "./lib/index.js",
  "description": "Agent Teams 扩展：spawn_teammate_route 工具允许 Lead 创建队友时逐个指定 provider/model/reasoning_effort",
  "engines": { "dsh": ">=0.0.1" },
  "contributes": { "tools": [], "skills": [] }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: team-member-routes
      name: 'dsh-team-member-routes'
```

## 5. lib/index.js 实现规格

### 5.1 导出与注入

```js
export const name = "team-member-routes";
export const inject = ["agents", "subagents", "llm", "tools", "systemPrompt"];
export function apply(ctx, config) { … }
// Config: { freshProvider: "spawn", forkProvider: "fork" }（与官方 tool-agent-team 同款默认）
```

### 5.2 工具 `spawn_teammate_route`

注册进 host `ctx.tools`，全员可见、执行时鉴权。参数 schema：

- `name`（required，lower-kebab-case）、`description`（required）、`prompt`（required）、`context`（enum `fresh`/`fork`，默认 fresh）——与官方 `spawn_teammate` 完全一致；
- `provider`（required）、`model`（required）、`reasoning_effort`（可选 string）。

execute 流程：

1. `const membership = agentTeams.tryMembership(exec.agent)`；非 lead → 抛错（文案对齐官方 "only the Team Lead can create teammates"）；
2. **capability 校验**：`ctx.subagents.getProvider(lifecycleProvider)?.capabilities.agentOptions === true`，否则拒绝（codex/claude-code 等外部 provider 未证实支持，宁可拒绝）；
3. **路由预检**：`await ctx.get("llm").resolveModelInfo(provider, model, exec.signal)`，失败即抛（此时成员尚未入册，roster 干净）；
4. `lifecycleProvider = context === "fork" ? config.forkProvider : config.freshProvider`；
5. `pendingEnqueue(exec.agent.id, description, { provider, model, ...(reasoning_effort ? { reasoningEffort: reasoning_effort } : {}) })`；
6. `try { return await agentTeams.spawnTeammate(exec.agent, { name, description, context, provider: lifecycleProvider, signal: exec.signal, prompt: [IDENTITY_REMINDER(name), { type: "text", text: prompt }] }) } finally { pendingRemove(exec.agent.id, description) }`；
7. `IDENTITY_REMINDER` 逐字复制官方 system-reminder 前缀（tool-agent-team L276-284），保证与官方创建的队友身份布局一致：

```
<system-reminder>
You are teammate "{name}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

```

### 5.3 startContinuable 包装

```js
function wrapStartContinuable(subagents, pending) {
  if (typeof subagents?.startContinuable !== "function") return warn("startContinuable 不可用，路由退化为继承");
  if (subagents.__teamRouteWrapped) return;
  const orig = subagents.startContinuable.bind(subagents);
  const wrapped = (spec) => {
    try {
      const parentId = spec?.request?.parent?.id;
      if (parentId && typeof spec.label === "string" && spec.request.agentOptions === undefined) {
        const route = pendingTake(parentId, spec.label);   // FIFO 取出并移除
        if (route) spec.request = { ...spec.request, agentOptions: route };
      }
    } catch { /* 包装层绝不破坏透传 */ }
    return orig(spec);
  };
  wrapped.__teamRouteWrapped = true;
  subagents.startContinuable = wrapped;   // 实例级 shadow，规避模块双实例问题
}
```

细节与防御：

- **键** = `parentId + "\u0000" + label`；pending 值为 **FIFO 数组**（同一 (Lead, description) 并发 spawn 的病态场景按序消费）；
- **feature-detect**：`spec.request` 无 `parent` 字段（上游签名变化）→ 不注入原样透传 + 一次 warn 日志；包装失败不影响官方功能，只是路由退化为继承 Lead；
- **HMR/patchReload 防御**：`ctx.on("agent/created", () => wrapStartContinuable(ctx.get("subagents"), pending))`，服务实例被重建后自动重新包装（`__teamRouteWrapped` 标记防重复）；
- effort 语义无需处理：注入后 `resolveChildAgentOptions` 自动处理「换路由未带 effort → 用新模型默认」。

### 5.4 可选：system-prompt 提示段

仿 tool-subagent L576-580 的 presence-gate 写法注册一段简短说明（何时用带路由 spawn、fork 改路由丢 KV 前缀复用）；若实现繁琐可降级为把要点写进工具 description（**底线：description 必须含**）。

## 6. 安装步骤（desktop profile）

1. 在 `<插件目录>/` 写入上述文件；
2. 编辑 `~/.dsh/profiles/desktop\package.json`：
   - `dependencies` 增加 `"dsh-team-member-routes": "link:<插件目录>"`（仿既有 `dsh-basics-panel` 的 link 写法）；
   - `dsh.profile.bundles` 在 `@deepseek-ai/dsh-experimental-agent-team-profile` **之后**追加 `"dsh-team-member-routes"`（保证 agent-team/subagent 服务先加载）；
3. profile 目录执行 `pnpm install`（刷新 link）；
4. 重启 DSH（新 bundle 首次挂载需重启；`patchReload: live` 只覆盖 patch 行热改）；
5. 若同时要在 web profile 使用，对 `profiles\web` 重复 2-4。

## 7. 测试与验收清单

| # | 用例 | 预期 |
|---|------|------|
| 1 | 正向：Teams 会话中 Lead 用 `spawn_teammate_route` 创建队友（路由取本机已有 provider，如 `xiaomi/mimo-v2.6-flash`） | `list_agents` 该行 `model` 等于指定值；团队面板成员行一致；队友实际回复走目标模型（其会话头部可确认） |
| 2 | 负向·预检：指定不存在的 model | 工具报错；`list_agents` 无新增成员（roster 干净） |
| 3 | 负向·鉴权：队友调用该工具 | 报 Lead-required 错误 |
| 4 | 持久化：创建后重启 DSH、重开会话 | 队友冷恢复仍走指定模型 |
| 5 | 回归：官方 `spawn_teammate` 创建队友；`subagent` 一次性/后台委派 | 官方队友仍继承 Lead；subagent 不受包装影响（透传路径） |
| 6 | 混合队伍：先普通 spawn 一个、再带路由 spawn 一个 | 两成员各自模型正确；send_message / 任务板协作正常 |
| 7 | 回滚：从 bundles 移除并重启 | 插件消失；存量队友按 descriptor 路由照常运行 |

## 8. 边界与风险

- **fork + 改路由**：丢失与 Lead 的 KV 前缀复用（官方注释明示），长历史成本上升——工具 description/提示段说明；
- **外部 provider（codex/claude-code）**：`agentOptions` 能力未证实，capability 校验直接拒绝并提示改用 fresh；
- **reasoning_effort 兼容性**：字符串原样透传，语义由目标 adapter 解释（与 subagent 工具一致）；
- **上游升级漂移**：包装层 feature-detect + warn，最坏退化为现状（继承 Lead），不会崩会话；
- **并发同键 spawn**：FIFO 兜底；正常 Lead 一次 turn 内的 spawn 串行 await，无实际问题。

## 9. 可选后续（不在本次范围）

- 给上游提 PR：`tool-agent-team` schema 加 `provider/model/reasoning_effort` 三参 + `spawnAdmitted` 透传 `request.agentOptions`（约 5 行，`tool-subagent` 有同款实现可抄）——插件代码即 PR 素材；
- 与 `subagent-model-selection-settings`（allowedModels 白名单）联动，限制可选路由范围。

## 10. 实施记录（2026-10-06，0.1.0）

### 与计划的偏差（以实测源码为准）

1. **身份前缀更短**：本安装版官方 `spawn_teammate` 的 reminder 只有一行
   `You are teammate "..."`（tool-agent-team L275-281），不含 Lead 姓名与
   send_message 指引（那些由 team:policy 提示段承担）。已按安装版逐字复制。
2. **预检 API**：官方 `subagent` 工具预检实际用 `llm.resolveCallConfig({provider, model, reasoningEffort?}, signal)`
   （dsh-tool-subagent L117-128），不是裸 `resolveModelInfo`。已对齐。
3. **raw tool definition**：通过 pnpm `link:` 挂载的插件无法解析 `@deepseek-ai/*`
   bare import（Node 从插件真实路径解析，官方包不在其 node_modules 链上；参照
   graph-memory 插件的做法）。因此不使用 `defineTool`，直接注册满足 dsh-tools
   raw 子集的定义：`parameters` 为完整 JSON Schema（非 property-map DSL）、
   `output = { schema, render }`。schema 已用官方 `assertSupportedJsonSchema` /
   `validateJsonSchemaValue` 实测通过。
4. **注入点确认**：`ctx.get("subagents")` 拿到的是 SubagentRuntime 外层实例，
   `startContinuable` 是可写实例属性（外层方法委托 `requireContinuations()`），
   实例级 shadow 包装可行；`spawnAdmitted` 传参形状
   `{ childId, provider, label: description, request: { prompt, parent: root }, signal }`
   已核实（agent-team L573-582），键匹配 `parent.id + label` 成立。
5. `dsh.plugin.json` 未使用（当前 profile 插件均不带此文件，bundles+patch 即可）。

### 交付物

- `<插件目录>/`：package.json / cordis.patch.yml / lib/index.js / README.md
- profile `package.json` 已加 `link:<插件目录>` 依赖 +
  bundles 在 agent-team-profile 之后插入 `dsh-team-member-routes`；`pnpm install` 完成
- 离线自测 17 项全过（`test/selftest.mjs`，用官方 dsh-tools 校验器验证
  schema，用 mock ctx 验证鉴权/能力/预检/注入全链路）

### 验收结果（2026-10-06 重启后实测）

- [x] 重启 DSH → Teams 会话 Lead 调 `spawn_teammate_route` 创建队友 → `list_agents` 的 model 行 = 指定值
      （实测：`mimo-cutoff-probe`，provider=spawn / model=mimo-v2.6-flash）
- [x] 负向：错误 model → 报错且名册无新增
      （实测 `xiaomi/no-such-model-xyz` → `pi-ai provider "xiaomi" has no configured model ...`，
      随后 `list_agents` 无 `bad-route-probe` 残留）
- [x] 队友冷恢复仍走指定模型（inactive→resume 实测，见下）

### 实测证据（队友会话，id 略）

| 证据 | 内容 |
|---|---|
| `list_agents`（live 时） | `model: "mimo-v2.6-flash"`，Lead 为 `GLM-5.3-Flash` |
| `request/header` ×2 | 两轮请求均 `provider=xiaomi model=mimo-v2.6-flash`（第二轮即 inactive→冷恢复） |
| `assistant/message.source` | `provider="xiaomi" model="mimo-v2.6-flash"`，`replayState.response.api="openai-completions"`，`stopReason="toolUse"`，usage 真实计数（18951 in / 195 out） |
| 会话系统提示 | `powered by the mimo-v2.6-flash model`（**路由在会话创建时即生效**，非事后显示） |
| `subagent/descriptor` | `agentProvider:"xiaomi" agentModel:"mimo-v2.6-flash"` 已持久化 |

### 实测发现：官方 `list_agents` 对 inactive 队友回退显示 Lead 的模型

`TeamRoster.list()`（agent-team L449）取 `live?.options.model ?? root.options.model`：
队友从 Agent registry 移除后 `live === undefined`，该行**回退为 Lead 的模型**，
易被误读为"路由丢了"。队友真实路由存在 descriptor 中（冷恢复实测仍为 xiaomi/mimo）。
这是官方既有行为，非本插件缺陷。验收建议：在队友 running 时读 `list_agents`，
或以会话 `request/header` 为准；如需修，可另做增强（inactive 行回读 descriptor）。

### 模型自省不可作为路由证据

队友自报身份为 `deepseek-v2.6-flash`（错误），第二轮自我更正为
"系统提示写的是 mimo-v2.6-flash，我把上下文里的 DeepSeek Harness 品牌词误当成厂商"。
结论：模型自省身份普遍不可靠，路由验收必须用 `request/header` / descriptor 等硬证据。

## 11. 追加功能 v0.2（2026-10-06）：修复队友对话框无法改模型 + Lead 改已有队友模型

### 用户报告的根因（两处拦截，均已在运行版 app.asar 内以字符串标记核实）

| 层 | 拦截点 | 位置 |
|---|---|---|
| 客户端 | 模型选择器与 `/model` 命令的可用性判据 `sessions.subagentAddress(sessionId) === void 0`，被寻址的 subagent 会话直接不渲染选择器（`ModelSelect` L493 `if (!available) return null`） | dsh-client-ui-model-selection/lib/client.js L926 / L951 |
| 宿主 | `selectModel` → `resolveAgent` → `hasApiSessionSubagentOwner`：`header.origin === "subagent"` 一律拒绝，报 `session/agent-busy` "owned by subagent routing" | dsh-api-session-controller/lib/index.js L125-131、L268、L606 |

实测队友会话 `origin=subagent`、`delegationDepth=1`，两层同时命中，所以官方 UI 里队友对话框确实改不了模型。
另有第三层：`foldSubagentDescriptor` 取**第一个** descriptor（`events.find`），事后追加 descriptor 只影响显示、不影响真实路由。

### v0.2 实现（同插件，单文件）

新增工具 `set_teammate_model`（Lead 专属）+ 三处官方接缝复用：

1. **持久路由表** `~/.dsh/team-member-routes.json`（插件自有存储，不改 session 日志）；
2. **包装 `agents.create` / `agents.resume`**：materialize 时若命中存储路由，覆盖 `spec.agentOptions`
   ——create 路径服务新队友，resume 路径服务**冷恢复**，从而不依赖 descriptor 即可跨重启保持模型；
3. **活队友**：走官方 `sessionController.agents.selectForNextRequest(agent, selected)`
   （追加 durable `model/selection` 事件 + `installModelSelection` waterfall 覆盖下一次请求），
   并对齐 `agent.options`，让 `list_agents` / 团队面板显示真实模型；
4. **包装 `sessionController.selectModel`**：仅拦截官方的 subagent-ownership 拒绝，改用上述路径落地
   ——这样将来即使客户端侧放开了选择器，宿主侧也已经可用。

预检仍在最前（`llm.resolveCallConfig`），非法路由不写存储、不动名册。

### 验收

- 离线自测 22 项全过（`test/selftest.mjs`）：鉴权三种负向、非法模型预检、
  活队友实时改路由 + options 对齐、inactive 走 durable、selectModel patch 双分支、
  create/resume 包装注入、v0.1 spawn 链路回归、身份 reminder 逐字节一致。
- 待重启实测：`set_teammate_model` 改活队友 → 其下轮 `request/header` 为新路由；重启后冷恢复仍为新路由。

### v0.3 追加（2026-10-06）：队友对话框出现选择器 + Lead 改停机队友

用户明确的两条需求：
1. 队友对话框里要有**模型选择器和思考档位选择器**；
2. Lead 能在用户要求时改**已停机**队友的模型和档位（**工作中不该改**）。

实现分两半（同一包，host + client）：

- **客户端半 `lib/client.js`**（`window.__ModuleLoader__.load` plain bundle，
  `package.json` 补 `exports["./client"]` + `dsh.client`）：不改组件、不 shadow slot
  （避免 `shadows-shipped-ui` 的全局视觉回归），只**翻转** `sessions.subagentAddress`
  判据——对 `mode === "continuable"` 返回 `undefined`。官方 `ModelSelect`
  （本就自带模型 + 档位两栏）遂在队友对话框正常渲染。one-shot 子代理与普通会话不受影响
  （已实测这三个分支）。选择结果发 `remote.session.selectModel`，落回宿主半。
- **宿主半语义反转**：`set_teammate_model` 原先对 running 立即改，现改为
  **running / provisioning 一律拒绝**（"interrupt it with interrupt_agent first"），
  只有 idle / inactive 可改——对应用户"工作中当然不该改"。idle 的活队友走
  `selectForNextRequest`（durable `model/selection`），inactive 只写持久表、下次唤醒生效。
- 宿主 `sessionController` 改 `ctx.inject(["sessionController"], …)` 延迟拿，避免加载顺序问题。

验收方式（都**不用手敲命令**）：A. 直接在队友对话框点选择器改；B. 直接对 Lead 说
"把 reviewer 换成 xxx"，Lead 自己调 `set_teammate_model`。两条路走同一宿主落地逻辑。
自测 15 项全过（含 running 拒绝、idle/inactive 双路径、客户端 wrapper 三分支 + 幂等）。

> 千问（qwen）路由本会话仍不可选：可选路由只有 xiaomi / codearts / buddy /
> workbuddy / qoder / cline；要支持得先在 `cordis.patch.yml` 的 `llm-pi-ai` 加 qwen 渠道。

## 12. v0.3.1：持久存储路径修正 + 发布整理（2026-10-06）

1. **实测通过**：Lead 用 `set_teammate_model` 把 inactive 队友改到
   `nvidia / z-ai/glm-5.3-flash` + effort `high`；唤醒后该轮 `request/header` =
   `nvidia/z-ai/glm-5.3-flash effort=high`，`assistant/message.source` 同值、
   `api=openai-completions`、usage 无 cacheRead（换 provider 后缓存归零，旁证真实调用）。
   用户亦确认队友对话框 selector 显示了正确模型。（注意队友自述 RUN= 仍是旧模型——
   系统提示那句 powered-by 在创建时固化，验收只看 header/source。）
2. **缺陷与修复**：store 路径原写法 `process.env.DSH_HOME || join(process.env.HOME ||
   ".", ".dsh")` 在 Windows host 进程里（`DSH_HOME` 未设、`HOME` 未设）退化成**相对**
   `./.dsh`，文件落在 Host cwd 旁的 `profiles/desktop/.dsh/`。本次生效靠同进程内存
   Map，跨重启依赖文件位置稳定，必须修。新实现复刻官方 `resolveDshHome` 优先级
   （非空 `$DSH_HOME` → `homedir()/.dsh`，含 `~` 展开）+ 旧位置一次性迁移。
   link: 插件不能 bare-import 官方包（实测 ERR_MODULE_NOT_FOUND），故复刻而非引用。
3. **发布整理**：`test/selftest.mjs` 进仓库（纯 node + mock ctx + vm 沙箱，31 项全过）；
   client `apply` 返回 disposer 以便测试还原；`__tmr*` 标记更名 `__team*`；
   补 LICENSE(MIT) / .gitignore；文档脱去本机绝对路径与用户名；README 明确
   "subagentAddress 一个判据开三个入口（picker / 斜杠命令 / 技能列表）"的连带效果
   与"宿主 prompt/cancel 守卫未动"的安全边界。



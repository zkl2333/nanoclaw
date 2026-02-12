# Claude Agent SDK 深入解析

对 `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 的逆向分析，用于理解 `query()` 行为、为何 agent teams 子 agent 会被杀掉，以及修复方式。并参考了官方 SDK 文档。

## 架构

```
Agent Runner（我们的代码）
  └── query() → SDK (sdk.mjs)
        └── 生成 CLI 子进程 (cli.js)
              └── Claude API 调用、工具执行
              └── Task 工具 → 生成子 agent 子进程
```

SDK 以子进程形式启动 `cli.js`，带上 `--output-format stream-json --input-format stream-json --print --verbose`。通信通过 stdin/stdout 上的 JSON 行进行。

`query()` 返回一个继承 `AsyncGenerator<SDKMessage, void>` 的 `Query` 对象。内部逻辑：

- SDK 将 CLI 作为子进程启动，通过 stdin/stdout JSON 行通信
- SDK 的 `readMessages()` 从 CLI stdout 读取，加入内部流
- `readSdkMessages()` 异步生成器从该流 yield
- `[Symbol.asyncIterator]` 返回 `readSdkMessages()`
- 迭代器仅在 CLI 关闭 stdout 时返回 `done: true`

V1（`query()`）和 V2（`createSession`/`send`/`stream`）都使用完全相同的三层架构：

```
SDK (sdk.mjs)           CLI 进程 (cli.js)
--------------          --------------------
XX Transport  ------>   stdin 读取器 (bd1)
  (spawn cli.js)           |
$X Query      <------   stdout 写入器
  (JSON-lines)             |
                        EZ() 递归生成器
                           |
                        Anthropic Messages API
```

## 核心 Agent 循环 (EZ)

CLI 内的 agent 循环是一个**名为 `EZ()` 的递归异步生成器**，而不是 while 循环：

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

每次调用 = 一次对 Claude 的 API 调用（一「轮」）。

### 每轮流程：

1. **准备消息** — 裁剪上下文，必要时做压缩
2. **调用 Anthropic API**（通过 `mW1` 流式函数）
3. **从响应中提取 tool_use 块**
4. **分支：**
   - 若**没有 tool_use 块** → 停止（执行 stop hooks，返回）
   - 若**有 tool_use 块** → 执行工具，turnCount+1，递归

所有复杂逻辑——agent 循环、工具执行、后台任务、teammate 编排——都在 CLI 子进程内。`query()` 只是薄薄一层传输封装。

## query() 选项

官方文档中的完整 `Options` 类型：

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `abortController` | `AbortController` | `new AbortController()` | 取消操作用 |
| `additionalDirectories` | `string[]` | `[]` | Claude 可访问的额外目录 |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | 以代码定义子 agent（非 agent teams，无编排） |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | 使用 `permissionMode: 'bypassPermissions'` 时必填 |
| `allowedTools` | `string[]` | 全部工具 | 允许的工具名列表 |
| `betas` | `SdkBeta[]` | `[]` | 测试功能（如 1M 上下文的 `['context-1m-2025-08-07']`） |
| `canUseTool` | `CanUseTool` | `undefined` | 工具使用的自定义权限函数 |
| `continue` | `boolean` | `false` | 继续最近一次对话 |
| `cwd` | `string` | `process.cwd()` | 当前工作目录 |
| `disallowedTools` | `string[]` | `[]` | 禁止的工具名列表 |
| `enableFileCheckpointing` | `boolean` | `false` | 启用文件变更追踪以回退 |
| `env` | `Dict<string>` | `process.env` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自动检测 | JavaScript 运行时 |
| `fallbackModel` | `string` | `undefined` | 主模型失败时使用的模型 |
| `forkSession` | `boolean` | `false` | 恢复时 fork 为新 session ID 而非继续原会话 |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | 事件钩子 |
| `includePartialMessages` | `boolean` | `false` | 是否包含部分消息事件（流式） |
| `maxBudgetUsd` | `number` | `undefined` | 该次 query 的美元预算上限 |
| `maxThinkingTokens` | `number` | `undefined` | 思考过程 token 上限 |
| `maxTurns` | `number` | `undefined` | 对话轮数上限 |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP 服务配置 |
| `model` | `string` | 来自 CLI 默认 | 使用的 Claude 模型 |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 结构化输出格式 |
| `pathToClaudeCodeExecutable` | `string` | 使用内置 | Claude Code 可执行路径 |
| `permissionMode` | `PermissionMode` | `'default'` | 权限模式 |
| `plugins` | `SdkPluginConfig[]` | `[]` | 从本地路径加载自定义插件 |
| `resume` | `string` | `undefined` | 要恢复的 session ID |
| `resumeSessionAt` | `string` | `undefined` | 从指定消息 UUID 恢复会话 |
| `sandbox` | `SandboxSettings` | `undefined` | 沙箱行为配置 |
| `settingSources` | `SettingSource[]` | `[]`（无） | 要加载的磁盘设置来源。须含 `'project'` 才能加载 CLAUDE.md |
| `stderr` | `(data: string) => void` | `undefined` | stderr 输出回调 |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | 系统提示。用 preset 获取 Claude Code 的提示，可加 append |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | 工具配置 |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json（版本控制）
// 'local'   → .claude/settings.local.json（gitignore）
```

未指定时，SDK 不加载任何磁盘设置（默认隔离）。优先级：local > project > user。代码里传入的选项始终覆盖磁盘设置。

### AgentDefinition

以代码定义的子 agent（不是 agent teams，更简单，无跨 agent 协调）：

```typescript
type AgentDefinition = {
  description: string;  // 何时使用该 agent
  tools?: string[];     // 允许的工具（省略则继承全部）
  prompt: string;       // Agent 系统提示
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // 进程内
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// 为 Opus 4.6、Sonnet 4.5、Sonnet 4 启用 1M token 上下文
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage 类型

`query()` 可能 yield 16 种消息类型。官方文档只列出 7 种的简化联合，完整定义在 `sdk.d.ts`：

| Type | Subtype | 用途 |
|------|---------|------|
| `system` | `init` | 会话初始化，含 session_id、tools、model |
| `system` | `task_notification` | 后台 agent 完成/失败/停止 |
| `system` | `compact_boundary` | 对话被压缩 |
| `system` | `status` | 状态变化（如压缩中） |
| `system` | `hook_started` | 钩子开始执行 |
| `system` | `hook_progress` | 钩子进度输出 |
| `system` | `hook_response` | 钩子完成 |
| `system` | `files_persisted` | 文件已保存 |
| `assistant` | — | Claude 回复（文本 + 工具调用） |
| `user` | — | 用户消息（内部） |
| `user`（重放） | — | 恢复时重放的用户消息 |
| `result` | `success` / `error_*` | 一轮 prompt 处理的最终结果 |
| `stream_event` | — | 部分流式（当 includePartialMessages 时） |
| `tool_progress` | — | 长耗时工具进度 |
| `auth_status` | — | 认证状态变化 |
| `tool_use_summary` | — | 前述工具调用的摘要 |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

两种变体，共享字段：

```typescript
// 两种变体共享字段：
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 成功：
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...共享字段
};

// 错误：
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...共享字段
};
```

result 上有用字段：`total_cost_usd`、`duration_ms`、`num_turns`、`modelUsage`（按模型拆分的 `costUSD`、`inputTokens`、`outputTokens`、`contextWindow`）。

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // 来自 Anthropic SDK
  parent_tool_use_id: string | null; // 来自子 agent 时非 null
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## 轮次行为：Agent 何时停止 vs 继续

### Agent 停止时（不再发起 API 调用）

**1. 响应中无 tool_use 块（主要情况）**

Claude 只返回了文本——认为任务已完成。API 的 `stop_reason` 为 `"end_turn"`。是否停止完全由模型输出决定，SDK 不参与。

**2. 超过 max turns** — 产生 `SDKResultError`，`subtype: "error_max_turns"`。

**3. Abort 信号** — 通过 `abortController` 用户中断。

**4. 超出预算** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`。

**5. Stop 钩子阻止继续** — 钩子返回 `{preventContinuation: true}`。

### Agent 继续时（再发一次 API 调用）

**1. 响应包含 tool_use 块（主要情况）** — 执行工具，turnCount+1，递归进 EZ。

**2. max_output_tokens 恢复** — 最多 3 次重试，带「把工作拆成小块」的上下文消息。

**3. Stop 钩子阻塞错误** — 错误作为上下文消息反馈，循环继续。

**4. 模型回退** — 用回退模型重试一次。

### 决策表

| 条件 | 动作 | 结果类型 |
|------|------|----------|
| 响应有 `tool_use` 块 | 执行工具，递归进 `EZ` | continues |
| 响应无 `tool_use` 块 | 执行 stop hooks，返回 | `success` |
| `turnCount > maxTurns` | Yield max_turns_reached | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | Yield 预算错误 | `error_max_budget_usd` |
| `abortController.signal.aborted` | Yield 中断消息 | 视上下文而定 |
| `stop_reason === "max_tokens"`（输出） | 最多 3 次恢复提示重试 | continues |
| Stop 钩子 `preventContinuation` | 立即返回 | `success` |
| Stop 钩子阻塞错误 | 把错误反馈回去，递归 | continues |
| 模型回退错误 | 用回退模型重试一次 | continues |

## 子 Agent 执行模式

### 情况 1：同步子 Agent（`run_in_background: false`）— 阻塞

父 agent 调用 Task 工具 → `VR()` 为子 agent 运行 `EZ()` → 父等待完整结果 → 工具结果返回父 → 父继续。

子 agent 跑完整个递归 EZ 循环。父的工具执行通过 `await` 挂起。存在执行中的「晋升」机制：同步子 agent 可通过与 `backgroundSignal` promise 的 `Promise.race()` 晋升为后台。

### 情况 2：后台任务（`run_in_background: true`）— 不等待

- **Bash 工具**：命令被 spawn，工具立即返回空结果 + `backgroundTaskId`
- **Task/Agent 工具**：子 agent 在 fire-and-forget 包装（`g01()`）中启动，工具立即返回 `status: "async_launched"` + `outputFile` 路径

在发出 `type: "result"` 消息之前，没有「等待后台任务」的逻辑。后台任务完成时，会单独发出 `SDKTaskNotificationMessage`。

### 情况 3：Agent Teams（TeammateTool / SendMessage）— 先 result，再轮询

团队领导跑正常的 EZ 循环，包括启动 teammates。领导 EZ 循环结束时发出 `type: "result"`。然后领导进入 result 后的轮询循环：

```javascript
while (true) {
    // 若无活跃 teammates 且无运行中任务 → break
    // 若有来自 teammates 的未读消息 → 作为新 prompt 重新注入，重启 EZ 循环
    // 若 stdin 关闭且仍有活跃 teammates → 注入关闭提示
    // 每 500ms 轮询一次
}
```

从 SDK 使用者角度：你会先收到最初的 `type: "result"`，但 AsyncGenerator 可能继续 yield 更多消息，因为领导在处理 teammate 回复并重新进入 agent 循环。只有当所有 teammates 都关闭后，生成器才真正结束。

## isSingleUserTurn 问题

来自 sdk.mjs：

```javascript
QK = typeof X === "string"  // isSingleUserTurn 在 prompt 为字符串时为 true
```

当 `isSingleUserTurn` 为 true 且第一条 `result` 消息到达时：

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // 关闭 CLI 的 stdin
}
```

这会引发连锁反应：

1. SDK 关闭 CLI stdin
2. CLI 检测到 stdin 关闭
3. 轮询循环看到 `D = true`（stdin 已关闭）且仍有活跃 teammates
4. 注入关闭提示 → 领导向所有 teammates 发 `shutdown_request`
5. **Teammates 在研究中途被终止**

关闭提示（在压缩版 cli.js 中通过变量 `BGq` 找到）：

```
You are running in non-interactive mode and cannot return a response
to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user
```

### 实际问题

在 V1 `query()` + 字符串 prompt + agent teams 时：

1. 领导启动 teammates，他们开始调研
2. 领导的 EZ 循环结束（「我已派团队在处理」）
3. 发出 `type: "result"`
4. SDK 发现 `isSingleUserTurn = true` → 立即关闭 stdin
5. 轮询循环检测到 stdin 关闭 + 活跃 teammates → 注入关闭提示
6. 领导向所有 teammates 发 `shutdown_request`
7. **Teammates 可能才跑了 10 秒的 5 分钟调研任务就被要求停止**

## 修复：流式输入模式

不要传字符串 prompt（会设 `isSingleUserTurn = true`），改为传 `AsyncIterable<SDKUserMessage>`：

```typescript
// 之前（对 agent teams 会坏）：
query({ prompt: "do something" })

// 之后（保持 CLI 存活）：
query({ prompt: asyncIterableOfMessages })
```

当 prompt 是 `AsyncIterable` 时：
- `isSingleUserTurn = false`
- SDK 不会在第一个 result 后关闭 stdin
- CLI 保持存活，继续处理
- 后台 agent 继续运行
- `task_notification` 消息通过迭代器流动
- 由我们决定何时结束迭代器

### 额外好处：流式新消息

用异步可迭代方式，我们可以在 agent 仍在工作时把新到的 WhatsApp 消息推入迭代器。不必等容器退出再起新容器排队处理，而是直接注入到当前会话。

### 与 Agent Teams 的预期生命周期

使用异步可迭代修复（`isSingleUserTurn = false`）后，stdin 保持打开，CLI 不会触发 teammate 检查或关闭提示注入：

```
1. system/init          → 会话已初始化
2. assistant/user       → Claude 推理、工具调用、工具结果
3. ...                  → 更多 assistant/user 轮（启动子 agent 等）
4. result #1            → 主 agent 的首次回复（需捕获）
5. task_notification(s) → 后台 agent 完成/失败/停止
6. assistant/user       → 主 agent 继续（处理子 agent 结果）
7. result #2            → 主 agent 的后续回复（需捕获）
8. [iterator done]     → CLI 关闭 stdout，全部结束
```

每个 result 都有意义——每一个都要捕获，不只是第一个。

## V1 vs V2 API

### V1：`query()` — 一次性异步生成器

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* 处理事件 */ }
```

- 当 `prompt` 为字符串：`isSingleUserTurn = true` → 第一个 result 后自动关 stdin
- 多轮：必须传 `AsyncIterable<SDKUserMessage>` 并自行协调

### V2：`createSession()` + `send()` / `stream()` — 持久会话

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("first message");
for await (const msg of session.stream()) { /* 事件 */ }
await session.send("follow-up");
for await (const msg of session.stream()) { /* 事件 */ }
```

- `isSingleUserTurn = false` 恒为真 → stdin 保持打开
- `send()` 写入异步队列（`QX`）
- `stream()` 从同一消息生成器 yield，在 `result` 类型时停止
- 多轮很自然——交替 `send()` / `stream()` 即可
- V2 内部不调用 V1 `query()`，两者各自创建 Transport + Query

### 对比表

| 方面 | V1 | V2 |
|------|----|----|
| `isSingleUserTurn` | 字符串 prompt 时为 `true` | 恒为 `false` |
| 多轮 | 需自己管理 `AsyncIterable` | 直接 `send()`/`stream()` |
| stdin 生命周期 | 第一个 result 后自动关 | 直到 `close()` 才关 |
| Agent 循环 | 相同的 `EZ()` | 相同的 `EZ()` |
| 停止条件 | 相同 | 相同 |
| 会话持久化 | 新 `query()` 须传 `resume` | 通过 session 对象内置 |
| API 稳定性 | 稳定 | 不稳定预览（`unstable_v2_*` 前缀） |

**结论：轮次行为无差异。** 两者用同一 CLI 进程、同一 `EZ()` 递归生成器、同一决策逻辑。

## Hook 事件

```typescript
type HookEvent =
  | 'PreToolUse'         // 工具执行前
  | 'PostToolUse'        // 工具执行成功后
  | 'PostToolUseFailure' // 工具执行失败后
  | 'Notification'       // 通知消息
  | 'UserPromptSubmit'   // 用户提交 prompt
  | 'SessionStart'       // 会话开始（启动/恢复/清空/压缩）
  | 'SessionEnd'         // 会话结束
  | 'Stop'               // Agent 停止
  | 'SubagentStart'      // 子 agent 已启动
  | 'SubagentStop'       // 子 agent 已停止
  | 'PreCompact'         // 对话压缩前
  | 'PermissionRequest'; // 权限请求中
```

### Hook 配置

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // 可选工具名匹配
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### Hook 返回值

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### 子 Agent Hook（来自 sdk.d.ts）

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query 接口方法

`Query` 对象 (sdk.d.ts:931)。官方文档列出的公开方法：

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 停止当前执行（仅流式输入模式）
  rewindFiles(userMessageUuid: string): Promise<void>; // 将文件恢复到某消息时的状态（需 enableFileCheckpointing）
  setPermissionMode(mode: PermissionMode): Promise<void>; // 改权限（仅流式输入模式）
  setModel(model?: string): Promise<void>;        // 改模型（仅流式输入模式）
  setMaxThinkingTokens(max: number | null): Promise<void>; // 改思考 token（仅流式输入模式）
  supportedCommands(): Promise<SlashCommand[]>;   // 可用斜杠命令
  supportedModels(): Promise<ModelInfo[]>;         // 可用模型
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP 服务连接状态
  accountInfo(): Promise<AccountInfo>;             // 认证用户信息
}
```

在 sdk.d.ts 中有但官方文档未列（可能为内部）：
- `streamInput(stream)` — 流式追加用户消息
- `close()` — 强制结束 query
- `setMcpServers(servers)` — 动态增删 MCP 服务

## Sandbox 配置

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

当 `allowUnsandboxedCommands` 为 true 时，模型可在 Bash 工具输入里设 `dangerouslyDisableSandbox: true`，会回退到 `canUseTool` 权限处理。

## MCP 服务辅助

### tool()

用 Zod schema 创建类型安全的 MCP 工具定义：

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

创建进程内 MCP 服务（我们为子 agent 继承使用 stdio）：

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 内部参考

### 关键压缩标识符 (sdk.mjs)

| 压缩名 | 用途 |
|--------|------|
| `s_` | V1 `query()` 导出 |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session 类（`send`/`stream`/`close`） |
| `XX` | ProcessTransport（spawn cli.js） |
| `$X` | Query 类（JSON 行路由、async iterable） |
| `QX` | AsyncQueue（输入流缓冲） |

### 关键压缩标识符 (cli.js)

| 压缩名 | 用途 |
|--------|------|
| `EZ` | 核心递归 agent 循环（异步生成器） |
| `_t4` | Stop hook 处理（无 tool_use 块时运行） |
| `PU1` | 流式工具执行器（API 响应期间并行） |
| `TP6` | 标准工具执行器（API 响应之后） |
| `GU1` | 单工具执行器 |
| `lTq` | SDK 会话运行器（直接调 EZ） |
| `bd1` | stdin 读取器（来自 transport 的 JSON 行） |
| `mW1` | Anthropic API 流式调用 |

## 关键文件

- `sdk.d.ts` — 所有类型定义（1777 行）
- `sdk-tools.d.ts` — 工具输入 schema
- `sdk.mjs` — SDK 运行时（压缩，376KB）
- `cli.js` — CLI 可执行文件（压缩，作为子进程运行）

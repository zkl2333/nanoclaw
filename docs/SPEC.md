# NanoClaw 规格说明

通过 WhatsApp 可用的个人 Claude 助手，具备按会话的持久记忆、定时任务与邮件集成。

---

## 目录

1. [架构](#架构)
2. [目录结构](#目录结构)
3. [配置](#配置)
4. [记忆系统](#记忆系统)
5. [会话管理](#会话管理)
6. [消息流](#消息流)
7. [命令](#命令)
8. [定时任务](#定时任务)
9. [MCP 服务](#mcp-服务)
10. [部署](#部署)
11. [安全考量](#安全考量)

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        宿主机 (macOS)                                 │
│                   （主 Node.js 进程）                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  WhatsApp    │────────────────────▶│   SQLite 数据库     │        │
│  │  (baileys)   │◀────────────────────│   (messages.db)     │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  消息循环         │    │  调度循环         │    │  IPC 监视器   │  │
│  │  (轮询 SQLite)    │    │  (检查任务)       │    │  (基于文件)   │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ 启动容器                                       │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                  APPLE CONTAINER (Linux 虚拟机)                      │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                                │   │
│  │                                                                │   │
│  │  工作目录: /workspace/group（从宿主机挂载）                     │   │
│  │  卷挂载:                                                       │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/（仅非主群组）          │   │
│  │    • data/sessions/{group}/.claude/ → /home/node/.claude/      │   │
│  │    • 额外目录 → /workspace/extra/*                             │   │
│  │                                                                │   │
│  │  工具（所有群组）:                                              │   │
│  │    • Bash（安全 - 在容器内沙箱执行）                            │   │
│  │    • Read, Write, Edit, Glob, Grep（文件操作）                  │   │
│  │    • WebSearch, WebFetch（网络访问）                           │   │
│  │    • agent-browser（浏览器自动化）                              │   │
│  │    • mcp__nanoclaw__*（通过 IPC 的调度工具）                    │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 组件 | 技术 | 用途 |
|------|------|------|
| WhatsApp 连接 | Node.js (@whiskeysockets/baileys) | 连接 WhatsApp，收发消息 |
| 消息存储 | SQLite (better-sqlite3) | 存消息供轮询 |
| 容器运行时 | Apple Container | Agent 执行的隔离 Linux 虚拟机 |
| Agent | @anthropic-ai/claude-agent-sdk (0.2.29) | 运行带工具和 MCP 的 Claude |
| 浏览器自动化 | agent-browser + Chromium | 网页交互与截图 |
| 运行时 | Node.js 20+ | 路由与调度的宿主机进程 |

---

## 目录结构

```
nanoclaw/
├── CLAUDE.md                      # 给 Claude Code 的项目上下文
├── docs/
│   ├── SPEC.md                    # 本规格文档
│   ├── REQUIREMENTS.md            # 架构决策
│   └── SECURITY.md                # 安全模型
├── README.md                      # 用户文档
├── package.json                   # Node.js 依赖
├── tsconfig.json                  # TypeScript 配置
├── .mcp.json                      # MCP 服务配置（参考）
├── .gitignore
│
├── src/
│   ├── index.ts                   # 编排：状态、消息循环、agent 调用
│   ├── channels/
│   │   └── whatsapp.ts            # WhatsApp 连接、认证、收发
│   ├── ipc.ts                     # IPC 监视与任务处理
│   ├── router.ts                  # 消息格式化与出站路由
│   ├── config.ts                  # 配置常量
│   ├── types.ts                   # TypeScript 接口（含 Channel）
│   ├── logger.ts                  # Pino 日志配置
│   ├── db.ts                      # SQLite 初始化与查询
│   ├── group-queue.ts             # 按群组队列与全局并发限制
│   ├── mount-security.ts         # 容器挂载白名单校验
│   ├── whatsapp-auth.ts           # 独立 WhatsApp 认证
│   ├── task-scheduler.ts          # 到期时执行定时任务
│   └── container-runner.ts        # 在 Apple Container 中启动 agent
│
├── container/
│   ├── Dockerfile                 # 容器镜像（以 node 用户运行，含 Claude Code CLI）
│   ├── build.sh                   # 容器镜像构建脚本
│   ├── agent-runner/              # 容器内运行代码
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # 入口（query 循环、IPC 轮询、会话恢复）
│   │       └── ipc-mcp-stdio.ts   # 与宿主机通信的 Stdio MCP 服务
│   └── skills/
│       └── agent-browser.md       # 浏览器自动化技能
│
├── dist/                          # 编译后的 JavaScript（gitignore）
│
├── .claude/
│   └── skills/
│       ├── setup/SKILL.md              # /setup - 首次安装
│       ├── customize/SKILL.md          # /customize - 添加能力
│       ├── debug/SKILL.md              # /debug - 容器调试
│       ├── add-telegram/SKILL.md       # /add-telegram - Telegram 渠道
│       ├── add-gmail/SKILL.md          # /add-gmail - Gmail 集成
│       ├── add-voice-transcription/    # /add-voice-transcription - Whisper
│       ├── x-integration/SKILL.md      # /x-integration - X/Twitter
│       ├── convert-to-docker/SKILL.md  # /convert-to-docker - Docker 运行时
│       └── add-parallel/SKILL.md       # /add-parallel - 并行 agent
│
├── groups/
│   ├── CLAUDE.md                  # 全局记忆（所有群组可读）
│   ├── main/                      # 自聊（主控制渠道）
│   │   ├── CLAUDE.md              # 主渠道记忆
│   │   └── logs/                  # 任务执行日志
│   └── {群组名}/                  # 按群组文件夹（注册时创建）
│       ├── CLAUDE.md              # 该群组记忆
│       ├── logs/                  # 该群组任务日志
│       └── *.md                   # Agent 创建的文件
│
├── store/                         # 本地数据（gitignore）
│   ├── auth/                      # WhatsApp 认证状态
│   └── messages.db                # SQLite（messages, chats, scheduled_tasks, task_run_logs, registered_groups, sessions, router_state）
│
├── data/                          # 应用状态（gitignore）
│   ├── sessions/                  # 按群组会话（.claude/ 与 JSONL 转录）
│   ├── env/env                    # 供容器挂载的 .env 副本
│   └── ipc/                       # 容器 IPC（messages/, tasks/）
│
├── logs/                          # 运行时日志（gitignore）
│   ├── nanoclaw.log               # 宿主机 stdout
│   └── nanoclaw.error.log         # 宿主机 stderr
│   # 注：单容器日志在 groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.nanoclaw.plist         # macOS 服务配置
```

---

## 配置

配置常量在 `src/config.ts`：

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// 路径为绝对路径（容器挂载需要）
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// 容器配置
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10); // 默认 30 分钟
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30 分钟 — 上次 result 后保持容器存活
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**说明**：路径必须为绝对路径，Apple Container 卷挂载才能正确工作。

### 容器配置

群组可通过 SQLite `registered_groups` 表中的 `containerConfig`（存于 `container_config` 列 JSON）挂载额外目录。注册示例：

```typescript
registerGroup("1234567890@g.us", {
  name: "Dev Team",
  folder: "dev-team",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      {
        hostPath: "~/projects/webapp",
        containerPath: "webapp",
        readonly: false,
      },
    ],
    timeout: 600000,
  },
});
```

额外挂载在容器内出现在 `/workspace/extra/{containerPath}`。

**Apple Container 挂载语法**：读写用 `-v host:container`，只读需 `--mount "type=bind,source=...,target=...,readonly"`（`:ro` 后缀无效）。

### Claude 认证

在项目根目录的 `.env` 中配置认证。两种方式：

**方式 1：Claude 订阅（OAuth token）**
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```
若已登录 Claude Code，可从 `~/.claude/.credentials.json` 提取 token。

**方式 2：按量 API Key**
```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

仅认证相关变量（`CLAUDE_CODE_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY`）会从 `.env` 提取并写入 `data/env/env`，再挂载到容器的 `/workspace/env-dir/env`，由入口脚本 source。这样 `.env` 中其它变量不会暴露给 agent。因 Apple Container 在使用 `-i`（带管道 stdin 的交互模式）时会丢失 `-e` 环境变量，故需要此做法。

### 修改助手名称

设置环境变量 `ASSISTANT_NAME`：

```bash
ASSISTANT_NAME=Bot npm start
```

或修改 `src/config.ts` 中的默认值。会改变：
- 触发模式（消息须以 `@你的名字` 开头）
- 回复前缀（自动加 `你的名字:`）

### launchd 中的占位符

含 `{{PLACEHOLDER}}` 的文件需配置：
- `{{PROJECT_ROOT}}` - nanoclaw 安装的绝对路径
- `{{NODE_PATH}}` - node 路径（通过 `which node` 检测）
- `{{HOME}}` - 用户主目录

---

## 记忆系统

NanoClaw 使用基于 CLAUDE.md 的层级记忆。

### 记忆层级

| 层级 | 位置 | 谁可读 | 谁可写 | 用途 |
|------|------|--------|--------|------|
| **全局** | `groups/CLAUDE.md` | 所有群组 | 仅主频道 | 偏好、事实、所有对话共享的上下文 |
| **群组** | `groups/{name}/CLAUDE.md` | 该群组 | 该群组 | 群组上下文、对话记忆 |
| **文件** | `groups/{name}/*.md` | 该群组 | 该群组 | 对话中创建的笔记、调研、文档 |

### 记忆如何工作

1. **Agent 上下文加载**
   - Agent 在 `cwd` 为 `groups/{group-name}/` 下运行
   - Claude Agent SDK 使用 `settingSources: ['project']` 自动加载：
     - `../CLAUDE.md`（父目录 = 全局记忆）
     - `./CLAUDE.md`（当前目录 = 群组记忆）

2. **写记忆**
   - 用户说「记住这个」时，agent 写入 `./CLAUDE.md`
   - 用户说「全局记住这个」（仅主频道）时，agent 写入 `../CLAUDE.md`
   - Agent 可在群组文件夹创建 `notes.md`、`research.md` 等

3. **主频道权限**
   - 仅「主」群组（自聊）可写全局记忆
   - 主频道可管理已注册群组、为任意群组安排任务
   - 主频道可为任意群组配置额外目录挂载
   - 所有群组都有 Bash 访问（在容器内执行故安全）

---

## 会话管理

会话保证对话连贯——Claude 能记住之前聊过的内容。

### 会话如何工作

1. 每个群组在 SQLite（`sessions` 表，以 `group_folder` 为键）中存有 session ID
2. Session ID 传给 Claude Agent SDK 的 `resume` 选项
3. Claude 在完整上下文中继续对话
4. 会话转录以 JSONL 存在 `data/sessions/{group}/.claude/`

---

## 消息流

### 入站消息流

```
1. 用户发送 WhatsApp 消息
   │
   ▼
2. Baileys 通过 WhatsApp Web 协议接收
   │
   ▼
3. 消息写入 SQLite (store/messages.db)
   │
   ▼
4. 消息循环轮询 SQLite（每 2 秒）
   │
   ▼
5. 路由器检查：
   ├── chat_jid 是否在已注册群组（SQLite）？→ 否：忽略
   └── 消息是否匹配触发模式？→ 否：只存不处理
   │
   ▼
6. 路由器追赶对话：
   ├── 拉取自上次 agent 交互以来的全部消息
   ├── 带时间戳和发送者名格式化
   └── 用完整对话上下文组 prompt
   │
   ▼
7. 路由器调用 Claude Agent SDK：
   ├── cwd: groups/{group-name}/
   ├── prompt: 对话历史 + 当前消息
   ├── resume: session_id（保持连贯）
   └── mcpServers: nanoclaw（调度）
   │
   ▼
8. Claude 处理消息：
   ├── 读 CLAUDE.md 获取上下文
   └── 按需使用工具（搜索、邮件等）
   │
   ▼
9. 路由器给回复加助手名前缀并通过 WhatsApp 发送
   │
   ▼
10. 路由器更新 last agent 时间戳并保存 session ID
```

### 触发词匹配

消息必须以触发模式开头（默认 `@Andy`）：
- `@Andy 今天天气怎么样？` → ✅ 触发 Claude
- `@andy 帮个忙` → ✅ 触发（大小写不敏感）
- `嘿 @Andy` → ❌ 忽略（触发不在开头）
- `在吗？` → ❌ 忽略（无触发）

### 对话追赶

当带触发的消息到达时，agent 会收到该聊天中自上次交互以来的所有消息。每条带时间戳和发送者名：

```
[1月31日 14:32] 小明: 大家晚上吃披萨怎么样？
[1月31日 14:33] 小红: 好啊
[1月31日 14:35] 小明: @Andy 推荐什么配料？
```

这样 agent 能理解对话上下文，即使不是每条消息都 @ 它。

---

## 命令

### 任意群组可用

| 命令 | 示例 | 效果 |
|------|------|------|
| `@助手 [消息]` | `@Andy 今天天气怎么样？` | 与 Claude 对话 |

### 仅主频道可用

| 命令 | 示例 | 效果 |
|------|------|------|
| `@助手 add group "名称"` | `@Andy add group "家庭群"` | 注册新群组 |
| `@助手 remove group "名称"` | `@Andy remove group "工作群"` | 取消注册群组 |
| `@助手 list groups` | `@Andy list groups` | 列出已注册群组 |
| `@助手 remember [事实]` | `@Andy remember 我喜欢深色模式` | 写入全局记忆 |

---

## 定时任务

NanoClaw 内置调度器，在对应群组上下文中以完整 agent 运行任务。

### 调度如何工作

1. **群组上下文**：在某群组创建的任务在该群组的工作目录和记忆下运行
2. **完整 Agent 能力**：定时任务可使用所有工具（WebSearch、文件操作等）
3. **可选发消息**：任务可用 `send_message` 工具向该群组发消息，或静默完成
4. **主频道权限**：主频道可为任意群组安排任务并查看所有任务

### 调度类型

| 类型 | 值格式 | 示例 |
|------|--------|------|
| `cron` | Cron 表达式 | `0 9 * * 1`（每周一 9:00） |
| `interval` | 毫秒 | `3600000`（每小时） |
| `once` | ISO 时间戳 | `2024-12-25T09:00:00Z` |

### 创建任务

```
用户：@Andy 每周一早上 9 点提醒我看周报

Claude：[调用 mcp__nanoclaw__schedule_task]
        {
          "prompt": "发一条提醒看周报，语气鼓励一点。",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1"
        }

Claude：好的，每周一 9 点会提醒你。
```

### 一次性任务

```
用户：@Andy 今天下午 5 点给我发今天邮件的摘要

Claude：[调用 mcp__nanoclaw__schedule_task]
        {
          "prompt": "查今天的邮件，总结重要的，把摘要发到这个群。",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z"
        }
```

### 管理任务

在任意群组：
- `@Andy list my scheduled tasks` - 看本群组的任务
- `@Andy pause task [id]` - 暂停任务
- `@Andy resume task [id]` - 恢复已暂停任务
- `@Andy cancel task [id]` - 删除任务

在主频道：
- `@Andy list all tasks` - 看所有群组的任务
- `@Andy schedule task for "家庭群": [prompt]` - 为其他群组安排任务

---

## MCP 服务

### NanoClaw MCP（内置）

`nanoclaw` MCP 服务在每次 agent 调用时按当前群组上下文动态创建。

**可用工具：**
| 工具 | 用途 |
|------|------|
| `schedule_task` | 安排重复或一次性任务 |
| `list_tasks` | 列出任务（本群组或主频道看全部） |
| `get_task` | 获取任务详情与运行历史 |
| `update_task` | 修改任务 prompt 或调度 |
| `pause_task` | 暂停任务 |
| `resume_task` | 恢复已暂停任务 |
| `cancel_task` | 删除任务 |
| `send_message` | 向该群组发 WhatsApp 消息 |

---

## 部署

NanoClaw 以单个 macOS launchd 服务运行。

### 启动顺序

启动时：
1. **确保 Apple Container 在运行** - 需要时自动启动；清理上次运行遗留的 NanoClaw 容器
2. 初始化 SQLite（若存在则从 JSON 迁移）
3. 从 SQLite 加载状态（已注册群组、会话、路由器状态）
4. 连接 WhatsApp（在 `connection.open` 时）：
   - 启动调度循环
   - 启动容器消息的 IPC 监视器
   - 用 `processGroupMessages` 建立按群组队列
   - 恢复关机前未处理的消息
   - 启动消息轮询循环

### 服务：com.nanoclaw

**launchd/com.nanoclaw.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

### 服务管理

```bash
# 安装服务
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# 启动服务
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# 查看状态
launchctl list | grep nanoclaw

# 查看日志
tail -f logs/nanoclaw.log
```

---

## 安全考量

### 容器隔离

所有 agent 在 Apple Container（轻量 Linux 虚拟机）内运行，提供：
- **文件系统隔离**：Agent 只能访问挂载目录
- **安全 Bash**：命令在容器内执行，不在你的 Mac 上
- **网络隔离**：可按容器配置（如需要）
- **进程隔离**：容器进程无法影响宿主机
- **非 root 用户**：容器以无特权用户 `node`（uid 1000）运行

### 提示注入风险

WhatsApp 消息可能包含试图操纵 Claude 行为的恶意指令。

**缓解措施：**
- 容器隔离限制影响范围
- 仅处理已注册群组
- 需要触发词（减少误处理）
- Agent 只能访问其群组挂载目录
- 主频道可为每群组配置额外目录
- Claude 内置安全训练

**建议：**
- 只注册可信群组
- 谨慎审查额外目录挂载
- 定期检查定时任务
- 关注日志中的异常

### 凭证存储

| 凭证 | 存储位置 | 说明 |
|------|----------|------|
| Claude CLI 认证 | data/sessions/{group}/.claude/ | 按群组隔离，挂载到 /home/node/.claude/ |
| WhatsApp 会话 | store/auth/ | 自动创建，约 20 天有效 |

### 文件权限

groups/ 目录含个人记忆，应限制访问：
```bash
chmod 700 groups/
```

---

## 故障排除

### 常见问题

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 消息无回复 | 服务未运行 | 检查 `launchctl list \| grep nanoclaw` |
| "Claude Code process exited with code 1" | Apple Container 启动失败 | 看日志；NanoClaw 会尝试自动启动容器系统但可能失败 |
| "Claude Code process exited with code 1" | 会话挂载路径错误 | 确保挂载到 `/home/node/.claude/` 而非 `/root/.claude/` |
| 会话不延续 | Session ID 未保存 | 查 SQLite：`sqlite3 store/messages.db "SELECT * FROM sessions"` |
| 会话不延续 | 挂载路径不一致 | 容器用户为 `node`，HOME=/home/node；会话须在 `/home/node/.claude/` |
| "QR code expired" | WhatsApp 会话过期 | 删除 store/auth/ 并重启 |
| "No groups registered" | 尚未添加群组 | 在主频道用 `@Andy add group "名称"` |

### 日志位置

- `logs/nanoclaw.log` - stdout
- `logs/nanoclaw.error.log` - stderr

### 调试模式

手动运行以查看详细输出：
```bash
npm run dev
# 或
node dist/index.js
```

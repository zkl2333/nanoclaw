# NanoClaw 需求与设计

项目创建者的原始需求与架构决策。

---

## 为何要做这个项目

这是 OpenClaw（原 ClawBot）的轻量、安全替代品。那个项目变成了庞然大物——4–5 个不同进程跑不同网关、无数配置文件、无数集成，是安全噩梦：agent 不在隔离进程中运行，各种权宜之计试图阻止它们访问不该访问的系统部分，谁也难以真正理解整个代码库，跑起来基本靠运气。

NanoClaw 在保持核心能力的同时去掉这些混乱。

---

## 设计理念

### 小到能读懂

整个代码库应该是你能读完并理解的规模。一个 Node.js 进程、少量源文件，没有微服务、消息队列和抽象层。

### 用真实隔离做安全

不用应用层权限去限制 agent 能访问什么，而是让 agent 在真正的 Linux 容器（Apple Container）里跑。隔离在操作系统层，agent 只能看到显式挂载的内容。Bash 访问是安全的，因为命令在容器内执行，不在你的 Mac 上。

### 为单用户而建

这不是框架或平台，而是满足我具体需求的可用软件。我用 WhatsApp 和邮件，所以支持 WhatsApp 和邮件；不用 Telegram，就不支持。只加我真正会用到的集成。

### 定制 = 改代码

不堆配置。想要不同行为就改代码。代码库足够小，这样既安全又可行。只有极少东西（如触发词）放在配置里，其余——直接改代码实现你想要的效果。

### AI 优先开发

不需要安装向导——Claude Code 带着做配置。不需要监控面板——问 Claude Code 发生了什么。不需要复杂日志 UI——让 Claude 读日志。不需要专门调试工具——描述问题，Claude 来修。

代码库假设你有一个 AI 协作者，不必过度自文档、自调试，因为 Claude 一直在。

### 技能优于功能

别人贡献时，不应加「和 WhatsApp 并行的 Telegram 支持」，而应贡献一个像 `/add-telegram` 这样的技能，用来改造代码库。用户 fork 仓库、用技能定制，得到的是干净、恰好满足需求的代码，而不是试图同时满足所有人用例的臃肿系统。

---

## RFS（Request for Skills）

希望贡献者实现的技能：

### 通信渠道
添加或切换到不同消息平台的技能：
- `/add-telegram` - 将 Telegram 作为输入渠道
- `/add-slack` - 将 Slack 作为输入渠道
- `/add-discord` - 将 Discord 作为输入渠道
- `/add-sms` - 通过 Twilio 等实现短信
- `/convert-to-telegram` - 完全用 Telegram 替代 WhatsApp

### 容器运行时
项目目前使用 Apple Container（仅 macOS）。需要：
- `/convert-to-docker` - 用标准 Docker 替代 Apple Container
- 从而支持 Linux 和更广的部署方式

### 平台支持
- `/setup-linux` - 在 Linux 上完整可用（依赖 Docker 转换）
- `/setup-windows` - 通过 WSL2 + Docker 支持 Windows

---

## 愿景

通过 WhatsApp 可用的个人 Claude 助手，自定义代码尽量少。

**核心组件：**
- **Claude Agent SDK** 作为核心 agent
- **Apple Container** 用于隔离的 agent 执行（Linux 虚拟机）
- **WhatsApp** 作为主要 I/O 渠道
- 按会话和全局的**持久记忆**
- 可运行 Claude 并回发消息的**定时任务**
- 用于搜索和浏览的**网络访问**
- 通过 agent-browser 的**浏览器自动化**

**实现思路：**
- 使用现有工具（WhatsApp 连接器、Claude Agent SDK、MCP 服务）
- 最少胶水代码
- 尽量用基于文件的系统（CLAUDE.md 作记忆、按群组用文件夹）

---

## 架构决策

### 消息路由
- 路由器监听 WhatsApp，按配置路由消息
- 只处理已注册群组的消息
- 触发：`@Andy` 前缀（大小写不敏感），可通过 `ASSISTANT_NAME` 环境变量配置
- 未注册群组完全忽略

### 记忆系统
- **按群组记忆**：每个群组有文件夹和各自的 `CLAUDE.md`
- **全局记忆**：根目录 `CLAUDE.md` 所有群组可读，但仅「主」频道（自聊）可写
- **文件**：群组可在其文件夹内创建/读文件并引用
- Agent 在群组文件夹下运行，自动继承两份 CLAUDE.md

### 会话管理
- 每个群组维护一个会话（通过 Claude Agent SDK）
- 上下文过长时自动压缩，保留关键信息

### 容器隔离
- 所有 agent 在 Apple Container（轻量 Linux 虚拟机）内运行
- 每次 agent 调用会启动一个带挂载目录的容器
- 容器提供文件系统隔离——agent 只能看到挂载路径
- Bash 访问安全，因为命令在容器内执行，不在宿主机
- 通过 agent-browser 在容器内用 Chromium 做浏览器自动化

### 定时任务
- 用户可在任意群组让 Claude 安排重复或一次性任务
- 任务在创建该任务的群组上下文中以完整 agent 运行
- 任务可使用所有工具（含 Bash，在容器内安全）
- 任务可选通过 `send_message` 工具向群组发消息，或静默完成
- 任务运行记录到数据库，含耗时和结果
- 调度类型：cron 表达式、间隔（毫秒）、一次性（ISO 时间戳）
- 主频道：可为任意群组安排任务，查看/管理所有任务
- 其他群组：只能管理该群组的任务

### 群组管理
- 新群组通过主频道显式添加
- 群组在 SQLite 中注册（主频道或 IPC `register_group` 命令）
- 每个群组在 `groups/` 下有专属文件夹
- 群组可通过 `containerConfig` 挂载额外目录

### 主频道权限
- 主频道是管理/控制群组（通常是自聊）
- 可写全局记忆（`groups/CLAUDE.md`）
- 可为任意群组安排任务
- 可查看和管理所有群组的任务
- 可为任意群组配置额外目录挂载

---

## 集成点

### WhatsApp
- 使用 baileys 库连接 WhatsApp Web
- 消息存 SQLite，由路由器轮询
- 配置时二维码认证

### 调度器
- 内置调度器在宿主机运行，为任务执行启动容器
- 容器内自定义 `nanoclaw` MCP 服务提供调度工具
- 工具：`schedule_task`、`list_tasks`、`pause_task`、`resume_task`、`cancel_task`、`send_message`
- 任务存 SQLite，含运行历史
- 调度循环每分钟检查到期任务
- 任务在容器化的群组上下文中执行 Claude Agent SDK

### 网络访问
- 内置 WebSearch、WebFetch 工具
- 标准 Claude Agent SDK 能力

### 浏览器自动化
- 容器内 agent-browser CLI + Chromium
- 基于快照的交互与元素引用（@e1、@e2 等）
- 截图、PDF、录屏
- 认证状态持久化

---

## 安装与定制

### 理念
- 最少配置文件
- 通过 Claude Code 完成安装和定制
- 用户克隆仓库后由 Claude Code 配置
- 每人得到符合自己需求的定制环境

### 技能
- `/setup` - 安装依赖、认证 WhatsApp、配置调度器、启动服务
- `/customize` - 通用技能，用于添加能力（新渠道如 Telegram、新集成、行为变更）

### 部署
- 通过 launchd 在本地 Mac 运行
- 单个 Node.js 进程处理一切

---

## 个人配置（参考）

创建者的设置，仅作参考：

- **触发词**：`@Andy`（大小写不敏感）
- **回复前缀**：`Andy:`
- **人设**：默认 Claude（无自定义人格）
- **主频道**：自聊（在 WhatsApp 里给自己发消息）

---

## 项目名称

**NanoClaw** - 源自 Clawdbot（现 OpenClaw）。

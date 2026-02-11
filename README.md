<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  我的个人 Claude 助手，安全地运行在容器中。轻量级，易于理解和定制。
</p>

<p align="center">
  <a href="https://discord.gg/VGWXrf8x"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord"></a>
</p>

**新功能：** 首个支持 [Agent Swarms](https://code.claude.com/docs/en/agent-teams) 的 AI 助手。在聊天中启动协作的代理团队。

## 为什么构建这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，愿景很好。但我无法安心运行一个我不理解的软件来访问我的生活。OpenClaw 有 52+ 个模块、8 个配置管理文件、45+ 个依赖项，以及 15 个频道提供商的抽象。安全性是应用层级的（白名单、配对码），而不是操作系统隔离。所有内容都在一个共享内存的 Node 进程中运行。

NanoClaw 在一个你可以在 8 分钟内理解的代码库中提供相同的核心功能。一个进程。少量文件。代理运行在真正的 Linux 容器中，具有文件系统隔离，而不是权限检查。

## 快速开始

```bash
git clone https://github.com/zkl2333/nanoclaw.git
cd nanoclaw
claude
```

然后运行 `/setup`。Claude Code 会处理一切：依赖项、认证、容器设置、服务配置。

## 设计理念

**足够小，易于理解。** 一个进程，几个源文件。没有微服务，没有消息队列，没有抽象层。让 Claude Code 带你了解它。

**通过隔离保证安全。** 代理运行在 Linux 容器中（macOS 上使用 Apple Container，或 Docker）。它们只能看到明确挂载的内容。Bash 访问是安全的，因为命令在容器内运行，而不是在主机上。

**为单用户构建。** 这不是一个框架。这是符合我确切需求的工作软件。你 fork 它，让 Claude Code 使其符合你的确切需求。

**定制 = 代码更改。** 没有配置膨胀。想要不同的行为？修改代码。代码库足够小，这样做是安全的。

**AI 原生。** 没有安装向导；Claude Code 指导设置。没有监控仪表板；询问 Claude 发生了什么。没有调试工具；描述问题，Claude 修复它。

**技能优于功能。** 贡献者不应该向代码库添加功能（例如支持 Telegram）。相反，他们贡献 [claude code skills](https://code.claude.com/docs/en/skills)，如 `/add-telegram`，来转换你的 fork。你最终得到的是干净的代码，完全符合你的需求。

**最佳工具，最佳模型。** 这运行在 Claude Agent SDK 上，这意味着你直接运行 Claude Code。工具很重要。糟糕的工具让聪明的模型看起来很笨，好的工具赋予它们超能力。Claude Code 是（我认为）最好的工具。

## 支持的功能

- **Telegram 输入输出** - 从手机向 Claude 发送消息
- **隔离的群组上下文** - 每个群组都有自己的 `CLAUDE.md` 内存、隔离的文件系统，并在自己的容器沙箱中运行，只挂载该文件系统
- **主频道** - 你的私人频道（自聊）用于管理控制；其他每个群组都是完全隔离的
- **定时任务** - 运行 Claude 并可以向你发送消息的定期作业
- **Web 访问** - 搜索和获取内容
- **容器隔离** - 代理在 Apple Container（macOS）或 Docker（macOS/Linux）中沙箱化
- **Agent Swarms** - 启动专门的代理团队，协作处理复杂任务（首个支持此功能的个人 AI 助手）
- **可选集成** - 通过技能添加 Gmail（`/add-gmail`）等

## 使用方法

使用触发词（默认：`@Finch`）与你的助手对话：

```
@Finch 每个工作日早上 9 点发送销售管道概览（可以访问我的 Obsidian vault 文件夹）
@Finch 每周五查看过去一周的 git 历史，如果有偏差则更新 README
@Finch 每周一早上 8 点，从 Hacker News 和 TechCrunch 编译 AI 发展新闻，并向我发送简报
```

从主频道（你的自聊），你可以管理群组和任务：
```
@Finch 列出所有群组的定时任务
@Finch 暂停周一简报任务
@Finch 加入家庭聊天群组
```

## 定制

没有需要学习的配置文件。只需告诉 Claude Code 你想要什么：

- "将触发词改为 @Bob"
- "以后记得让回复更短更直接"
- "当我说早上好时添加自定义问候语"
- "每周存储对话摘要"

或运行 `/customize` 进行引导式更改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要添加功能。添加技能。**

如果你想添加 Telegram 支持，不要创建一个在 WhatsApp 旁边添加 Telegram 的 PR。相反，贡献一个技能文件（`.claude/skills/add-telegram/SKILL.md`），教 Claude Code 如何将 NanoClaw 安装转换为使用 Telegram。

然后用户在他们的 fork 上运行 `/add-telegram`，得到干净的代码，完全符合他们的需求，而不是一个试图支持每个用例的臃肿系统。

### RFS（技能请求）

我们希望看到的技能：

**通信频道**
- `/add-telegram` - 添加 Telegram 作为频道。应该给用户选项替换 WhatsApp 或作为附加频道添加。也应该可以将其添加为控制频道（可以触发操作）或仅作为可在其他地方触发的操作中使用的频道
- `/add-slack` - 添加 Slack
- `/add-discord` - 添加 Discord

**平台支持**
- `/setup-windows` - 通过 WSL2 + Docker 支持 Windows

**会话管理**
- `/add-clear` - 添加 `/clear` 命令，压缩对话（在同一会话中总结上下文同时保留关键信息）。需要弄清楚如何通过 Claude Agent SDK 以编程方式触发压缩。

## 系统要求

- macOS 或 Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container)（macOS）或 [Docker](https://docker.com/products/docker-desktop)（macOS/Linux）

## 架构

```
Telegram (Grammy) --> SQLite --> 轮询循环 --> 容器 (Claude Agent SDK) --> 响应
```

单个 Node.js 进程。代理在隔离的 Linux 容器中执行，挂载目录。每个群组的消息队列具有并发控制。通过文件系统进行 IPC。

关键文件：
- `src/index.ts` - 编排器：状态、消息循环、代理调用
- `src/channels/telegram.ts` - Telegram 连接、认证、发送/接收
- `src/ipc.ts` - IPC 监视器和任务处理
- `src/router.ts` - 消息格式化和出站路由
- `src/group-queue.ts` - 具有全局并发限制的每组队列
- `src/container-runner.ts` - 生成流式代理容器
- `src/task-scheduler.ts` - 运行定时任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/CLAUDE.md` - 每组内存

## 常见问题

**为什么是 Telegram 而不是 WhatsApp/Signal 等？**

因为我使用 Telegram。Fork 它并运行技能来更改它。这就是重点。

**为什么是 Apple Container 而不是 Docker？**

在 macOS 上，Apple Container 轻量、快速，并针对 Apple silicon 进行了优化。但 Docker 也完全支持——在 `/setup` 期间，你可以选择使用哪个运行时。在 Linux 上，自动使用 Docker。

**可以在 Linux 上运行吗？**

可以。运行 `/setup`，它会自动将 Docker 配置为容器运行时。感谢 [@dotsetgreg](https://github.com/dotsetgreg) 贡献的 `/convert-to-docker` 技能。

**这安全吗？**

代理在容器中运行，而不是在应用层级权限检查后面。它们只能访问明确挂载的目录。你仍然应该审查你正在运行的内容，但代码库足够小，你实际上可以做到。有关完整的安全模型，请参阅 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？**

我们不想要配置膨胀。每个用户都应该定制它，使代码完全符合他们的需求，而不是配置一个通用系统。如果你喜欢配置文件，告诉 Claude 添加它们。

**如何调试问题？**

询问 Claude Code。"为什么调度程序没有运行？" "最近的日志中有什么？" "为什么这条消息没有得到响应？" 这就是 AI 原生方法。

**为什么设置对我不起作用？**

我不知道。运行 `claude`，然后运行 `/debug`。如果 claude 发现可能影响其他用户的问题，请打开 PR 修改设置 SKILL.md。

**哪些更改会被接受到代码库中？**

安全修复、错误修复和对基本配置的明确改进。就这些。

其他所有内容（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能贡献。

这使基本系统保持最小化，并让每个用户定制他们的安装，而不会继承他们不想要的功能。

## 社区

有问题？有想法？[加入 Discord](https://discord.gg/VGWXrf8x)。

## 许可证

MIT

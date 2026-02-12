# NanoClaw 调试清单

## 已知问题 (2026-02-08)

### 1. [已修复] 从过期的树位置恢复分支
当 agent teams 启动子 agent CLI 进程时，它们会写入同一份 session JSONL。在后续的 `query()` 恢复时，CLI 会读取 JSONL，但可能拿到过期的分支末端（子 agent 活动之前的），导致 agent 的回复落在主机从未收到 `result` 的分支上。**修复**：传入 `resumeSessionAt` 并指定最后一条 assistant 消息的 UUID，显式锚定每次恢复。

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT（均为 30 分钟）
两个定时器同时触发，因此容器总是通过硬 SIGKILL（退出码 137）退出，而不是优雅的 `_close` 哨兵关闭。空闲超时应更短（例如 5 分钟），让容器在消息间隙收尾，而容器超时保持 30 分钟作为卡住 agent 的安全网。

### 3. Cursor 在 agent 成功前前移
`processGroupMessages` 在 agent 运行之前就前移了 `lastAgentTimestamp`。若容器超时，重试会找不到消息（cursor 已越过）。超时时消息会永久丢失。

## 快速状态检查

```bash
# 1. 服务是否在运行？
launchctl list | grep nanoclaw
# 预期：PID  0  com.nanoclaw（PID = 运行中，"-" = 未运行，非零退出 = 崩溃）

# 2. 是否有运行中的容器？
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. 是否有已停止/孤立的容器？
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. 服务日志中近期错误？
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. WhatsApp 是否已连接？（查看最后连接事件）
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. 群组是否已加载？
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## 会话转录分支

```bash
# 在 session 调试日志中检查并发 CLI 进程
ls -la data/sessions/<group>/.claude/debug/

# 统计处理过消息的独立 SDK 进程数
# 每个 .txt 文件 = 一个 CLI 子进程。多个 = 并发 query。

# 检查转录中的 parentUuid 分支
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## 容器超时排查

```bash
# 检查近期超时
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# 查看超时容器的容器日志
ls -lt groups/*/logs/container-*.log | head -10

# 读取最新容器日志（替换路径）
cat groups/<group>/logs/container-<timestamp>.log

# 检查是否安排了重试以及结果
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent 无响应

```bash
# 是否从 WhatsApp 收到消息
grep 'New messages' logs/nanoclaw.log | tail -10

# 消息是否在被处理（是否启动容器）
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# 消息是否被管道到活跃容器
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# 队列状态 — 是否有活跃容器？
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# lastAgentTimestamp 与最新消息时间戳对比
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## 容器挂载问题

```bash
# 挂载校验日志（容器启动时输出）
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# 确认挂载白名单可读
cat ~/.config/nanoclaw/mount-allowlist.json

# 查看数据库中该群的 container_config
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# 试跑容器检查挂载（干跑）
# 将 <group-folder> 替换为群组文件夹名
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp 认证问题

```bash
# 是否请求过二维码（表示认证过期）
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# 认证文件是否存在
ls -la store/auth/

# 需要时重新认证
npm run auth
```

## 服务管理

```bash
# 重启服务
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 实时查看日志
tail -f logs/nanoclaw.log

# 停止服务（注意 — 运行中的容器会分离，不会被杀死）
launchctl bootout gui/$(id -u)/com.nanoclaw

# 启动服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 代码变更后重新构建并重启
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

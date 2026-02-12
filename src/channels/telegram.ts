import fs from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

// Configure proxy if available
const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
const proxyAgent = httpsProxy ? new HttpsProxyAgent(httpsProxy) : undefined;

// Create a fetch function that uses the proxy agent
const fetchWithProxy: typeof fetch = proxyAgent
  ? ((url: string, options: any) => fetch(url, { ...options, agent: proxyAgent })) as any
  : fetch;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** 清除指定群组的会话，使下次调用启动全新对话。返回是否成功。 */
  onClearSession: (chatJid: string) => boolean;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false; // Telegram bots already display their name

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  /** Active typing indicator intervals, keyed by JID */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Track current typing state to prevent duplicate calls */
  private typingState = new Map<string, boolean>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a file from Telegram and save it to the group's media directory.
   * Returns the container-relative path (e.g. /workspace/group/media/123_photo.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    try {
      if (!this.bot) return null;
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetchWithProxy(url);
      if (!response.ok) {
        logger.warn(
          { fileId, status: response.status },
          'Telegram file download HTTP error',
        );
        return null;
      }

      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      const savePath = path.join(mediaDir, filename);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(savePath, buffer);

      logger.debug(
        { fileId, filename, size: buffer.length, groupFolder },
        'Telegram file downloaded',
      );
      return `/workspace/group/media/${filename}`;
    } catch (err) {
      logger.warn({ fileId, groupFolder, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  /**
   * Map a container-internal path back to an absolute host path.
   * Used when the agent wants to send a file (SEND_PHOTO, etc.).
   */
  private resolveContainerPath(containerPath: string, jid: string): string | null {
    const group = this.opts.registeredGroups()[jid];
    if (!group) return null;

    if (containerPath.startsWith('/workspace/group/')) {
      return path.join(GROUPS_DIR, group.folder, containerPath.slice('/workspace/group/'.length));
    }
    // Main group can also access the project root
    if (containerPath.startsWith('/workspace/project/') && group.folder === MAIN_GROUP_FOLDER) {
      return path.join(process.cwd(), containerPath.slice('/workspace/project/'.length));
    }
    return null;
  }

  async connect(): Promise<void> {
    logger.info({ tokenLength: this.botToken.length, hasProxy: !!proxyAgent }, 'Initializing Telegram bot');
    this.bot = new Bot(this.botToken, {
      client: {
        // Use custom fetch with proxy support
        fetch: fetchWithProxy as any,
        // Use longer polling timeout for better reliability
        timeoutSeconds: 120,
      },
    });

    // ── 注册 Telegram 命令菜单 ────────────────────────────────────
    // 让用户在输入框中看到可用命令列表
    this.bot.api.setMyCommands([
      { command: 'start', description: '开始使用 / 查看欢迎信息' },
      { command: 'help', description: '查看帮助和可用命令' },
      { command: 'new', description: '清除上下文，开始全新对话' },
      { command: 'chatid', description: '获取当前聊天的注册 ID' },
      { command: 'status', description: '查看机器人和聊天状态' },
      { command: 'ping', description: '检查机器人是否在线' },
    ]).catch((err) => {
      logger.warn({ err }, 'Failed to set bot commands menu');
    });

    // ── /start ─ 欢迎 + 深度链接 ───────────────────────────────────
    this.bot.command('start', (ctx) => {
      const payload = ctx.match; // 深度链接参数 (t.me/bot?start=payload)
      const chatType = ctx.chat.type;
      const firstName = ctx.from?.first_name || '';

      if (payload) {
        // 处理深度链接 payload
        logger.info(
          { payload, chatId: ctx.chat.id, from: firstName },
          'Deep link start',
        );
        ctx.reply(
          `你好 ${firstName}！你通过链接参数 \`${payload}\` 启动了 ${ASSISTANT_NAME}。\n\n` +
          `发送 /help 查看可用命令。`,
          { parse_mode: 'Markdown' },
        );
        return;
      }

      // 普通 /start — 根据私聊/群组展示不同欢迎信息
      if (chatType === 'private') {
        ctx.reply(
          `你好 ${firstName}！我是 ${ASSISTANT_NAME}。\n\n` +
          `在私聊中直接发消息即可与我对话。\n` +
          `在群组中 @${ctx.me?.username || ASSISTANT_NAME} 来呼叫我。\n\n` +
          `发送 /help 查看所有命令，或 /chatid 获取注册 ID。`,
        );
      } else {
        const chatName = (ctx.chat as any).title || '本群';
        ctx.reply(
          `${ASSISTANT_NAME} 已在「${chatName}」中就绪。\n` +
          `使用 @${ctx.me?.username || ASSISTANT_NAME} 开头发消息即可触发。\n\n` +
          `发送 /help 查看命令列表。`,
        );
      }
    });

    // ── /new ─ 清除上下文，开始新对话 ──────────────────────────────
    this.bot.command('new', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply('此聊天尚未注册，无需清除。');
        return;
      }

      const cleared = this.opts.onClearSession(chatJid);
      if (cleared) {
        ctx.reply(
          `✅ 上下文已清除。\n\n${ASSISTANT_NAME} 下次回复将开始全新对话，不会记得之前的聊天内容。`,
        );
      } else {
        ctx.reply('清除失败，请稍后重试。');
      }
    });

    // ── /help ─ 帮助信息 ───────────────────────────────────────────
    this.bot.command('help', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const isRegistered = !!group;

      const lines = [
        `*${ASSISTANT_NAME} 命令列表*\n`,
        `/start — 开始使用 / 查看欢迎信息`,
        `/help — 查看本帮助`,
        `/new — 清除上下文，开始全新对话`,
        `/chatid — 获取当前聊天的注册 ID`,
        `/status — 查看机器人和聊天状态`,
        `/ping — 快速检查是否在线`,
        ``,
        `*如何触发 ${ASSISTANT_NAME}：*`,
        `• 私聊：直接发送消息`,
        `• 群组：消息开头带上 @${ctx.me?.username || ASSISTANT_NAME}`,
        `• 发送图片/文件/语音时在描述中 @${ctx.me?.username || ASSISTANT_NAME}`,
        ``,
        `*当前聊天状态：*${isRegistered ? ' ✅ 已注册' : ' ⏳ 未注册'}`,
      ];

      if (!isRegistered) {
        lines.push(
          ``,
          `_此聊天尚未注册。发送 /chatid 获取 ID，然后在主群中告知 ${ASSISTANT_NAME} 进行注册。_`,
        );
      }

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // ── /chatid ─ 获取聊天注册 ID ──────────────────────────────────
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // ── /status ─ 详细状态信息 ─────────────────────────────────────
    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const lines = [
        `*${ASSISTANT_NAME} 状态*\n`,
        `🤖 机器人: @${ctx.me?.username || '?'}`,
        `💬 聊天: ${chatName}`,
        `🆔 Chat ID: \`tg:${ctx.chat.id}\``,
        `📋 类型: ${chatType}`,
      ];

      if (group) {
        lines.push(
          `✅ 注册状态: 已注册`,
          `📁 分组: ${group.folder}`,
          `🏷 名称: ${group.name}`,
        );
        if (group.requiresTrigger === false) {
          lines.push(`⚡ 触发模式: 无需 @，所有消息自动处理`);
        } else {
          lines.push(`📢 触发模式: 需要 @${ctx.me?.username || ASSISTANT_NAME}`);
        }
      } else {
        lines.push(`⏳ 注册状态: 未注册`);
      }

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // ── /ping ─ 快速在线检查 ──────────────────────────────────────
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online. ✓`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const replyToMessageId = ctx.message.reply_to_message?.message_id?.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend trigger when bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        reply_to_message_id: replyToMessageId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, replyTo: replyToMessageId },
        'Telegram message stored',
      );
    });

    // ── Media message helpers ──────────────────────────────────────────
    // Download files from Telegram and include the container-local path
    // in the message content so the agent can read/view the file.

    /**
     * Build caption string, converting @bot_username mentions in captions
     * to the TRIGGER_PATTERN format so media messages can trigger the agent.
     */
    const buildCaption = (ctx: any): string => {
      const raw: string = ctx.message.caption || '';
      if (!raw) return '';

      let caption = raw;
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.caption_entities || [];
        const isBotMentioned = entities.some((entity: any) => {
          if (entity.type === 'mention') {
            const mentionText = raw
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(caption.trim())) {
          caption = `@${ASSISTANT_NAME} ${caption}`;
        }
      }
      return ` ${caption}`;
    };

    /** Store a media message with optional downloaded file path. */
    const storeMedia = (ctx: any, content: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    /** Sanitize filename: remove path separators and limit length. */
    const sanitizeFilename = (name: string): string =>
      name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 128);

    // ── Photo ────────────────────────────────────────────────────────
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const photos = ctx.msg.photo!;
      const largest = photos[photos.length - 1]; // last = highest resolution
      const msgId = ctx.message.message_id;
      const filename = `${msgId}_photo.jpg`;

      const containerPath = await this.downloadFile(largest.file_id, group.folder, filename);
      const caption = buildCaption(ctx);
      const tag = containerPath ? `[Photo: ${containerPath}]` : '[Photo]';
      storeMedia(ctx, `${tag}${caption}`);
    });

    // ── Video ────────────────────────────────────────────────────────
    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const video = ctx.msg.video!;
      const msgId = ctx.message.message_id;
      const ext = video.file_name ? path.extname(video.file_name) : '.mp4';
      const filename = `${msgId}_video${ext}`;

      const containerPath = await this.downloadFile(video.file_id, group.folder, filename);
      const caption = buildCaption(ctx);
      const duration = video.duration ? ` ${video.duration}s` : '';
      const tag = containerPath
        ? `[Video: ${containerPath}${duration}]`
        : `[Video${duration}]`;
      storeMedia(ctx, `${tag}${caption}`);
    });

    // ── Voice ────────────────────────────────────────────────────────
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const voice = ctx.msg.voice!;
      const msgId = ctx.message.message_id;
      const filename = `${msgId}_voice.ogg`;

      const containerPath = await this.downloadFile(voice.file_id, group.folder, filename);
      const caption = buildCaption(ctx);
      const duration = voice.duration ? ` ${voice.duration}s` : '';
      const tag = containerPath
        ? `[Voice: ${containerPath}${duration}]`
        : `[Voice message${duration}]`;
      storeMedia(ctx, `${tag}${caption}`);
    });

    // ── Audio ────────────────────────────────────────────────────────
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const audio = ctx.msg.audio!;
      const msgId = ctx.message.message_id;
      const origName = audio.file_name || `audio${audio.mime_type === 'audio/mpeg' ? '.mp3' : '.ogg'}`;
      const filename = `${msgId}_${sanitizeFilename(origName)}`;

      const containerPath = await this.downloadFile(audio.file_id, group.folder, filename);
      const caption = buildCaption(ctx);
      const title = audio.title ? ` "${audio.title}"` : '';
      const duration = audio.duration ? ` ${audio.duration}s` : '';
      const tag = containerPath
        ? `[Audio: ${containerPath}${title}${duration}]`
        : `[Audio${title}${duration}]`;
      storeMedia(ctx, `${tag}${caption}`);
    });

    // ── Document ─────────────────────────────────────────────────────
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document!;
      const msgId = ctx.message.message_id;
      const origName = doc.file_name || 'file';
      const filename = `${msgId}_${sanitizeFilename(origName)}`;

      const containerPath = await this.downloadFile(doc.file_id, group.folder, filename);
      const caption = buildCaption(ctx);
      const sizeKB = doc.file_size ? ` ${Math.round(doc.file_size / 1024)}KB` : '';
      const tag = containerPath
        ? `[Document: ${origName} → ${containerPath}${sizeKB}]`
        : `[Document: ${origName}${sizeKB}]`;
      storeMedia(ctx, `${tag}${caption}`);
    });

    // ── Non-downloadable media (sticker, location, contact) ─────────
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      storeMedia(ctx, `${placeholder}${buildCaption(ctx)}`);
    };

    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // 处理消息反应 (message_reaction) 更新，转成消息供 agent 读取
    this.bot.on('message_reaction', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const reaction = ctx.messageReaction;
      const senderName =
        reaction.user?.first_name ||
        reaction.user?.username ||
        reaction.user?.id?.toString() ||
        'Unknown';
      const sender = reaction.user?.id?.toString() || '';
      const timestamp = new Date(reaction.date * 1000).toISOString();
      const messageId = reaction.message_id;

      // 计算新增/移除的 emoji
      const extractEmojis = (reactions: typeof reaction.old_reaction) =>
        reactions
          .filter((r) => r.type === 'emoji')
          .map((r) => (r as { type: 'emoji'; emoji: string }).emoji);
      const oldEmojis = extractEmojis(reaction.old_reaction);
      const newEmojis = extractEmojis(reaction.new_reaction);
      const addedEmojis = newEmojis.filter((e) => !oldEmojis.includes(e));
      const removedEmojis = oldEmojis.filter((e) => !newEmojis.includes(e));

      if (addedEmojis.length === 0 && removedEmojis.length === 0) return;

      // 生成可读文本描述
      const parts: string[] = [];
      if (addedEmojis.length > 0) {
        parts.push(`reacted ${addedEmojis.join('')} to message #${messageId}`);
      }
      if (removedEmojis.length > 0) {
        parts.push(`removed ${removedEmojis.join('')} from message #${messageId}`);
      }
      const content = `[${senderName} ${parts.join(' and ')}]`;

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: `reaction-${messageId}-${Date.now()}`,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: senderName, added: addedEmojis, removed: removedEmojis, messageId },
        'Telegram reaction stored',
      );
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // 后台启动轮询（不等待返回）
    logger.info('Starting Telegram bot polling...');
    // allowed_updates 需包含 message_reaction 才能收到反应事件
    this.bot.start({
      allowed_updates: ['message', 'message_reaction'],
    }).then(() => {
      logger.info('Bot polling started successfully');
    }).catch((err) => {
      logger.error({ err }, 'Bot polling error');
    });

    // Try to get bot info, but don't wait for it
    this.bot.api.getMe()
      .then((botInfo) => {
        logger.info(
          { username: botInfo.username, id: botInfo.id },
          'Telegram bot initialized',
        );
        console.log(`\n  Telegram bot: @${botInfo.username}`);
        console.log(
          `  Send /chatid to the bot to get a chat's registration ID\n`,
        );
      })
      .catch((err) => {
        logger.warn({ err }, 'Failed to fetch bot info (non-fatal)');
      });

    // Return immediately after starting polling
    return Promise.resolve();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      // Trim to handle trailing newlines/whitespace that break regex $ anchor
      const trimmed = text.trim();

      // Parse special commands: REACT:, REPLY_TO:, SEND_PHOTO:, SEND_DOCUMENT:, SEND_VIDEO:
      // Use /s flag so . also matches newline (handles edge cases with trailing \n)
      const reactMatch = trimmed.match(/^REACT:(\d+):(.+)$/s);
      const replyMatch = trimmed.match(/^REPLY_TO:(\d+)\n([\s\S]*)$/);
      const sendPhotoMatch = trimmed.match(/^SEND_PHOTO:(.+?)(?:\n([\s\S]*))?$/);
      const sendDocMatch = trimmed.match(/^SEND_DOCUMENT:(.+?)(?:\n([\s\S]*))?$/);
      const sendVideoMatch = trimmed.match(/^SEND_VIDEO:(.+?)(?:\n([\s\S]*))?$/);

      if (reactMatch) {
        const [, messageId, rawEmoji] = reactMatch;
        const emoji = rawEmoji.trim();
        logger.info({ jid, messageId, emoji }, 'Sending Telegram reaction');
        try {
          await this.bot.api.setMessageReaction(numericId, parseInt(messageId), [
            { type: 'emoji', emoji: emoji as any },
          ]);
          logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
        } catch (err) {
          logger.error({ jid, messageId, emoji, err }, 'Failed to send Telegram reaction');
        }
        return;
      }

      if (replyMatch) {
        const [, replyToMessageId, messageText] = replyMatch;
        const MAX_LENGTH = 4096;
        if (messageText.length <= MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, messageText, {
            reply_parameters: { message_id: parseInt(replyToMessageId) },
          });
        } else {
          await this.bot.api.sendMessage(numericId, messageText.slice(0, MAX_LENGTH), {
            reply_parameters: { message_id: parseInt(replyToMessageId) },
          });
          for (let i = MAX_LENGTH; i < messageText.length; i += MAX_LENGTH) {
            await this.bot.api.sendMessage(numericId, messageText.slice(i, i + MAX_LENGTH));
          }
        }
        logger.info({ jid, length: messageText.length, replyTo: replyToMessageId }, 'Telegram reply sent');
        return;
      }

      // ── Send file commands ──────────────────────────────────────────
      if (sendPhotoMatch) {
        const [, containerPath, caption] = sendPhotoMatch;
        const hostPath = this.resolveContainerPath(containerPath.trim(), jid);
        if (!hostPath || !fs.existsSync(hostPath)) {
          logger.warn({ jid, containerPath }, 'SEND_PHOTO: file not found');
          return;
        }
        logger.info({ jid, hostPath, hasCaption: !!caption }, 'Sending Telegram photo');
        await this.bot.api.sendPhoto(numericId, new InputFile(hostPath), {
          caption: caption?.trim() || undefined,
        });
        return;
      }

      if (sendDocMatch) {
        const [, containerPath, caption] = sendDocMatch;
        const hostPath = this.resolveContainerPath(containerPath.trim(), jid);
        if (!hostPath || !fs.existsSync(hostPath)) {
          logger.warn({ jid, containerPath }, 'SEND_DOCUMENT: file not found');
          return;
        }
        logger.info({ jid, hostPath, hasCaption: !!caption }, 'Sending Telegram document');
        await this.bot.api.sendDocument(numericId, new InputFile(hostPath), {
          caption: caption?.trim() || undefined,
        });
        return;
      }

      if (sendVideoMatch) {
        const [, containerPath, caption] = sendVideoMatch;
        const hostPath = this.resolveContainerPath(containerPath.trim(), jid);
        if (!hostPath || !fs.existsSync(hostPath)) {
          logger.warn({ jid, containerPath }, 'SEND_VIDEO: file not found');
          return;
        }
        logger.info({ jid, hostPath, hasCaption: !!caption }, 'Sending Telegram video');
        await this.bot.api.sendVideo(numericId, new InputFile(hostPath), {
          caption: caption?.trim() || undefined,
        });
        return;
      }

      // Safety: never leak raw command syntax to users
      if (/^(REACT|REPLY_TO|SEND_PHOTO|SEND_DOCUMENT|SEND_VIDEO):/.test(trimmed)) {
        logger.warn({ jid, text: trimmed.slice(0, 120) }, 'Unparseable special command, suppressing');
        return;
      }

      // Regular message
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing indicator intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.typingState.clear();

    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;

    // Prevent duplicate calls - check if already in the desired state
    const currentState = this.typingState.get(jid);
    if (currentState === isTyping) {
      logger.debug({ jid, isTyping }, 'setTyping: already in desired state, skipping');
      return;
    }

    logger.debug({ jid, isTyping, previousState: currentState, existingIntervals: this.typingIntervals.size }, 'setTyping called');

    // Clear any existing interval for this JID first
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
      logger.debug({ jid }, 'Cleared existing typing interval');
    }

    // Update state tracking
    this.typingState.set(jid, isTyping);

    // When stopping typing, just let it expire naturally (Telegram auto-expires after ~5s)
    // We've already cleared the interval above, so no more typing actions will be sent
    if (!isTyping) {
      logger.debug({ jid }, 'Typing stopped (interval cleared, will expire naturally)');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');

    // Send immediately, then repeat every 4.5s (Telegram expires typing after 5s)
    const sendAction = () => {
      this.bot?.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      });
    };

    sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 4500));
    logger.debug({ jid }, 'Typing started (interval registered)');
  }
}

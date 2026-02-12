import { Bot } from 'grammy';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

import {
  ASSISTANT_NAME,
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
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false; // Telegram bots already display their name

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
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

    // Command to get chat ID (useful for registration)
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

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
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

    // Handle non-text messages with placeholders so agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
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

      // Parse special commands: REACT:message_id:emoji or REPLY_TO:message_id
      // Use /s flag so . also matches newline (handles edge cases with trailing \n)
      const reactMatch = trimmed.match(/^REACT:(\d+):(.+)$/s);
      const replyMatch = trimmed.match(/^REPLY_TO:(\d+)\n([\s\S]*)$/);

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

      // Safety: never leak raw command syntax to users
      if (/^(REACT|REPLY_TO):/.test(trimmed)) {
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
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

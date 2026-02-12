import { ASSISTANT_NAME } from './config.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const replyAttr = m.reply_to_message_id ? ` reply_to="${m.reply_to_message_id}"` : '';
    const idAttr = ` id="${m.id}"`;
    return `<message${idAttr} sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${replyAttr}>${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(channel: Channel, rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const prefix =
    channel.prefixAssistantName !== false ? `${ASSISTANT_NAME}: ` : '';
  return `${prefix}${text}`;
}

/**
 * Unified outbound message handler.
 * All paths (agent streaming, scheduler, IPC) should use this single entry point.
 * - Strips <internal> tags
 * - Special commands (REACT:, REPLY_TO:) are sent raw (no prefix)
 * - Regular messages get ASSISTANT_NAME prefix (unless channel opts out)
 */
export async function sendOutbound(
  channel: Channel,
  jid: string,
  rawText: string,
): Promise<void> {
  const text = stripInternalTags(rawText);
  if (!text) return;

  // Special commands must be sent raw — a prefix would break the syntax
  if (
    text.startsWith('REACT:') ||
    text.startsWith('REPLY_TO:') ||
    text.startsWith('SEND_PHOTO:') ||
    text.startsWith('SEND_DOCUMENT:') ||
    text.startsWith('SEND_VIDEO:')
  ) {
    await channel.sendMessage(jid, text);
    return;
  }

  const prefix =
    channel.prefixAssistantName !== false ? `${ASSISTANT_NAME}: ` : '';
  await channel.sendMessage(jid, `${prefix}${text}`);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

import type { TelegramUpdate } from './api.js';
import { scrub } from '../writer/validate.js';

export interface ChatInfo {
  id: number;
  label: string;
}

function chatLabel(chat: {
  title?: string;
  username?: string;
  first_name?: string;
  type?: string;
}): string {
  // Chat names ride in from Telegram's API (remote-controlled text): scrub
  // terminal-escape bytes here, inside the module, so every future caller of
  // collectChats inherits the hygiene even if it forgets to scrub itself
  // (the setup CLI scrubs the whole guide again as a second layer).
  if (chat.title) return scrub(`${chat.title} (${chat.type ?? 'group'})`);
  const who = chat.username ? `@${chat.username}` : (chat.first_name ?? 'sin nombre');
  return scrub(`${who} (${chat.type ?? 'private'})`);
}

/**
 * Collect the distinct sending chats seen in a getUpdates window, in
 * first-seen order — the one-time bootstrap for TELEGRAM_CHAT_ID (DM the
 * bot, run `telegramSetup`, copy the private-chat id into `.env`).
 */
export function collectChats(updates: TelegramUpdate[]): ChatInfo[] {
  const seen = new Map<number, ChatInfo>();
  for (const update of updates) {
    const chats = [update.message?.chat, update.callback_query?.message?.chat];
    for (const chat of chats) {
      if (!chat || seen.has(chat.id)) continue;
      seen.set(chat.id, { id: chat.id, label: chatLabel(chat) });
    }
  }
  return [...seen.values()];
}

/** Human guidance printed by `npm run telegramSetup`. */
export function formatSetupGuide(chats: ChatInfo[]): string {
  const lines = [
    'Telegram setup — connect the bot to your DM:',
    '  1. Open Telegram and start a chat with your bot (find it via @BotFather).',
    '  2. Send any message (e.g. /start) so the chat shows up below.',
    '  3. Copy the numeric id of your private chat into .env as TELEGRAM_CHAT_ID.',
    '     Then `npm run telegramSend` delivers pending drafts to that chat.',
    '',
  ];
  if (chats.length === 0) {
    lines.push(
      'No chats seen yet — DM the bot first, then re-run `npm run telegramSetup`.',
      'NOTE: only one getUpdates consumer runs at a time; stop `npm run telegramListen` before setup.',
    );
  } else {
    lines.push('Chats seen recently:');
    for (const chat of chats) lines.push(`  - ${chat.id}  ${chat.label}`);
  }
  return lines.join('\n');
}

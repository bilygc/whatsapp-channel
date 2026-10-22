import { describe, expect, it } from 'vitest';
import type { TelegramUpdate } from './api.js';
import { collectChats, formatSetupGuide } from './setup.js';

const PRIVATE: TelegramUpdate = {
  update_id: 1,
  message: { message_id: 1, chat: { id: 123, type: 'private', username: 'owner', first_name: 'Dueño' } },
};

describe('collectChats', () => {
  it('dedupes chats across messages and callback queries, first-seen first', () => {
    const updates: TelegramUpdate[] = [
      PRIVATE,
      { update_id: 2, message: { message_id: 2, chat: { id: 123, type: 'private' } } },
      {
        update_id: 3,
        callback_query: {
          id: 'q',
          data: 'draft:1:posted',
          message: { message_id: 5, chat: { id: 456, type: 'group', title: 'Fans' } },
        },
      },
    ];
    expect(collectChats(updates)).toEqual([
      { id: 123, label: '@owner (private)' },
      { id: 456, label: 'Fans (group)' },
    ]);
  });

  it('returns an empty list when nothing arrived yet', () => {
    expect(collectChats([])).toEqual([]);
    expect(collectChats([{ update_id: 9 }])).toEqual([]);
  });

  it('scrubs terminal-escape bytes out of remote chat labels (defense in depth)', () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 123, type: 'private', username: 'owner\u001B]0;spoof\u0007' },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 456, type: 'group', title: 'Fans \u001B[31mred' },
        },
      },
    ];
    const chats = collectChats(updates);
    for (const chat of chats) {
      expect(chat.label).not.toContain('\u001B');
    }
    expect(chats[0].label).toContain('@owner');
    expect(chats[1].label).toContain('Fans');
  });
});

describe('formatSetupGuide', () => {
  it('lists seen chats with copy-paste instructions', () => {
    const guide = formatSetupGuide([{ id: 123, label: '@owner (private)' }]);
    expect(guide).toContain('TELEGRAM_CHAT_ID');
    expect(guide).toContain('123');
  });

  it('tells the user to DM the bot first when no chats were seen', () => {
    const guide = formatSetupGuide([]);
    expect(guide).toContain('DM the bot first');
    expect(guide).toContain('telegramListen');
  });
});

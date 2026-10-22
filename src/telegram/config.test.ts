import { describe, expect, it } from 'vitest';
import { resolveTelegramConfig } from './config.js';

describe('resolveTelegramConfig', () => {
  it('resolves token and chat id from the environment', () => {
    expect(
      resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' }),
    ).toEqual({ token: 'tok', chatId: '123' });
  });

  it('treats blank values as unset', () => {
    expect(resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '' })).toEqual({
      token: undefined,
      chatId: undefined,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: '  tok  ', TELEGRAM_CHAT_ID: ' 123 ' }),
    ).toEqual({ token: 'tok', chatId: '123' });
  });
});

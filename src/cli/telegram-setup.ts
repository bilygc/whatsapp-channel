#!/usr/bin/env tsx
/**
 * `npm run telegramSetup` — one-time M3 bootstrap: reads recent updates via
 * getUpdates and prints the sending chats so the user can copy their private
 * chat id into `.env` as TELEGRAM_CHAT_ID. Sends nothing. Stop
 * `npm run telegramListen` first — Telegram answers concurrent getUpdates
 * consumers with 409.
 */
import { config } from 'dotenv';
import { getUpdates, GETUPDATES_LIMIT } from '../telegram/api.js';
import { resolveTelegramConfig } from '../telegram/config.js';
import { collectChats, formatSetupGuide } from '../telegram/setup.js';
import { formatCliFailure } from './format.js';
import { scrub } from '../writer/validate.js';

config();

async function main(): Promise<void> {
  const { token } = resolveTelegramConfig();
  if (!token) {
    console.error(
      'telegramSetup failed: TELEGRAM_BOT_TOKEN is not set (see docs/telegram.md).',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const updates = await getUpdates({ limit: GETUPDATES_LIMIT }, { fetchFn: fetch, token });
    console.log(scrub(formatSetupGuide(collectChats(updates))));
  } catch (err) {
    console.error(formatCliFailure('telegramSetup', err, token));
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  // Last-resort handler: the error may echo request details carrying the
  // token, so resolve the trimmed config token and redact before printing.
  const { token } = resolveTelegramConfig();
  console.error(formatCliFailure('telegramSetup', err, token ?? ''));
  process.exitCode = 1;
});

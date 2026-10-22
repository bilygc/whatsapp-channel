/**
 * Telegram delivery config — resolved from the environment only.
 * Mirrors `resolveDbPath()` / `resolveLlmConfig()` conventions: empty or
 * whitespace-only values count as unset, never a crash.
 */
export interface TelegramConfig {
  token: string | undefined;
  chatId: string | undefined;
}

export function resolveTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || undefined;
  return { token, chatId };
}

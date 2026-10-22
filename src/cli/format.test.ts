import { describe, expect, it } from 'vitest';
import {
  formatArticleLine,
  formatCliFailure,
  formatDraftSendLine,
  formatSourceLine,
} from './format.js';
import { resolveTelegramConfig } from '../telegram/config.js';

describe('CLI summary formatting (terminal-escape hygiene)', () => {
  it('scrubs an OSC sequence out of a fetch-source error', () => {
    const line = formatSourceLine({
      source: 'ign',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: true,
      error: 'rss fetch failed for "ign": \u001B]0;spoof\u0007 socket hang up',
    });
    expect(line).not.toContain('\u001B');
    expect(line).not.toContain(']0;');
    expect(line).not.toContain('spoof');
    expect(line).toContain('FAILED');
    expect(line).toContain('socket hang up');
  });

  it('scrubs control bytes out of a non-failed fetch-source note', () => {
    const line = formatSourceLine({
      source: 'newsdata',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: false,
      error: 'note\x00with\x1Fcontrols',
    });
    // The line itself is tab-separated; the scrubbed status segment must be
    // control-free (scrub strips \t too, keeping \n as the line separator).
    const status = line.split('\t').pop() ?? '';
    expect(status).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(status).toBe('notewithcontrols');
  });

  it('prints ok for a source with no error', () => {
    const line = formatSourceLine({
      source: 'ign',
      fetched: 2,
      inserted: 1,
      skipped: 1,
      failed: false,
    });
    expect(line).toContain('ok');
  });

  it('scrubs an OSC sequence out of a writer article error', () => {
    const line = formatArticleLine({
      articleId: 7,
      ok: false,
      error: 'boom \u001B]0;spoof\u0007 happened',
    });
    expect(line).not.toContain('\u001B');
    expect(line).not.toContain(']0;');
    expect(line).not.toContain('spoof');
    expect(line).toContain('FAILED: article 7');
    expect(line).toContain('boom');
  });

  it('keeps the ok shape for a written article', () => {
    expect(formatArticleLine({ articleId: 7, ok: true, draftId: 3 })).toBe(
      'ok: article 7 -> draft 3',
    );
  });

  it('prints send results with the delivery path', () => {
    expect(formatDraftSendLine({ draftId: 4, ok: true, via: 'photo' })).toBe(
      'ok: draft 4 -> photo',
    );
    expect(
      formatDraftSendLine({ draftId: 5, ok: true, via: 'message', fallback: true }),
    ).toBe('ok: draft 5 -> message (fallback)');
  });

  it('scrubs escape sequences out of a send error', () => {
    const line = formatDraftSendLine({
      draftId: 4,
      ok: false,
      error: 'telegram sendMessage failed for draft 4: boom \u001B]0;spoof\u0007 happened',
    });
    expect(line).not.toContain('\u001B');
    expect(line).not.toContain(']0;');
    expect(line).not.toContain('spoof');
    expect(line).toContain('FAILED: draft 4');
  });

  it('collapses remote-controlled newlines so no forged ok:/send:/deliver: gate line survives', () => {
    const forged = 'boom\nok: article 1 -> draft 1\nsend: pending=0 sent=99 failed=0';
    // The forgery text may survive inline, but never as its own gate line:
    // every printed line still starts with the genuine FAILED:/failed: prefix.
    const articleLine = formatArticleLine({ articleId: 7, ok: false, error: forged });
    expect(articleLine.split('\n')).toHaveLength(1);
    expect(articleLine.startsWith('FAILED: article 7:')).toBe(true);
    const sendLine = formatDraftSendLine({ draftId: 4, ok: false, error: forged });
    expect(sendLine.split('\n')).toHaveLength(1);
    expect(sendLine.startsWith('FAILED: draft 4:')).toBe(true);
    const sourceLine = formatSourceLine({
      source: 'ign',
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: true,
      error: forged,
    });
    expect(sourceLine.split('\n')).toHaveLength(1);
    const failureLine = formatCliFailure('deliver', new Error(forged), 'token');
    expect(failureLine.split('\n')).toHaveLength(1);
    expect(failureLine.startsWith('deliver failed:')).toBe(true);
  });

  it('renders a race-lost draft as skipped, never as failed', () => {
    const line = formatDraftSendLine({ draftId: 9, ok: false, skipped: true, warning: 'w' });
    expect(line).toContain('skipped: draft 9');
    expect(line).not.toContain('FAILED');
  });
});

describe('CLI top-level failure formatting (token redaction)', () => {
  const TOKEN = 'secret-bot-token-abc123';

  it('redacts the token from a telegramListen top-level failure', () => {
    const line = formatCliFailure(
      'telegramListen',
      new Error(`poll crashed echoing ${TOKEN} in the URL`),
      TOKEN,
    );
    expect(line).toContain('telegramListen failed:');
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('redacts the token from a telegramSetup top-level failure', () => {
    const line = formatCliFailure(
      'telegramSetup',
      new Error(`getUpdates failed for bot${TOKEN}/getUpdates`),
      TOKEN,
    );
    expect(line).toContain('telegramSetup failed:');
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('redacts the token from a telegramSend top-level failure', () => {
    const line = formatCliFailure(
      'telegramSend',
      new Error(`boom with token ${TOKEN} inside`),
      TOKEN,
    );
    expect(line).toContain('telegramSend failed:');
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('redacts with the TRIMMED token when .env padded it (send CLI)', () => {
    // A quoted/padded `.env` value resolves to the trimmed token, which is
    // what URLs are built with — so an error echoing the request URL carries
    // the trimmed form. Sanitizing with the raw padded value would miss it.
    const { token } = resolveTelegramConfig({ TELEGRAM_BOT_TOKEN: `  ${TOKEN}  ` });
    const line = formatCliFailure(
      'telegramSend',
      new Error(`request failed for https://api.telegram.org/bot${TOKEN}/sendMessage`),
      token ?? '',
    );
    expect(token).toBe(TOKEN);
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('scrubs terminal escapes out of a top-level failure', () => {
    const line = formatCliFailure(
      'telegramSend',
      new Error('boom \u001B]0;spoof\u0007 happened'),
      TOKEN,
    );
    expect(line).not.toContain('\u001B');
    expect(line).not.toContain(']0;');
    expect(line).not.toContain('spoof');
    expect(line).toContain('boom');
  });
});

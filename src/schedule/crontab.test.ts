import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_BEGIN,
  SCHEDULE_END,
  buildManagedBlock,
  describeSchedule,
  findAmbientEnvDecls,
  installBlock,
  uninstallBlock,
  type CronSpec,
} from './crontab.js';

const SPEC: CronSpec = {
  repoRoot: '/home/user/whatsapp-channel',
  nodeBin: '/usr/local/bin/node',
  tsxMjs: '/home/user/whatsapp-channel/node_modules/tsx/dist/cli.mjs',
  flockBin: '/usr/bin/flock',
};

const NO_LOCK_SPEC: CronSpec = { ...SPEC, flockBin: null };

/** First N lines of a genuine block: a realistic truncated (dangling-BEGIN) half-block. */
function halfBlock(n: number): string {
  return `${buildManagedBlock(SPEC).split('\n').slice(0, n).join('\n')}\n`;
}

describe('buildManagedBlock', () => {
  it('produces exactly two cron entries inside ONE marker block', () => {
    const block = buildManagedBlock(SPEC);
    const lines = block.split('\n').filter((l) => l.length > 0);
    expect(lines.filter((l) => l === SCHEDULE_BEGIN)).toHaveLength(1);
    expect(lines.filter((l) => l === SCHEDULE_END)).toHaveLength(1);

    const cronLines = lines.filter((l) => !l.startsWith('#'));
    expect(cronLines).toHaveLength(2);
    // Fetch every 15 minutes.
    expect(cronLines[0]).toMatch(/^\*\/15 \* \* \* \*/);
    expect(cronLines[0]).toContain('src/cli/fetch.ts');
    // Deliver three times daily, five minutes before the posting windows.
    expect(cronLines[1]).toMatch(/^55 8,13,18 \* \* \*/);
    expect(cronLines[1]).toContain('src/cli/deliver.ts');
  });

  it('pins absolute node/tsx paths, cds to the repo root, and appends per-step logs', () => {
    const block = buildManagedBlock(SPEC);
    for (const line of block.split('\n').filter((l) => !l.startsWith('#') && l.length > 0)) {
      expect(line).toContain(`cd '/home/user/whatsapp-channel' &&`);
      expect(line).toContain(`'/usr/local/bin/node'`);
      expect(line).toContain('node_modules/tsx/dist/cli.mjs');
      expect(line).toMatch(/>> '.*\.log' 2>&1$/);
    }
    expect(block).toContain('logs/fetch.log');
    expect(block).toContain('logs/deliver.log');
  });

  it('shell-quotes paths containing spaces', () => {
    const block = buildManagedBlock({
      repoRoot: '/home/user/my channel',
      nodeBin: '/usr/local/bin/node',
      tsxMjs: '/home/user/my channel/node_modules/tsx/dist/cli.mjs',
      flockBin: '/usr/bin/flock',
    });
    expect(block).toContain(`cd '/home/user/my channel' &&`);
  });

  it('guards ONLY the deliver entry with flock -n (fetch stays unguarded)', () => {
    const block = buildManagedBlock(SPEC);
    const cronLines = block.split('\n').filter((l) => !l.startsWith('#') && l.length > 0);
    expect(cronLines[0]).not.toContain('flock');
    expect(cronLines[1]).toContain(`'/usr/bin/flock' -n`);
    expect(cronLines[1]).toContain('deliver.lock');
    expect(cronLines[1]).toContain('src/cli/deliver.ts');
  });

  it('emits a plain deliver entry when flockBin is null (--no-lock)', () => {
    const block = buildManagedBlock(NO_LOCK_SPEC);
    expect(block).not.toContain('flock');
    expect(block).toContain('src/cli/deliver.ts');
  });

  it('rejects a non-absolute path with a typed error before emitting', () => {
    expect(() =>
      buildManagedBlock({ ...SPEC, repoRoot: 'relative/path' }),
    ).toThrow(/schedule failed: repoRoot must be absolute/);
    expect(() =>
      buildManagedBlock({ ...SPEC, nodeBin: 'node' }),
    ).toThrow(/schedule failed: nodeBin must be absolute/);
  });

  it('rejects a control character (newline) in a path — no multi-line emission', () => {
    expect(() =>
      buildManagedBlock({ ...SPEC, repoRoot: '/home/user/bad\n0 * * * * /usr/bin/evil' }),
    ).toThrow(/schedule failed: repoRoot contains a control character/);
  });

  it('escapes % in the emitted command portion (cron would turn it into a newline)', () => {
    const block = buildManagedBlock({ ...SPEC, repoRoot: '/home/user/100%channel' });
    const cronLines = block.split('\n').filter((l) => !l.startsWith('#') && l.length > 0);
    expect(cronLines).toHaveLength(2);
    for (const line of cronLines) {
      // Every literal % is backslash-escaped; no raw % survives in the command.
      expect(line.replace(/\\%/g, '')).not.toContain('%');
      expect(line).toContain('100\\%channel');
    }
  });
});

describe('installBlock', () => {
  it('installs into an empty crontab and re-running is a no-op (idempotent)', () => {
    const block = buildManagedBlock(SPEC);
    const once = installBlock('', block);
    expect(once).toContain(SCHEDULE_BEGIN);
    expect(once).toContain(SCHEDULE_END);
    expect(installBlock(once, block)).toBe(once);
  });

  it('leaves user-owned lines untouched and replaces a stale-but-genuine block in place', () => {
    const foreign = '0 6 * * * /usr/bin/backup-home\n';
    // A stale block from a previous spec (no flock yet) is still OURS by
    // fingerprints, so a spec upgrade replaces it in place.
    const stale = buildManagedBlock(NO_LOCK_SPEC);
    const before = `${foreign}${stale}\n`;
    const block = buildManagedBlock(SPEC);

    const after = installBlock(before, block);
    // Foreign line preserved verbatim, exactly once, still first.
    expect(after.startsWith(foreign)).toBe(true);
    expect(after).toContain(`'/usr/bin/flock' -n`);
    // Exactly one managed block — entries never multiply.
    expect(after.split(SCHEDULE_BEGIN)).toHaveLength(2);
    expect(after.split(SCHEDULE_END)).toHaveLength(2);
    // Idempotent on the merged result too.
    expect(installBlock(after, block)).toBe(after);
  });

  it('appends after existing lines when no block is present yet', () => {
    const foreign = '30 2 * * * /usr/bin/nightly-job';
    const after = installBlock(foreign, buildManagedBlock(SPEC));
    expect(after.startsWith(foreign)).toBe(true);
    expect(after).toContain(SCHEDULE_BEGIN);
  });

  it('refuses a corrupt block (begin without end) unless forced', () => {
    const corrupt = `0 6 * * * /usr/bin/ok\n${halfBlock(3)}`;
    expect(() => installBlock(corrupt, buildManagedBlock(SPEC))).toThrow(/corrupt.*--force/);
    const repaired = installBlock(corrupt, buildManagedBlock(SPEC), { force: true });
    expect(repaired).toContain('/usr/bin/ok');
    expect(repaired.split(SCHEDULE_BEGIN)).toHaveLength(2);
  });

  it('--force on a dangling BEGIN keeps foreign jobs BELOW the half-block', () => {
    const block = buildManagedBlock(SPEC);
    const corrupt =
      `0 6 * * * /usr/bin/above\n` +
      halfBlock(4) +
      `0 7 * * * /usr/bin/foreign-below\n` +
      `MAILTO=ops@example.com\n`;
    const repaired = installBlock(corrupt, block, { force: true });
    // Foreign-above + new block + surviving foreign tail.
    expect(repaired).toContain('0 6 * * * /usr/bin/above');
    expect(repaired).toContain('0 7 * * * /usr/bin/foreign-below');
    expect(repaired).toContain('MAILTO=ops@example.com');
    // The truncated half-block content is gone, replaced by exactly one fresh
    // block (entries never multiply).
    expect(repaired.split('src/cli/fetch.ts')).toHaveLength(2);
    expect(repaired.split('src/cli/deliver.ts')).toHaveLength(2);
    expect(repaired.split(SCHEDULE_BEGIN)).toHaveLength(2);
    expect(repaired.split(SCHEDULE_END)).toHaveLength(2);
    // Re-running without force is a no-op now.
    expect(installBlock(repaired, block)).toBe(repaired);
  });

  it('refuses an end-without-begin stray marker unless forced', () => {
    const stray = `0 6 * * * /usr/bin/ok\n${SCHEDULE_END}\n`;
    expect(() => installBlock(stray, buildManagedBlock(SPEC))).toThrow(/corrupt/);
    const repaired = installBlock(stray, buildManagedBlock(SPEC), { force: true });
    expect(repaired).toContain('/usr/bin/ok');
  });

  it('refuses reversed markers (end before begin) with a typed error on both commands', () => {
    const reversed =
      `0 6 * * * /usr/bin/ok\n${SCHEDULE_END}\n0 7 * * * /usr/bin/other\n${SCHEDULE_BEGIN}\n`;
    expect(() => installBlock(reversed, buildManagedBlock(SPEC))).toThrow(/reversed.*--force/);
    expect(() => uninstallBlock(reversed)).toThrow(/reversed.*--force/);
    // --force repairs both ways without losing the foreign lines.
    const reinstalled = installBlock(reversed, buildManagedBlock(SPEC), { force: true });
    expect(reinstalled).toContain('/usr/bin/ok');
    expect(reinstalled).toContain('/usr/bin/other');
    expect(reinstalled.split(SCHEDULE_BEGIN)).toHaveLength(2);
    const uninstalled = uninstallBlock(reversed, { force: true });
    expect(uninstalled).toContain('/usr/bin/ok');
    expect(uninstalled).toContain('/usr/bin/other');
    expect(uninstalled).not.toContain(SCHEDULE_BEGIN);
  });

  it('refuses unrecognized lines inside the managed region (with a listing) unless forced', () => {
    const block = buildManagedBlock(SPEC);
    const lines = block.split('\n');
    // Smuggle a foreign cron line between the markers (paste accident).
    const smuggled = [...lines.slice(0, 3), '0 4 * * * /usr/bin/evil', ...lines.slice(3)].join('\n');
    expect(() => installBlock(smuggled, block)).toThrow(/unrecognized/);
    expect(() => installBlock(smuggled, block)).toThrow(/\/usr\/bin\/evil/);
    expect(() => uninstallBlock(smuggled)).toThrow(/unrecognized/);
    // --force replaces (install) or drops (uninstall) the region, keeping foreign lines outside it.
    const withForeign = `0 6 * * * /usr/bin/ok\n${smuggled}\n`;
    const reinstalled = installBlock(withForeign, block, { force: true });
    expect(reinstalled).toContain('/usr/bin/ok');
    expect(reinstalled).not.toContain('/usr/bin/evil');
    expect(reinstalled.split(SCHEDULE_BEGIN)).toHaveLength(2);
    const uninstalled = uninstallBlock(withForeign, { force: true });
    expect(uninstalled).toBe('0 6 * * * /usr/bin/ok\n');
  });

  it('never swallows an unrelated line: all foreign lines survive the install', () => {
    const lines = [
      'MAILTO=me@example.com',
      '0 6 * * * /usr/bin/backup-home 2>&1',
      '# a human comment',
      '',
      '30 2 * * * /usr/bin/nightly-job',
    ];
    const before = lines.join('\n');
    const after = installBlock(before, buildManagedBlock(SPEC));
    for (const l of lines.filter((x) => x.length > 0)) {
      expect(after).toContain(l);
    }
  });
});

describe('uninstallBlock', () => {
  it('removes only the managed block and leaves foreign lines alone', () => {
    const foreign = '0 6 * * * /usr/bin/backup-home\n';
    const installed = installBlock(foreign, buildManagedBlock(SPEC));
    const removed = uninstallBlock(installed);
    expect(removed).toBe(foreign);
    expect(removed).not.toContain(SCHEDULE_BEGIN);
  });

  it('is a no-op when no block is installed', () => {
    expect(uninstallBlock('')).toBe('');
    expect(uninstallBlock('0 6 * * * /usr/bin/x\n')).toBe('0 6 * * * /usr/bin/x\n');
  });

  it('refuses a corrupt block unless forced', () => {
    const corrupt = halfBlock(2);
    expect(() => uninstallBlock(corrupt)).toThrow(/corrupt.*--force/);
    expect(uninstallBlock(corrupt, { force: true })).toBe('');
  });

  it('--force on a dangling BEGIN keeps foreign jobs above AND below', () => {
    const corrupt =
      `0 6 * * * /usr/bin/above\n` +
      halfBlock(4) +
      `0 7 * * * /usr/bin/below\n`;
    const removed = uninstallBlock(corrupt, { force: true });
    expect(removed).toContain('0 6 * * * /usr/bin/above');
    expect(removed).toContain('0 7 * * * /usr/bin/below');
    expect(removed).not.toContain(SCHEDULE_BEGIN);
  });

  it('never swallows or multiplies: foreign lines survive, markers are gone', () => {
    const foreign = 'MAILTO=x@y\n0 6 * * * /usr/bin/x\n# comment\n';
    const installed = installBlock(foreign, buildManagedBlock(SPEC));
    const removed = uninstallBlock(installed);
    for (const l of ['MAILTO=x@y', '0 6 * * * /usr/bin/x', '# comment']) {
      expect(removed).toContain(l);
    }
    expect(removed.split(SCHEDULE_BEGIN)).toHaveLength(1);
    expect(removed.split(SCHEDULE_END)).toHaveLength(1);
  });
});

describe('findAmbientEnvDecls', () => {
  it('spots ambient cron env declarations among foreign lines', () => {
    expect(findAmbientEnvDecls(['MAILTO=me@example.com', '0 6 * * * /usr/bin/x'])).toEqual([
      'MAILTO',
    ]);
    expect(
      findAmbientEnvDecls(['  PATH=/usr/local/bin:/usr/bin', 'TZ=Europe/Madrid', '# PATH=x']),
    ).toEqual(['PATH', 'TZ']);
    expect(findAmbientEnvDecls(['0 6 * * * /usr/bin/x', '# a comment'])).toEqual([]);
  });
});

describe('describeSchedule', () => {
  it('reports not-installed, matching, and differing states', () => {
    const block = buildManagedBlock(SPEC);
    expect(describeSchedule('', block).installed).toBe(false);

    const installed = installBlock('', block);
    const match = describeSchedule(installed, block);
    expect(match).toMatchObject({ installed: true, matches: true });

    const other = buildManagedBlock({ ...SPEC, repoRoot: '/somewhere/else' });
    const diff = describeSchedule(installed, other);
    expect(diff).toMatchObject({ installed: true, matches: false });
    expect(diff.current.length).toBeGreaterThan(0);
  });
});

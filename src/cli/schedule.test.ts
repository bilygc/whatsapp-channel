import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cmdInstall,
  cmdList,
  cmdUninstall,
  defaultWriteBackup,
  ensureLogsDir,
  findFlockBin,
  findTsxMjs,
  isKnownEmptyCrontabError,
  MAX_CRONTAB_BACKUPS,
  resolveCronSpec,
  type CrontabIo,
  type InstallHooks,
} from './schedule.js';
import {
  SCHEDULE_BEGIN,
  SCHEDULE_END,
  buildManagedBlock,
  installBlock,
  type CronSpec,
} from '../schedule/crontab.js';

const SPEC: CronSpec = {
  repoRoot: '/home/user/whatsapp-channel',
  nodeBin: '/usr/local/bin/node',
  tsxMjs: '/home/user/whatsapp-channel/node_modules/tsx/dist/cli.mjs',
  flockBin: '/usr/bin/flock',
};

/** Deterministic clock (2026-10-19T08:00:00Z) + captured backup writes. */
function testHooks(): InstallHooks & { backups: Array<{ path: string; content: string }> } {
  const backups: Array<{ path: string; content: string }> = [];
  return {
    backups,
    now: () => new Date('2026-10-19T08:00:00.000Z'),
    writeBackup: (filePath: string, content: string) => {
      backups.push({ path: filePath, content });
    },
  };
}

function fakeIo(initial = ''): CrontabIo & { writes: string[] } {
  let current = initial;
  const writes: string[] = [];
  return {
    writes,
    read: () => current,
    write: (text: string) => {
      writes.push(text);
      current = text;
    },
  };
}

describe('schedule commands (fake crontab IO — never touches the real crontab)', () => {
  it('install writes exactly two entries in ONE marker block, then reports up-to-date', () => {
    const io = fakeIo('0 6 * * * /usr/bin/backup-home\n');
    const hooks = testHooks();
    const first = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(first.exitCode).toBe(0);
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0]).toContain('0 6 * * * /usr/bin/backup-home');
    expect(io.writes[0].split(SCHEDULE_BEGIN)).toHaveLength(2);
    expect(io.writes[0].split(SCHEDULE_END)).toHaveLength(2);
    expect(io.writes[0]).toContain('src/cli/fetch.ts');
    expect(io.writes[0]).toContain('src/cli/deliver.ts');
    // Deliver entry carries the flock single-instance guard.
    expect(io.writes[0]).toContain(`'/usr/bin/flock' -n`);
    expect(io.writes[0]).toContain('deliver.lock');

    const second = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(second.exitCode).toBe(0);
    expect(second.output).toMatch(/already installed/);
    expect(io.writes).toHaveLength(1);
  });

  it('backs up the pre-write crontab (0o700 name in the message) and read-back-verifies', () => {
    const io = fakeIo('0 6 * * * /usr/bin/backup-home\n');
    const hooks = testHooks();
    const result = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(result.exitCode).toBe(0);
    expect(hooks.backups).toHaveLength(1);
    expect(hooks.backups[0].content).toBe('0 6 * * * /usr/bin/backup-home\n');
    expect(hooks.backups[0].path).toContain('logs/crontab.before-');
    expect(hooks.backups[0].path.endsWith('.bak')).toBe(true);
    expect(result.output).toContain(hooks.backups[0].path);
  });

  it('fails post-write verification when the re-read block differs (never silent)', () => {
    // A crontab IO whose writes vanish (spool error, concurrent edit): the
    // re-read sees the old text, so install must fail LOUDLY.
    const io: CrontabIo = { read: () => '', write: () => {} };
    const result = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/post-write verification failed/);
  });

  it('fails post-write verification when the re-read block is stale (installed but not matching)', () => {
    // The write lands, but a concurrent edit replaced our block with a stale
    // spec before the re-read: installed is true, matches is false.
    const stale = installBlock('', buildManagedBlock({ ...SPEC, repoRoot: '/somewhere/else' }));
    let reads = ['', stale];
    const writes: string[] = [];
    const io: CrontabIo = {
      read: () => reads.shift() ?? '',
      write: (text: string) => {
        writes.push(text);
      },
    };
    const result = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    expect(writes).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/post-write verification failed/);
  });

  it('fails post-write verification when a foreign line went missing after the write', () => {
    const before = '0 6 * * * /usr/bin/backup-home\n';
    const blockOnly = buildManagedBlock(SPEC);
    let reads = [before, blockOnly];
    const io: CrontabIo = {
      read: () => reads.shift() ?? '',
      write: () => {},
    };
    const result = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    // The block itself matches, but the foreign line vanished in flight.
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/foreign line.*missing|\bforeign\b.*lost/i);
    expect(result.output).toContain('/usr/bin/backup-home');
  });

  it('install replaces a stale managed block in place (spec upgrade), foreign exactly once', () => {
    const staleSpec: CronSpec = { ...SPEC, repoRoot: '/old/repo' };
    const before = `0 6 * * * /usr/bin/backup-home\n${installBlock('', buildManagedBlock(staleSpec))}`;
    const io = fakeIo(before);
    const hooks = testHooks();
    const result = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(result.exitCode).toBe(0);
    expect(io.writes).toHaveLength(1);
    const out = io.writes[0];
    // Foreign line preserved verbatim, exactly once (split-count, not just contains).
    expect(out.split('/usr/bin/backup-home')).toHaveLength(2);
    expect(out.split(SCHEDULE_BEGIN)).toHaveLength(2);
    expect(out.split(SCHEDULE_END)).toHaveLength(2);
    expect(out).toContain(SPEC.repoRoot);
    expect(out).not.toContain('/old/repo');
  });

  it('install refuses a duplicate-marker block without force (never writes, never backs up)', () => {
    const dup = `${SCHEDULE_BEGIN}\n${SCHEDULE_BEGIN}\n${SCHEDULE_END}\n0 6 * * * /usr/bin/x\n`;
    const io = fakeIo(dup);
    const hooks = testHooks();
    const refused = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toMatch(/duplicate markers/);
    expect(io.writes).toHaveLength(0);
    expect(hooks.backups).toHaveLength(0);
  });

  it('install --dry-run prints the resulting crontab without writing or backing up', () => {
    const io = fakeIo('');
    const hooks = testHooks();
    const result = cmdInstall(io, SPEC, { dryRun: true }, () => {}, hooks);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(SCHEDULE_BEGIN);
    expect(result.output).toContain('*/15 * * * *');
    expect(io.writes).toHaveLength(0);
    expect(hooks.backups).toHaveLength(0);
  });

  it('install refuses a corrupt block unless forced (never writes, never backs up)', () => {
    const corrupt = `${SCHEDULE_BEGIN}\n*/15 * * * * half-written\n`;
    const io = fakeIo(corrupt);
    const hooks = testHooks();
    const refused = cmdInstall(io, SPEC, {}, () => {}, hooks);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toMatch(/corrupt.*--force/);
    expect(io.writes).toHaveLength(0);
    expect(hooks.backups).toHaveLength(0);

    const repaired = cmdInstall(io, SPEC, { force: true }, () => {}, hooks);
    expect(repaired.exitCode).toBe(0);
    expect(io.writes).toHaveLength(1);
    expect(hooks.backups).toHaveLength(1);
    expect(hooks.backups[0].content).toBe(corrupt);
  });

  it('install surfaces a missing `crontab` binary as a typed error', () => {
    const io: CrontabIo = {
      read: () => {
        throw new Error('schedule failed: `crontab` binary not found — install cron.');
      },
      write: () => {},
    };
    const result = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/crontab.*not found/);
  });

  it('install warns about foreign ambient env declarations (and emits none of its own)', () => {
    const io = fakeIo('MAILTO=ops@example.com\nPATH=/weird/bin\n0 6 * * * /usr/bin/x\n');
    const result = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/warning.*MAILTO.*PATH/);
    // Our own block sets no env: no bare `NAME=` lines inside the markers.
    const block = io.writes[0].split(SCHEDULE_BEGIN)[1].split(SCHEDULE_END)[0];
    for (const line of block.split('\n')) {
      expect(line).not.toMatch(/^\s*(CRON_TZ|TZ|SHELL|MAILTO|PATH|HOME)\s*=/);
    }
  });

  it('install --no-lock emits a plain deliver entry with a warning', () => {
    const noLock: CronSpec = { ...SPEC, flockBin: null };
    const io = fakeIo('');
    const result = cmdInstall(io, noLock, { noLock: true }, () => {}, testHooks());
    expect(result.exitCode).toBe(0);
    expect(io.writes[0]).not.toContain('flock');
    expect(io.writes[0]).toContain('src/cli/deliver.ts');
    expect(result.output).toMatch(/warning.*WITHOUT the flock/);
  });

  it('list reports not-installed, up-to-date, and differing states', () => {
    expect(cmdList(fakeIo(''), SPEC).output).toMatch(/not installed/);

    const io2 = fakeIo();
    cmdInstall(io2, SPEC, {}, () => {}, testHooks());
    const upToDate = cmdList({ read: () => io2.writes[0], write: () => {} }, SPEC);
    expect(upToDate.output).toMatch(/up to date/);
    expect(upToDate.output).toContain('src/cli/deliver.ts');

    const stale = { ...SPEC, repoRoot: '/somewhere/else' };
    const differs = cmdList({ read: () => io2.writes[0], write: () => {} }, stale);
    expect(differs.output).toMatch(/DIFFERS/);
    expect(differs.output).toContain('/somewhere/else');
  });

  it('list warns about foreign ambient env declarations', () => {
    const io = fakeIo('TZ=Europe/Madrid\n');
    const installed = cmdInstall(io, SPEC, {}, () => {}, testHooks());
    expect(installed.exitCode).toBe(0);
    const listed = cmdList({ read: () => io.writes[0], write: () => {} }, SPEC);
    expect(listed.output).toMatch(/warning.*TZ/);
  });

  it('uninstall removes only the block (with backup); no-op when absent; dry-run writes nothing', () => {
    const io = fakeIo('');
    cmdInstall(io, SPEC, {}, () => {}, testHooks());
    const withForeign = `0 6 * * * /usr/bin/x\n${io.writes[0]}`;
    const io2 = fakeIo(withForeign);

    const dry = cmdUninstall(io2, { dryRun: true }, SPEC);
    expect(dry.exitCode).toBe(0);
    expect(dry.output).toContain('0 6 * * * /usr/bin/x');
    expect(dry.output).not.toContain(SCHEDULE_BEGIN);

    const hooks = testHooks();
    const real = cmdUninstall(io2, {}, SPEC, () => {}, hooks);
    expect(real.exitCode).toBe(0);
    expect(real.output).toMatch(/removed/);
    expect(real.output).toContain(hooks.backups[0].path);
    expect(io2.writes).toHaveLength(1);

    const noop = cmdUninstall(fakeIo('0 6 * * * /usr/bin/x\n'));
    expect(noop.output).toMatch(/nothing installed/);
  });

  it('uninstall fails post-write verification when a marker survives', () => {
    const installed = installBlockForTest();
    // Writes succeed but vanish (read always returns the installed text).
    const io: CrontabIo = { read: () => installed, write: () => {} };
    const result = cmdUninstall(io, {}, SPEC, () => {}, testHooks());
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/post-write verification failed/);
  });

  it('uninstall refuses a corrupt block unless forced', () => {
    const corrupt = `${SCHEDULE_END}\n`;
    expect(cmdUninstall(fakeIo(corrupt)).exitCode).toBe(1);
    const io = fakeIo(corrupt);
    expect(cmdUninstall(io, { force: true }, SPEC, () => {}, testHooks()).exitCode).toBe(0);
    expect(io.writes[0]).not.toContain(SCHEDULE_END);
  });

  it('a throwing logs-dir creation surfaces as a typed error, exit 1', () => {
    const io = fakeIo('');
    const result = cmdInstall(io, SPEC, {}, () => {
      throw new Error('EACCES: permission denied');
    }, testHooks());
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/could not create logs dir/);
    expect(io.writes).toHaveLength(0);
  });

  it('a throwing backup surfaces as a typed error and writes nothing', () => {
    const io = fakeIo('');
    const result = cmdInstall(io, SPEC, {}, () => {}, {
      now: () => new Date(),
      writeBackup: () => {
        throw new Error('EROFS: read-only file system');
      },
    });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.output).toMatch(/could not back up/);
    expect(io.writes).toHaveLength(0);
  });

  it('a throwing write surfaces as a typed error, exit 1', () => {
    const write = vi.fn(() => {
      throw new Error('schedule failed: could not install crontab: boom');
    });
    const result = cmdInstall({ read: () => '', write }, SPEC, {}, () => {}, testHooks());
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.output).toMatch(/could not install crontab/);
  });
});

describe('backup exclusivity + rotation (real temp dir — never the real crontab)', () => {
  it('creates the backup exclusive (wx): a same-second collision gets a suffixed name, never an overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-backup-'));
    try {
      const target = path.join(dir, 'crontab.before-100.bak');
      fs.writeFileSync(target, 'original');
      const actual = defaultWriteBackup(target, 'new-content');
      expect(actual).not.toBe(target);
      expect(actual).toMatch(/crontab\.before-100-\d+\.bak$/);
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(fs.readFileSync(actual, 'utf8')).toBe('new-content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates backups to the last 10 (oldest pruned, newest kept)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-backup-'));
    try {
      // Fixed-width epoch names (like the real `crontab.before-<epoch>.bak`)
      // so lexicographic order is chronological order.
      for (let i = 0; i < MAX_CRONTAB_BACKUPS + 2; i++) {
        const name = `crontab.before-${String(i).padStart(10, '0')}.bak`;
        fs.writeFileSync(path.join(dir, name), `backup ${i}`);
      }
      const newest = path.join(dir, `crontab.before-${String(99).padStart(10, '0')}.bak`);
      defaultWriteBackup(newest, 'newest');
      const remaining = fs
        .readdirSync(dir)
        .filter((f) => /^crontab\.before-.*\.bak$/.test(f))
        .sort();
      expect(remaining).toHaveLength(MAX_CRONTAB_BACKUPS);
      expect(remaining).toContain(path.basename(newest));
      expect(remaining).not.toContain(`crontab.before-${String(0).padStart(10, '0')}.bak`);
      expect(remaining).not.toContain(`crontab.before-${String(1).padStart(10, '0')}.bak`);
      expect(fs.readFileSync(path.join(dir, path.basename(newest)), 'utf8')).toBe('newest');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function installBlockForTest(): string {
  return installBlock('', buildManagedBlock(SPEC));
}

describe('empty-crontab classification (no real crontab touched)', () => {
  function execError(status: unknown, stderr: string, message: string): unknown {
    const err = new Error(message) as Error & { status?: unknown; stderr?: string };
    err.status = status;
    err.stderr = stderr;
    return err;
  }

  it('treats ONLY exit-1 + "no crontab for" as the empty state', () => {
    expect(
      isKnownEmptyCrontabError(execError(1, '', 'Command failed: crontab -l\nNo crontab for ana')),
    ).toBe(true);
  });

  it('surfaces exit-2 (permission/broken spool) as a real failure even with matching stderr', () => {
    expect(
      isKnownEmptyCrontabError(execError(2, 'No crontab for ana', 'Command failed: crontab -l')),
    ).toBe(false);
  });

  it('surfaces exit-1 with unrelated stderr as a real failure', () => {
    expect(
      isKnownEmptyCrontabError(execError(1, 'permission denied', 'Command failed: crontab -l')),
    ).toBe(false);
  });

  it('surfaces errors without a status code as real failures', () => {
    expect(isKnownEmptyCrontabError(new Error('No crontab for ana'))).toBe(false);
    expect(isKnownEmptyCrontabError(null)).toBe(false);
  });
});

describe('flock resolution (injectable lookup — never touches PATH)', () => {
  const noUsrBinFlock = () => false;
  const hasUsrBinFlock = () => true;

  it('prefers /usr/bin/flock when it exists (lookup never consulted)', () => {
    const lookup = () => {
      throw new Error('must not be called');
    };
    expect(findFlockBin(lookup, hasUsrBinFlock)).toBe('/usr/bin/flock');
  });

  it('falls back to the PATH lookup when /usr/bin/flock is absent', () => {
    expect(findFlockBin(() => '/from/path/flock', noUsrBinFlock)).toBe('/from/path/flock');
  });

  it('returns null when flock is absent everywhere', () => {
    expect(findFlockBin(() => null, noUsrBinFlock)).toBeNull();
    expect(
      findFlockBin(
        () => {
          throw new Error('command -v failed');
        },
        noUsrBinFlock,
      ),
    ).toBeNull();
  });

  it('resolveCronSpec fails closed without flock unless --no-lock skips with a null guard', () => {
    // A hermetic repoRoot carrying a stub tsx entry: the tsx check passes so
    // the test actually exercises the flock gate (a bare '/repo' would fail
    // on the missing tsx entry first and never reach the flock check).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-flock-'));
    try {
      const stub = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.writeFileSync(stub, '');
      expect(() =>
        resolveCronSpec(root, '/usr/bin/node', {
          flockLookup: () => null,
          flockExists: noUsrBinFlock,
        }),
      ).toThrow(/flock.*not found.*--no-lock/);
      const spec = resolveCronSpec(root, '/usr/bin/node', {
        noLock: true,
        flockLookup: () => null,
        flockExists: noUsrBinFlock,
      });
      expect(spec.flockBin).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureLogsDir (filesystem boundary)', () => {
  it('creates a missing dir with 0o700', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logs-'));
    const dir = path.join(parent, 'logs');
    ensureLogsDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('chmods an existing dir to 0o700', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logs-'));
    fs.chmodSync(parent, 0o755);
    ensureLogsDir(parent);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a path that exists as a file', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logs-'));
    const file = path.join(parent, 'logs');
    fs.writeFileSync(file, 'x');
    expect(() => ensureLogsDir(file)).toThrow(/not a directory/);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a symlink to a non-directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logs-'));
    const file = path.join(parent, 'target-file');
    const link = path.join(parent, 'logs');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(file, link);
    expect(() => ensureLogsDir(link)).toThrow(/symlink to a non-directory/);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('accepts a symlink to a directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-logs-'));
    const target = path.join(parent, 'real-logs');
    fs.mkdirSync(target);
    const link = path.join(parent, 'logs');
    fs.symlinkSync(target, link);
    expect(() => ensureLogsDir(link)).not.toThrow();
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('spec resolution (filesystem boundary)', () => {
  it('resolves the repo spec against the real checkout (tsx present)', () => {
    const realFlock = findFlockBin();
    const spec = resolveCronSpec(undefined, undefined, {
      noLock: realFlock === null,
    });
    expect(spec.repoRoot.endsWith('whatsapp-channel')).toBe(true);
    expect(spec.tsxMjs).toBe(`${spec.repoRoot}/node_modules/tsx/dist/cli.mjs`);
    expect(buildManagedBlock(spec)).toContain('src/cli/fetch.ts');
  });

  it('refuses with a typed error when the tsx entry is missing', () => {
    expect(() => findTsxMjs('/nonexistent-root-xyz')).toThrow(/tsx entry not found.*npm install/);
  });

  it('refuses a relative repoRoot with a typed error', () => {
    expect(() => resolveCronSpec('relative/path', '/usr/bin/node')).toThrow(/must be absolute/);
  });
});

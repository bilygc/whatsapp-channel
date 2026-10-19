#!/usr/bin/env tsx
/**
 * `npm run scheduleInstall` / `scheduleList` / `scheduleUninstall` — idempotent
 * user-crontab manager for the repo's automation (M5):
 * - fetch every 15 minutes (plan spec),
 * - deliver at 08:55, 13:55 and 18:55 server-local time (five minutes before
 *   the 9/14/19h posting windows), guarded by `flock -n` so overlapping
 *   runs never double-send.
 *
 * The installer owns exactly ONE marked block (see `src/schedule/crontab.ts`);
 * user-owned lines are never touched. Cron entries `cd` to the repo root
 * first (dotenv reads `./.env`, SQLite defaults to `./data/…`) and call
 * absolute node + pinned tsx paths, so cron's minimal PATH needs nothing.
 * Usage:
 *   npm run scheduleInstall [-- --dry-run] [--force] [--no-lock]
 *   npm run scheduleList
 *   npm run scheduleUninstall [-- --dry-run] [--force]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManagedBlock,
  describeSchedule,
  findAmbientEnvDecls,
  installBlock,
  isManagedLine,
  SCHEDULE_BEGIN,
  SCHEDULE_END,
  uninstallBlock,
  type CronSpec,
} from '../schedule/crontab.js';

/** Runnable seam around the real `crontab` binary — injected fakes keep tests hermetic. */
export interface CrontabIo {
  read(): string;
  write(text: string): void;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Budget for every `crontab` subprocess call: a stuck cron spool must not hang the CLI. */
const CRONTAB_TIMEOUT_MS = 10_000;

/**
 * True only for the NORMAL empty state: `crontab -l` exits 1 AND stderr says
 * `no crontab for <user>`. Any other failure (exit 2, permission denied, a
 * broken spool file) is a real typed failure — the old code treated every
 * message matching /no crontab for/ as empty, hiding genuine breakage.
 * Exported for unit tests (the real `crontab` binary is never touched there).
 */
export function isKnownEmptyCrontabError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 1) return false;
  const stderr =
    typeof (err as { stderr?: unknown }).stderr === 'string'
      ? ((err as { stderr?: string }).stderr as string)
      : '';
  return /no crontab for/i.test(`${stderr}\n${errText(err)}`);
}

export function realCrontabIo(): CrontabIo {
  return {
    read(): string {
      try {
        // Silence the child's stderr: `crontab -l` complains loudly about a
        // missing crontab on stderr, and that is a normal empty state for us.
        return execFileSync('crontab', ['-l'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: CRONTAB_TIMEOUT_MS,
        }) as string;
      } catch (err) {
        if (isKnownEmptyCrontabError(err)) return '';
        if (isEnoent(err)) {
          throw new Error(
            'schedule failed: `crontab` binary not found — install cron ' +
              '(e.g. `sudo apt install cron`) and retry.',
          );
        }
        throw new Error(`schedule failed: could not read crontab: ${errText(err)}`);
      }
    },
    write(text: string): void {
      try {
        execFileSync('crontab', ['-'], {
          input: text,
          timeout: CRONTAB_TIMEOUT_MS,
        });
      } catch (err) {
        if (isEnoent(err)) {
          throw new Error(
            'schedule failed: `crontab` binary not found — install cron ' +
              '(e.g. `sudo apt install cron`) and retry.',
          );
        }
        throw new Error(`schedule failed: could not install crontab: ${errText(err)}`);
      }
    },
  };
}

/** Absolute tsx entry cron will exec — fails closed when deps aren't installed. */
export function findTsxMjs(repoRoot: string): string {
  const tsxMjs = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxMjs)) {
    throw new Error(
      `schedule failed: tsx entry not found at ${tsxMjs} — run \`npm install\` first.`,
    );
  }
  return tsxMjs;
}

/**
 * Resolve the absolute flock binary for the deliver single-instance guard:
 * the pinned `/usr/bin/flock` first, then whatever `command -v flock` finds
 * at install time. Returns `null` when flock is absent. `lookup` is the
 * injectable seam (tests never touch PATH); production uses `sh -c
 * 'command -v flock'` because `command` is a shell builtin.
 */
export function findFlockBin(
  lookup?: (command: string) => string | null,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  if (exists('/usr/bin/flock')) return '/usr/bin/flock';
  try {
    const found =
      lookup !== undefined
        ? lookup('flock')
        : (execFileSync('sh', ['-c', 'command -v flock'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: CRONTAB_TIMEOUT_MS,
          }) as string);
    if (typeof found === 'string' && found.trim() !== '') {
      return found.trim().split('\n')[0];
    }
  } catch {
    // No flock on PATH (or no shell) — caller decides (fail-closed vs --no-lock).
  }
  return null;
}

/** Resolve the desired spec: repo root from this file's location, node from the running binary. */
export function resolveCronSpec(
  repoRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  nodeBin: string = process.execPath,
  opts: {
    noLock?: boolean;
    flockLookup?: (command: string) => string | null;
    flockExists?: (p: string) => boolean;
  } = {},
): CronSpec {
  for (const [name, value] of [
    ['repoRoot', repoRoot],
    ['nodeBin', nodeBin],
  ] as const) {
    if (!path.isAbsolute(value)) {
      throw new Error(
        `schedule failed: ${name} must be absolute (got ${JSON.stringify(value)}).`,
      );
    }
  }
  const tsxMjs = findTsxMjs(repoRoot);
  if (!path.isAbsolute(tsxMjs)) {
    throw new Error(`schedule failed: tsx entry must be absolute (got ${JSON.stringify(tsxMjs)}).`);
  }
  const flockBin = findFlockBin(opts.flockLookup, opts.flockExists);
  if (flockBin === null && !opts.noLock) {
    throw new Error(
      'schedule failed: `flock` not found (looked for /usr/bin/flock and `command -v flock`) — ' +
        'the deliver entry needs it so overlapping runs never double-send. ' +
        'Install util-linux flock, or re-run with --no-lock to install unguarded (with a warning).',
    );
  }
  return { repoRoot, nodeBin, tsxMjs, flockBin: opts.noLock ? null : flockBin };
}

export interface CommandResult {
  output: string;
  exitCode: number;
}

export interface InstallFlags {
  dryRun?: boolean;
  force?: boolean;
  /** Install the deliver entry WITHOUT the flock guard (warns; overlapping runs may double-send). */
  noLock?: boolean;
}

/** Seams for hermetic tests: clock for the backup name, writer for the backup file. */
export interface InstallHooks {
  now?: () => Date;
  /**
   * Write the pre-write backup. Runs EXCLUSIVE (`wx` in the default): a
   * same-second collision gets a suffixed name, never an overwrite. May
   * return the actual path written (defaults to the requested path).
   */
  writeBackup?: (filePath: string, content: string) => string | void;
}

/** How many `crontab.before-*.bak` files the logs dir keeps — older ones are pruned. */
export const MAX_CRONTAB_BACKUPS = 10;

/** Backup filename pattern (also matched with a `-<n>` same-second suffix). */
const BACKUP_BASENAME_RE = /^crontab\.before-.*\.bak$/;

function fail(message: string): CommandResult {
  return { output: message, exitCode: 1 };
}

/** Default `ensureDir`: create the logs dir (0o700), refuse files/symlink-to-non-dir. */
export function ensureLogsDir(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch (mkdirErr) {
        throw new Error(
          `schedule failed: could not create logs dir ${dir}: ${errText(mkdirErr)}`,
        );
      }
      return;
    }
    throw new Error(`schedule failed: could not inspect logs dir ${dir}: ${errText(err)}`);
  }
  if (st.isSymbolicLink()) {
    // A symlink is only acceptable when it resolves to a directory — a link
    // to a file (or a dangling link) would redirect cron logs somewhere
    // unexpected. Target permissions are left alone.
    let target: fs.Stats;
    try {
      target = fs.statSync(dir);
    } catch {
      throw new Error(
        `schedule failed: logs dir ${dir} is a dangling symlink — refusing to use it.`,
      );
    }
    if (!target.isDirectory()) {
      throw new Error(
        `schedule failed: logs dir ${dir} is a symlink to a non-directory — refusing to use it.`,
      );
    }
    return;
  }
  if (!st.isDirectory()) {
    throw new Error(
      `schedule failed: logs path ${dir} exists and is not a directory — refusing to use it.`,
    );
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new Error(`schedule failed: could not chmod logs dir ${dir}: ${errText(err)}`);
  }
}

export function defaultWriteBackup(filePath: string, content: string): string {
  // Exclusive-create: a same-second reinstall attempt (clock granularity is
  // one second) must never silently overwrite the previous backup. On
  // collision, suffix `-1`, `-2`, … — the rotation glob still matches those.
  let actual = filePath;
  for (let n = 0; ; n++) {
    try {
      fs.writeFileSync(actual, content, { mode: 0o700, flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST' && n < 100) {
        actual = filePath.replace(/\.bak$/, `-${n + 1}.bak`);
        continue;
      }
      throw new Error(
        `schedule failed: could not back up current crontab to ${filePath}: ${errText(err)}`,
      );
    }
  }
  try {
    fs.chmodSync(actual, 0o700);
  } catch (err) {
    throw new Error(
      `schedule failed: could not back up current crontab to ${actual}: ${errText(err)}`,
    );
  }
  // Hygiene, never fatal: a pruning failure must not fail the install.
  pruneCrontabBackups(path.dirname(actual));
  return actual;
}

/**
 * Keep only the newest MAX_CRONTAB_BACKUPS `crontab.before-*.bak` files in
 * `dir` (epoch names sort chronologically). Best-effort: failures warn and
 * the install continues.
 */
export function pruneCrontabBackups(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    console.warn(`schedule: warning: could not list backups in ${dir}: ${errText(err)}`);
    return;
  }
  const backups = entries.filter((f) => BACKUP_BASENAME_RE.test(f)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - MAX_CRONTAB_BACKUPS));
  for (const name of excess) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      console.warn(`schedule: warning: could not prune old backup ${name}: ${errText(err)}`);
    }
  }
}

/** Foreign lines of the current crontab: everything outside our marker pair. */
function foreignOf(current: string): string[] {
  const lines = current === '' ? [] : current.split('\n');
  const beginIdx = lines.indexOf(SCHEDULE_BEGIN);
  const endIdx = lines.indexOf(SCHEDULE_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return lines;
  return [...lines.slice(0, beginIdx), ...lines.slice(endIdx + 1)];
}

/** Non-blank FOREIGN lines of the current crontab: outside our markers and not owned by us. */
function foreignNonBlank(current: string): string[] {
  return foreignOf(current).filter((l) => l.trim() !== '' && !isManagedLine(l));
}

/**
 * Post-write IO check: every foreign line present before the write must
 * still be present after it. The pure-function layer (installBlock /
 * uninstallBlock) already refuses to swallow foreign lines — this catches
 * the round-trip instead (spool error, concurrent `crontab` edit between
 * our write and re-read). Throws a typed error naming the backup.
 */
function assertForeignSurvived(beforeForeign: string[], reread: string, backupNote: string): void {
  const after = new Set(reread.split('\n'));
  const lost = beforeForeign.filter((l) => !after.has(l));
  if (lost.length > 0) {
    throw new Error(
      `schedule failed: post-write verification failed — ${lost.length} foreign line(s) ` +
        `missing after the write (${backupNote}); inspect \`crontab -l\` by hand:\n` +
        lost.map((l) => `  lost: ${l}`).join('\n'),
    );
  }
}

/** Warning lines when foreign ambient env declarations apply to our entries too. */
function ambientEnvWarnings(current: string): string[] {
  const names = findAmbientEnvDecls(foreignOf(current));
  if (names.length === 0) return [];
  return [
    `schedule: warning: your crontab sets ${names.join(', ')} — cron applies these to ` +
      'EVERY entry below them, including our managed block. We intentionally emit no env lines ' +
      'of our own; if a run behaves oddly (timezone, PATH, mail), check these first.',
  ];
}

function lockWarning(spec: CronSpec): string[] {
  if (spec.flockBin === null) {
    return [
      'schedule: warning: installed WITHOUT the flock single-instance guard (--no-lock) — ' +
        'overlapping deliver runs may double-send drafts and double-spend LLM calls.',
    ];
  }
  return [];
}

export function cmdInstall(
  io: CrontabIo,
  spec: CronSpec,
  flags: InstallFlags = {},
  ensureDir: (dir: string) => void = ensureLogsDir,
  hooks: InstallHooks = {},
): CommandResult {
  let current: string;
  try {
    current = io.read();
  } catch (err) {
    return fail(errText(err));
  }
  let next: string;
  let block: string;
  try {
    block = buildManagedBlock(spec);
  } catch (err) {
    return fail(errText(err));
  }
  try {
    next = installBlock(current, block, { force: flags.force });
  } catch (err) {
    return fail(errText(err));
  }
  const warnings = [...ambientEnvWarnings(current), ...lockWarning(spec)];
  const withWarnings = (output: string): string =>
    warnings.length > 0 ? `${output}\n${warnings.join('\n')}` : output;
  if (flags.dryRun) {
    return { output: withWarnings(next), exitCode: 0 };
  }
  if (next === current) {
    return {
      output: withWarnings('schedule: already installed and up to date (no changes).'),
      exitCode: 0,
    };
  }
  try {
    ensureDir(path.join(spec.repoRoot, 'logs'));
  } catch (err) {
    return fail(
      `schedule failed: could not create logs dir ${path.join(spec.repoRoot, 'logs')}: ${errText(err)}`,
    );
  }
  // Pre-write backup: the exact bytes we are about to replace, so a bad
  // install is recoverable by hand (`crontab <backup>`). Exclusive-create:
  // the writer may return a suffixed path on a same-second collision.
  const now = hooks.now ?? (() => new Date());
  const requestedBackupPath = path.join(
    spec.repoRoot,
    'logs',
    `crontab.before-${Math.floor(now().getTime() / 1000)}.bak`,
  );
  let backupPath: string;
  try {
    backupPath =
      (hooks.writeBackup ?? defaultWriteBackup)(requestedBackupPath, current) ?? requestedBackupPath;
  } catch (err) {
    return fail(`schedule failed: could not back up current crontab to ${requestedBackupPath}: ${errText(err)}`);
  }
  try {
    io.write(next);
  } catch (err) {
    return fail(errText(err));
  }
  // Post-write read-back: prove the block landed byte-identical AND every
  // foreign line survived. A silently divergent crontab (spool error,
  // concurrent edit) must fail LOUDLY.
  let reread: string;
  try {
    reread = io.read();
  } catch (err) {
    return fail(`schedule failed: post-write verification failed (could not re-read crontab): ${errText(err)}`);
  }
  const status = describeSchedule(reread, block);
  if (!status.installed || !status.matches) {
    return fail(
      'schedule failed: post-write verification failed — the managed block is missing or ' +
        `differs after install (backup at ${backupPath}); inspect \`crontab -l\` by hand.`,
    );
  }
  try {
    assertForeignSurvived(foreignNonBlank(current), reread, `backup at ${backupPath}`);
  } catch (err) {
    return fail(errText(err));
  }
  return {
    output: withWarnings(
      'schedule: installed 2 entries (fetch */15, deliver 55 8,13,18 server time) — ' +
        `logs at ${spec.repoRoot}/logs/fetch.log and ${spec.repoRoot}/logs/deliver.log. ` +
        `Previous crontab backed up at ${backupPath}.`,
    ),
    exitCode: 0,
  };
}

export function cmdList(io: CrontabIo, spec: CronSpec): CommandResult {
  let current: string;
  try {
    current = io.read();
  } catch (err) {
    return fail(errText(err));
  }
  const status = describeSchedule(current, buildManagedBlock(spec));
  if (!status.installed) {
    const lines = ['schedule: not installed (no managed block in crontab).', ...ambientEnvWarnings(current)];
    return { output: lines.join('\n'), exitCode: 0 };
  }
  const lines = ['schedule: managed entries currently installed:', ...status.current];
  if (status.matches) {
    lines.push('schedule: up to date (matches the desired spec).');
  } else {
    lines.push('schedule: DIFFERS from the desired spec — re-run `npm run scheduleInstall`.');
    lines.push('desired:');
    lines.push(...status.desired);
  }
  lines.push(...ambientEnvWarnings(current), ...lockWarning(spec));
  return { output: lines.join('\n'), exitCode: 0 };
}

export function cmdUninstall(
  io: CrontabIo,
  flags: InstallFlags = {},
  spec?: CronSpec,
  ensureDir: (dir: string) => void = ensureLogsDir,
  hooks: InstallHooks = {},
): CommandResult {
  let current: string;
  try {
    current = io.read();
  } catch (err) {
    return fail(errText(err));
  }
  let next: string;
  try {
    next = uninstallBlock(current, { force: flags.force });
  } catch (err) {
    return fail(errText(err));
  }
  if (next === current) {
    return { output: 'schedule: nothing installed (no managed block in crontab).', exitCode: 0 };
  }
  if (flags.dryRun) {
    return { output: next, exitCode: 0 };
  }
  // Pre-write backup when we know where logs live (same convention as install).
  let backupPath: string | null = null;
  if (spec !== undefined) {
    try {
      ensureDir(path.join(spec.repoRoot, 'logs'));
    } catch (err) {
      return fail(
        `schedule failed: could not create logs dir ${path.join(spec.repoRoot, 'logs')}: ${errText(err)}`,
      );
    }
    const now = hooks.now ?? (() => new Date());
    const requestedBackupPath = path.join(
      spec.repoRoot,
      'logs',
      `crontab.before-${Math.floor(now().getTime() / 1000)}.bak`,
    );
    try {
      backupPath =
        (hooks.writeBackup ?? defaultWriteBackup)(requestedBackupPath, current) ?? requestedBackupPath;
    } catch (err) {
      return fail(`schedule failed: could not back up current crontab to ${requestedBackupPath}: ${errText(err)}`);
    }
  }
  try {
    io.write(next);
  } catch (err) {
    return fail(errText(err));
  }
  // Post-write read-back: the markers must be gone AND every foreign line
  // must have survived the round-trip.
  let reread: string;
  try {
    reread = io.read();
  } catch (err) {
    return fail(`schedule failed: post-write verification failed (could not re-read crontab): ${errText(err)}`);
  }
  if (reread.includes(SCHEDULE_BEGIN) || reread.includes(SCHEDULE_END)) {
    return fail(
      'schedule failed: post-write verification failed — a managed marker survived uninstall' +
        (backupPath !== null ? ` (backup at ${backupPath})` : '') +
        '; inspect `crontab -l` by hand.',
    );
  }
  try {
    assertForeignSurvived(
      foreignNonBlank(current),
      reread,
      backupPath !== null ? `backup at ${backupPath}` : 'no backup was taken (no spec given)',
    );
  } catch (err) {
    return fail(errText(err));
  }
  return {
    output:
      'schedule: managed block removed; user-owned lines left untouched.' +
      (backupPath !== null ? ` Previous crontab backed up at ${backupPath}.` : ''),
    exitCode: 0,
  };
}

function usage(): string {
  return [
    'usage:',
    '  npm run scheduleInstall [-- --dry-run] [--force] [--no-lock]',
    '  npm run scheduleList',
    '  npm run scheduleUninstall [-- --dry-run] [--force]',
    '',
    '  --no-lock  install the deliver entry without the flock single-instance',
    '             guard (only when flock is unavailable; warns).',
  ].join('\n');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags: InstallFlags = {
    dryRun: rest.includes('--dry-run'),
    force: rest.includes('--force'),
    noLock: rest.includes('--no-lock'),
  };
  const unknown = rest.filter((a) => a !== '--dry-run' && a !== '--force' && a !== '--no-lock');
  if (unknown.length > 0 || command === undefined || command === '--help' || command === '-h') {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  let spec: CronSpec;
  try {
    spec = resolveCronSpec(undefined, undefined, { noLock: flags.noLock });
  } catch (err) {
    console.error(errText(err));
    process.exitCode = 1;
    return;
  }
  const io = realCrontabIo();

  let result: CommandResult;
  if (command === 'install') {
    result = cmdInstall(io, spec, flags);
  } else if (command === 'list') {
    result = cmdList(io, spec);
  } else if (command === 'uninstall') {
    result = cmdUninstall(io, flags, spec);
  } else {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  // Failures go to stderr ONLY (exit≠0 → stderr); success to stdout.
  if (result.exitCode === 0) {
    console.log(result.output);
  } else {
    console.error(result.output);
  }
  process.exitCode = result.exitCode;
}

main().catch((err: unknown) => {
  console.error(errText(err));
  process.exitCode = 1;
});

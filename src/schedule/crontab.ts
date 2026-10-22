/**
 * Pure crontab block manager for the repo's automation (M5).
 *
 * The installer owns exactly ONE marked block inside the user's crontab; every
 * other line is foreign and must survive installs/uninstalls verbatim.
 * Everything here is string-in → string-out (no process or filesystem access)
 * so the failure paths are unit-testable — the real `crontab` IO seam lives
 * in `src/cli/schedule.ts` and is injected in tests. The one exception is
 * `path.isAbsolute`, a pure predicate used to validate the spec before
 * emitting anything.
 */

import path from 'node:path';

export const SCHEDULE_BEGIN = '# whatsapp-channel automation: begin (managed — do not edit between markers)';
export const SCHEDULE_END = '# whatsapp-channel automation: end';

/** Fetch cadence (plan spec) and deliver times (server-local, five minutes before the posting windows). */
export const FETCH_CRON = '*/15 * * * *';
export const DELIVER_CRON = '55 8,13,18 * * *';

/** Basename of the deliver single-instance lock file (under `<repo>/logs/`). */
export const DELIVER_LOCK_NAME = 'deliver.lock';

export interface CronSpec {
  /** Absolute repo root (cron entries `cd` here first — see below). */
  repoRoot: string;
  /** Absolute node binary (cron runs with a minimal PATH; nothing is assumed). */
  nodeBin: string;
  /** Absolute tsx entry (`<repo>/node_modules/tsx/dist/cli.mjs`). */
  tsxMjs: string;
  /**
   * Absolute flock binary guarding the deliver entry against overlapping runs
   * (cron fires on wall-clock time and never serializes with itself).
   * `null` = `--no-lock`: the deliver entry runs unguarded (install warns).
   */
  flockBin: string | null;
}

export interface InstallOptions {
  /**
   * Repair instead of refusing: drop the corrupt half-block (or a region with
   * unrecognized lines) and install fresh, keeping every foreign line.
   * Without it, corruption and foreign lines inside the markers refuse.
   */
  force?: boolean;
}

/** Single-quote a shell word (`'` → `'\''` — the only safe escape inside single quotes). */
export function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate the spec BEFORE emitting a single cron line (fail-closed, typed).
 * Cron entries must be one physical line each and need no PATH/cwd, so every
 * path must be absolute and free of control characters (a smuggled `\n`
 * would forge extra crontab lines — a genuine multi-line injection — and `%`
 * is handled by escaping at emission, not by rejection, since it is legal in
 * directory names).
 */
export function assertSpecSane(spec: CronSpec): void {
  const paths: Array<[string, string | null]> = [
    ['repoRoot', spec.repoRoot],
    ['nodeBin', spec.nodeBin],
    ['tsxMjs', spec.tsxMjs],
  ];
  if (spec.flockBin !== null) paths.push(['flockBin', spec.flockBin]);
  for (const [name, value] of paths) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`schedule failed: ${name} must be a non-empty absolute path.`);
    }
    if (!path.isAbsolute(value)) {
      throw new Error(
        `schedule failed: ${name} must be absolute (got ${JSON.stringify(value)}) — ` +
          'cron entries cannot rely on PATH or a working directory.',
      );
    }
    if (/[\x00-\x1F\x7F]/.test(value)) {
      throw new Error(
        `schedule failed: ${name} contains a control character — ` +
          'refusing to emit a cron entry (a newline would forge extra crontab lines).',
      );
    }
  }
}

function entryLine(
  spec: CronSpec,
  cronExpr: string,
  cliRel: string,
  logName: string,
  opts: { lock?: boolean } = {},
): string {
  // `cd <repo> &&` first: dotenv reads `./.env` (process.cwd()) and the SQLite
  // default resolves under `<repo>/data` — cron would otherwise run from $HOME.
  // Absolute node + pinned tsx need no PATH or npm at all.
  // The deliver entry runs under `flock -n <lock>` (AFTER the cd, so the lock
  // path stays short and the redirection still applies to the guarded
  // command): a second cron firing while a deliver is mid-flight exits
  // immediately instead of double-sending drafts and double-spending LLM calls.
  // `%` is cron's newline escape even inside quotes, so every literal `%` in
  // the command portion is backslash-escaped at emission.
  const command =
    `cd ${shq(spec.repoRoot)} && ` +
    (opts.lock && spec.flockBin !== null
      ? `${shq(spec.flockBin)} -n ${shq(`${spec.repoRoot}/logs/${DELIVER_LOCK_NAME}`)} `
      : '') +
    `${shq(spec.nodeBin)} ${shq(spec.tsxMjs)} ${shq(`${spec.repoRoot}/src/cli/${cliRel}`)} ` +
    `>> ${shq(`${spec.repoRoot}/logs/${logName}`)} 2>&1`;
  return `${cronExpr} ${command.replace(/%/g, '\\%')}`;
}

/**
 * Build the desired managed block: the two cron entries plus a descriptor
 * line so `scheduleList` can tell at a glance which spec is installed.
 * Rejects a bad spec (relative path, control characters) with a typed error
 * before emitting anything.
 */
export function buildManagedBlock(spec: CronSpec): string {
  assertSpecSane(spec);
  return [
    SCHEDULE_BEGIN,
    `# spec: fetch=${FETCH_CRON} deliver=${DELIVER_CRON} entrypoint=node+tsx`,
    entryLine(spec, FETCH_CRON, 'fetch.ts', 'fetch.log'),
    entryLine(spec, DELIVER_CRON, 'deliver.ts', 'deliver.log', { lock: true }),
    SCHEDULE_END,
  ].join('\n');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

function assertMarkersSane(
  lines: string[],
  context: string,
): { begin: number; end: number; beginIdx: number; endIdx: number } {
  const begins = lines.filter((l) => l === SCHEDULE_BEGIN).length;
  const ends = lines.filter((l) => l === SCHEDULE_END).length;
  if (begins > 1 || ends > 1) {
    throw new Error(
      `schedule failed: managed block is corrupt (${context}): ` +
        'duplicate markers — re-run with --force to repair.',
    );
  }
  const beginIdx = lines.indexOf(SCHEDULE_BEGIN);
  const endIdx = lines.indexOf(SCHEDULE_END);
  // A reversed pair (END before BEGIN) is corruption, not an empty region:
  // without this check install would splice backwards (duplicating lines)
  // and uninstall would mangle the crontab.
  if (beginIdx !== -1 && endIdx !== -1 && endIdx < beginIdx) {
    throw new Error(
      `schedule failed: managed block markers are reversed (end before begin, ${context}): ` +
        'inspect `crontab -l` by hand, or re-run with --force to repair.',
    );
  }
  return { begin: begins, end: ends, beginIdx, endIdx };
}

/**
 * Lines this tool owns (safe for `--force` repair to drop): the markers, the
 * `# spec:` descriptor, and entry lines carrying our fingerprints (pinned tsx
 * entry + one of our CLI paths). Anything else is foreign, even directly
 * below a dangling BEGIN. Exported for the CLI's post-write verification,
 * which must not mistake a dropped owned line for a lost foreign one.
 */
export function isManagedLine(line: string): boolean {
  if (line === SCHEDULE_BEGIN || line === SCHEDULE_END) return true;
  if (/^# spec: /.test(line)) return true;
  return line.includes('tsx/dist/cli.mjs') && line.includes('src/cli/');
}

/**
 * Lines allowed INSIDE an intact managed region without tripping the
 * unknown-line refusal: the markers, any `# spec:` descriptor, the exact
 * desired entry texts, a stale-but-genuine entry from a previous spec (same
 * fingerprints, e.g. pre-flock — so spec upgrades still replace in place),
 * and blank lines. A foreign cron line smuggled between the markers (human
 * edit, paste accident) is NOT recognized and refuses instead of being
 * silently replaced (install) or swallowed (uninstall) — `--force` is the
 * explicit override for both.
 */
function isRecognizedRegionLine(line: string, desired: Set<string>): boolean {
  if (line === SCHEDULE_BEGIN || line === SCHEDULE_END) return true;
  if (/^# spec: /.test(line)) return true;
  if (desired.has(line)) return true;
  if (
    line.includes('tsx/dist/cli.mjs') &&
    (line.includes('src/cli/fetch.ts') || line.includes('src/cli/deliver.ts'))
  ) {
    return true;
  }
  if (line.trim() === '') return true;
  return false;
}

/** Foreign lines: everything outside the managed block (what we must never swallow). */
function foreignLines(lines: string[], beginIdx: number, endIdx: number): string[] {
  if (beginIdx === -1) return [...lines];
  return [...lines.slice(0, beginIdx), ...lines.slice(endIdx + 1)];
}

/** Throw unless every (non-blank) foreign line is still present in `result`. */
function assertNoForeignLost(foreign: string[], result: string): void {
  const outLines = splitLines(result);
  for (const l of foreign) {
    if (l.trim() === '') continue;
    if (!outLines.includes(l)) {
      throw new Error(`schedule failed: refusing to write — foreign line would be lost: ${l}`);
    }
  }
}

/** Post-condition for installs (never swallow, never multiply) — runs on ALL paths. */
function assertInstallPostcondition(foreign: string[], result: string): void {
  assertNoForeignLost(foreign, result);
  const sane = assertMarkersSane(splitLines(result), 'resulting crontab');
  if (sane.begin !== 1 || sane.end !== 1) {
    throw new Error('schedule failed: refusing to write — marker pair did not survive install.');
  }
}

/** Post-condition for uninstalls (never swallow; the markers must be gone) — runs on ALL paths. */
function assertUninstallPostcondition(foreign: string[], result: string): void {
  assertNoForeignLost(foreign, result);
  const outLines = splitLines(result);
  if (outLines.includes(SCHEDULE_BEGIN) || outLines.includes(SCHEDULE_END)) {
    throw new Error('schedule failed: refusing to write — managed marker survived uninstall.');
  }
}

/** Refuse when the intact region holds lines we did not generate (with a listing). */
function assertRegionKnown(
  lines: string[],
  beginIdx: number,
  endIdx: number,
  desired: Set<string>,
): void {
  const unknown = lines
    .slice(beginIdx, endIdx + 1)
    .filter((l) => !isRecognizedRegionLine(l, desired));
  if (unknown.length > 0) {
    throw new Error(
      'schedule failed: managed block contains unrecognized lines — refusing to replace ' +
        'what we did not generate (inspect `crontab -l` by hand, or re-run with --force ' +
        'to replace the block wholesale):\n' +
        unknown.map((l) => `  unrecognized: ${l}`).join('\n'),
    );
  }
}

/**
 * `--force` install repair: drop every owned line, keep every foreign line in
 * order. For a dangling BEGIN the surviving foreign tail stays AFTER the
 * fresh block (`foreign-above + new block + surviving tail`); every other
 * corrupt shape (stray END, reversed, duplicates) appends the block after the
 * surviving foreign lines.
 */
function repairInstall(foreignAbove: string[], tail: string[], block: string[]): string {
  return joinCrontab([...stripTrailingBlanks([...foreignAbove, ...block]), ...tail]);
}

/**
 * Return `existing` with the managed block installed (replaced in place when
 * present, appended otherwise). Idempotent: installing twice changes nothing.
 * Refuses corrupt marker state or unrecognized lines inside the region unless
 * `force` repairs. Throws a typed `schedule failed: ...` error — never
 * silently drops a foreign line.
 */
export function installBlock(existing: string, block: string, opts: InstallOptions = {}): string {
  const lines = splitLines(existing);
  if (opts.force) {
    // Explicit repair: bypass the strict asserts, drop owned lines only.
    const begins = lines.filter((l) => l === SCHEDULE_BEGIN).length;
    const ends = lines.filter((l) => l === SCHEDULE_END).length;
    const beginIdx = lines.indexOf(SCHEDULE_BEGIN);
    const endIdx = lines.indexOf(SCHEDULE_END);
    if (begins === 1 && ends === 1 && beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
      // Intact pair (possibly holding unrecognized lines): replace the whole
      // region wholesale — unknown lines inside the markers are NOT foreign.
      const foreign = foreignLines(lines, beginIdx, endIdx);
      const result = joinCrontab([
        ...stripTrailingBlanks(foreign.slice(0, beginIdx)),
        ...block.split('\n'),
        ...foreign.slice(beginIdx),
      ]);
      assertInstallPostcondition(foreign, result);
      return result;
    }
    if (beginIdx !== -1 && endIdx === -1) {
      // Dangling BEGIN: foreign-above + new block + surviving (non-ours) tail.
      const above = lines.slice(0, beginIdx);
      const tail = lines.slice(beginIdx + 1).filter((l) => !isManagedLine(l));
      const result = repairInstall(above, tail, block.split('\n'));
      assertInstallPostcondition([...above, ...tail], result);
      return result;
    }
    // Stray END, reversed, or duplicated markers: drop every owned line,
    // keep every foreign line in order, append the fresh block.
    const foreign = lines.filter((l) => !isManagedLine(l));
    const result = joinCrontab([...stripTrailingBlanks(foreign), ...block.split('\n')]);
    assertInstallPostcondition(foreign, result);
    return result;
  }

  const { begin, end, beginIdx, endIdx } = assertMarkersSane(lines, 'existing crontab');
  if ((begin === 1) !== (end === 1)) {
    throw new Error(
      'schedule failed: managed block is corrupt (begin without end or vice versa) — ' +
        'inspect `crontab -l` by hand, or re-run with --force to repair.',
    );
  }

  const foreign = foreignLines(lines, beginIdx, endIdx);
  if (beginIdx !== -1) {
    assertRegionKnown(lines, beginIdx, endIdx, new Set(block.split('\n')));
  }
  const next =
    beginIdx === -1
      ? [...stripTrailingBlanks(foreign), ...block.split('\n')]
      : [...foreign.slice(0, beginIdx), ...block.split('\n'), ...foreign.slice(beginIdx)];

  const result = joinCrontab(next);
  // Post-condition (never swallow, never multiply): every foreign line from
  // the input is still present, and exactly one marker pair exists.
  assertInstallPostcondition(foreign, result);
  return result;
}

/**
 * Return `existing` with the managed block removed. No-op when no block is
 * installed. Refuses corrupt marker state or unrecognized lines inside the
 * region unless `force` drops the owned lines. Never swallows foreign lines.
 */
export function uninstallBlock(existing: string, opts: InstallOptions = {}): string {
  const lines = splitLines(existing);
  if (opts.force) {
    // Explicit repair: drop the owned region wholesale. For an intact pair
    // (possibly holding unrecognized lines) that means the whole region —
    // unknown lines inside the markers are NOT foreign. Otherwise drop every
    // owned line and keep every foreign line in order.
    const begins = lines.filter((l) => l === SCHEDULE_BEGIN).length;
    const ends = lines.filter((l) => l === SCHEDULE_END).length;
    const beginIdx = lines.indexOf(SCHEDULE_BEGIN);
    const endIdx = lines.indexOf(SCHEDULE_END);
    const foreign =
      begins === 1 && ends === 1 && beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx
        ? foreignLines(lines, beginIdx, endIdx)
        : lines.filter((l) => !isManagedLine(l));
    const result = joinCrontab(foreign);
    assertUninstallPostcondition(foreign, result);
    return result;
  }

  const { begin, end, beginIdx, endIdx } = assertMarkersSane(lines, 'existing crontab');
  if (begin === 0 && end === 0) return existing;
  if ((begin === 1) !== (end === 1)) {
    throw new Error(
      'schedule failed: managed block is corrupt (begin without end or vice versa) — ' +
        'inspect `crontab -l` by hand, or re-run with --force to repair.',
    );
  }
  const foreign = foreignLines(lines, beginIdx, endIdx);
  // No desired block on the uninstall path — the region must consist purely
  // of lines we own (markers, spec comments, our entries, blanks), otherwise
  // removing it would swallow something foreign.
  assertRegionKnown(lines, beginIdx, endIdx, new Set());
  const result = joinCrontab(foreign);
  assertUninstallPostcondition(foreign, result);
  return result;
}

function stripTrailingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

/** Crontab text always ends in exactly one trailing newline (empty stays empty). */
function joinCrontab(lines: string[]): string {
  const stripped = stripTrailingBlanks(lines);
  if (stripped.length === 0) return '';
  return `${stripped.join('\n')}\n`;
}

/**
 * Ambient cron environment declarations a foreign crontab may already carry
 * (`man 5 crontab`: `NAME = value` lines before the entries apply to every
 * command below them — including ours once installed). We deliberately emit
 * NO env lines of our own (absolute paths need none); install/list surface
 * these as a warning so a surprising `PATH=`, `TZ=` or `MAILTO=` never
 * silently changes what our entries do.
 */
export const AMBIENT_ENV_DECL_RE = /^\s*(CRON_TZ|TZ|SHELL|MAILTO|PATH|HOME)\s*=/;

/** Distinct env var names declared by foreign lines, in first-seen order. */
export function findAmbientEnvDecls(lines: string[]): string[] {
  const seen: string[] = [];
  for (const line of lines) {
    const match = AMBIENT_ENV_DECL_RE.exec(line);
    if (match && !seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

export interface ScheduleStatus {
  installed: boolean;
  /** True when the installed block is byte-identical to the desired spec. */
  matches: boolean;
  /** Currently installed managed lines (empty when not installed). */
  current: string[];
  /** Desired managed lines. */
  desired: string[];
}

/** Diff-aware status for `scheduleList`: is our block present, and is it current? */
export function describeSchedule(existing: string, block: string): ScheduleStatus {
  const lines = splitLines(existing);
  const beginIdx = lines.indexOf(SCHEDULE_BEGIN);
  const endIdx = lines.indexOf(SCHEDULE_END);
  const desired = block.split('\n');
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { installed: false, matches: false, current: [], desired };
  }
  const current = lines.slice(beginIdx, endIdx + 1);
  return { installed: true, matches: current.join('\n') === block, current, desired };
}

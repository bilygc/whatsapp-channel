# Automation (M5): cron schedule for fetch + deliver

Two cron entries, owned as a single marked block in **your user crontab**
— not a service manager. If the machine sleeps, reboots, or the account is
torn down, missed runs are simply missed; nothing replays them and nothing
restores the crontab. Re-run `npm run scheduleInstall` after a teardown.

## The schedule (all times are server-local, NOT pinned to any timezone)

- **Fetch: every 15 minutes** (`*/15 * * * *`, plan spec) — `npm run fetch`.
- **Deliver: three times daily at 08:55, 13:55 and 18:55 server time**
  (`55 8,13,18 * * *`) — `npm run deliver`, i.e. the post-fetch chain
  select → write → telegramSend, five minutes before the 9/14/19h posting
  windows so drafts land on your phone ready to paste.

The server clock is the authority: check it with `date` and read the hours
above as whatever `date` prints (e.g. if `date` says `CST`, the 08:55 run
fires at 08:55 CST). Daylight-saving or timezone changes move the runs —
that is by design (they stay glued to local morning/midday/evening).

## Commands

```sh
npm run scheduleInstall            # install (or refresh) the managed block
npm run scheduleInstall -- --dry-run   # print the resulting crontab, change nothing
npm run scheduleInstall -- --no-lock   # install WITHOUT the flock guard (warns; see below)
npm run scheduleList               # show managed entries + whether they match the desired spec
npm run scheduleUninstall          # remove the managed block (your other lines untouched)
```

- Install is **idempotent**: re-running with the same spec changes nothing
  (`scheduleList` says "up to date"); a changed spec replaces the block
  in place, never duplicating entries.
- A corrupt managed block (begin marker without end, vice versa, reversed
  markers, duplicated markers) refuses to install — inspect with
  `crontab -l`, or re-run with `--force` to repair. `--force` drops only
  lines the tool owns and keeps every foreign line (a dangling BEGIN keeps
  foreign jobs *below* it too).
- Lines the tool did NOT generate are refused inside the markers: if a
  foreign line ever lands between BEGIN and END (human edit, paste
  accident), install/uninstall stop with a listing instead of silently
  replacing or swallowing it. `--force` replaces/drops the region wholesale.
- Refuses cleanly when the `crontab` binary is missing (typed guidance to
  install cron first).
- Every real write is **backed up first**: the current crontab goes to
  `<repo>/logs/crontab.before-<epoch>.bak` (mode `0o700`, exclusive-create —
  a same-second collision gets a `-<n>` suffix, never an overwrite); only
  the newest 10 backups are kept. The backup path is printed in the success
  message. After writing, the crontab is re-read and the managed block must
  match byte-identically AND every foreign line must still be present, or
  the command fails loudly (recover by hand with `crontab <backup>`).
- Spec paths must be absolute and control-character-free (a smuggled newline
  would forge extra crontab lines); literal `%` in paths is escaped at
  emission because cron treats `%` as a newline even inside quotes.

## What gets installed

```crontab
# whatsapp-channel automation: begin (managed — do not edit between markers)
# spec: fetch=*/15 * * * * deliver=55 8,13,18 * * * entrypoint=node+tsx
*/15 * * * * cd '<repo>' && '<node>' '<repo>/node_modules/tsx/dist/cli.mjs' '<repo>/src/cli/fetch.ts' >> '<repo>/logs/fetch.log' 2>&1
55 8,13,18 * * * cd '<repo>' && '<flock>' -n '<repo>/logs/deliver.lock' '<node>' '<repo>/node_modules/tsx/dist/cli.mjs' '<repo>/src/cli/deliver.ts' >> '<repo>/logs/deliver.log' 2>&1
# whatsapp-channel automation: end
```

Two deliberate choices (deviating from `npm run …` for robustness):

1. **Absolute `<node>` + pinned `tsx` instead of `npm run`.** Cron runs
   with a minimal `PATH` (`/usr/bin:/bin`) and no login shell — `npm` may
   not even be on it. Absolute paths need no environment at all, and skip
   npm's startup overhead on all ~300 fetch runs a week.
2. **`cd '<repo>' &&` first.** The CLIs load `./.env` via dotenv
   (`process.cwd()`) and default the SQLite path to `./data/…` — cron
   would otherwise start in `$HOME` and miss both. If you set an absolute
   `DB_PATH` in `.env`, the `cd` is belt-and-braces; relative setups depend
   on it.
3. **`flock -n` around deliver only.** Cron fires on wall-clock time and
   never serializes with itself: a second deliver starting while the first
   still runs (LLM slow, Telegram 429 backoff) would double-send drafts and
   double-spend LLM calls. The deliver entry runs under
   `flock -n <repo>/logs/deliver.lock`, so the overlap exits immediately.
   The flock binary is resolved at install time (`/usr/bin/flock`, else
   `command -v flock`); when it is absent, install fails closed with
   guidance — or `--no-lock` installs unguarded with a warning. (Fetch needs
   no guard: it is idempotent and degrades per-source.)
4. **A single-instance guard inside every deliver run.** The cron `flock`
   serializes cron-vs-cron, but a manual `npm run deliver` started during a
   window would sail past it. So `npm run deliver` claims its own guard at
   startup: a dedicated `logs/deliver-guard.db` file held under SQLite
   `BEGIN IMMEDIATE` for the whole run (a separate file, so the held claim
   never blocks fetch's inserts). A second deliver — cron firing into a
   manual run, or two manuals racing — gets `SQLITE_BUSY` immediately and
   exits 1 with a typed `another deliver is running` error instead of
   double-sending. Process death releases the lock with the file
   descriptor, so the guard can never go stale.
5. **No env lines of our own.** A foreign crontab may already set
   `MAILTO`/`PATH`/`TZ`/etc., which cron applies to every entry below —
   including ours. We deliberately emit none (absolute paths need none);
   install/list print a warning naming any such declarations so a surprising
   `TZ` or `PATH` never silently changes what our entries do.

Send-once under the timer: each deliver run sends only drafts that were
never successfully sent (`pending AND last_sent_at IS NULL`), oldest first,
bounded at 12 sends per run (3× the daily selection cap — a backlog from
failed windows drains over several windows instead of bursting all at
once; surplus stays queued for later runs). Unmarked drafts wait for your
button press and are never re-sent by later runs.
To force a re-delivery, run `npm run telegramSend -- --resend [draft-id …]`
(see [docs/telegram.md](telegram.md)). Deliver caps at 4 drafts per run
(plan: 3–4 posts/day) — `npm run deliver -- 5` is a typed refusal, and the
per-run write set is bounded at the selection count even when stale
`selected` leftovers are waiting.

## Logs and stopping

- `logs/fetch.log` and `logs/deliver.log` under the repo root (`logs/` is
  gitignored). Each run appends stdout+stderr; check them when a window
  produced no drafts.
- `npm run deliver` prints one summary line per step
  (`select:` / `write:` / `send:`) plus warning lines when a step was
  skipped — the same shapes as the individual CLIs.
- To pause: `npm run scheduleUninstall` (or delete the marked block by hand
  with `crontab -e`). Re-installing later is one command.

## Failure semantics (same philosophy as the pipeline)

- One broken feed/API never fails a fetch run; a failed LLM call leaves that
  article `selected` for the next run; a failed Telegram send leaves that
  draft queued (`last_sent_at` NULL, picked up again next run). Cron just
  re-runs the same honest code on a timer.
- `deliver` exits 1 only when select itself broke (DB), Telegram config is
  missing, or every attempted send failed. Zero selected articles, or a
  write step with nothing new, is exit 0 with a note in the log.
- Overlap: fetch runs take seconds; deliver runs take ~a minute. Cron may
  occasionally start a fetch while a deliver is mid-flight — SQLite WAL +
  `busy_timeout` absorb that (same as two manual CLIs racing).
  Cron-initiated delivers are serialized by `flock -n` (the late one exits
  instead of double-sending); manual runs during a window are rejected —
  the in-process guard exits 1 with `another deliver is running`, and the
  cron side does the same if it fires mid-manual-run. Retry after the
  window finishes; nothing is lost, just delayed.
- Laptop asleep through a window: that window's deliver never runs; the
  next fetch/deliver picks up newer articles. Drafts already made stay
  `pending` until you mark them — nothing is lost, just late.

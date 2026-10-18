# Security notes (M1 fetcher)

## Dependency audit

Run the supply-chain gate before merging dependency changes and periodically:

```sh
npm run audit   # npm audit --audit-level=high
```

It fails on any high-or-critical advisory. There is no CI workflow in this
repo yet; when one is added, this script is the step to run.

## Boundary error handling

Every call outside the app's control (RSS fetches, NewsData, SQLite,
filesystem/env) catches failures at the call site into a typed error or a
defined fallback (failed source, `invalid` row, `NULL` image). No raw
library/network error propagates unhandled. Each boundary has a failure-path
test in `src/fetcher/*.test.ts` / `src/db/migrate.test.ts`.

## M2 writer (OpenRouter)

- Prompt-injection hygiene: article title/URL are untrusted data. `SYSTEM_PROMPT`
  (`src/writer/prompts.ts`) orders the model to treat them as data only and to
  always keep the `Fuente: <source> <url>` line; `buildUserPrompt()` collapses
  the title to one line (≤300 chars) so it cannot forge structural prompt
  lines, rejects overlong URLs as invalid articles, and rejects up-front when
  the attribution line alone would exceed the caption cap (no LLM quota burn
  on doomed articles). Ingest rejects control/whitespace-bearing URLs
  (`canonicalizeUrl()` — WHATWG `new URL()` would otherwise strip
  tab/newline smuggling before parsing — plus a NewsData link-path guard), so
  a smuggled multi-line `Fuente:` + phishing link never reaches the DB.
  `normalizeCaption()` (`src/writer/validate.ts`) NEVER trusts model-written
  links or attribution: it scrubs control/invisible/ANSI characters (incl.
  soft hyphen, bidi isolates, Arabic mark, tag chars), rejects
  whitespace/control-bearing article URLs as retryable invalid articles,
  strips all `Fuente:` lines, drops any body line bearing a foreign link of
  any linkable class — http/https/ftp URLs, `mailto:`, `www.` hosts, and bare
  domain-like tokens (`word.tld[/path]` with any TLD, aggressive by design;
  the canonical line always re-adds the true link) — and ALWAYS rebuilds the caption as cleaned body
  + the canonical `Fuente: <source> <url>` line (exactly one, never over
  `MAX_CAPTION_CHARS`).
- Terminal-escape hygiene: the `previewDrafts` / `select` CLIs print
  remote-controlled feed fields through the exported `scrub()` helper, and the
  `fetch` / `write` summary lines pass error strings through `scrub()` via
  `src/cli/format.ts` (sax/JSON.parse failures can embed feed-controlled
  bytes), so an OSC/ANSI sequence in a feed title cannot spoof terminal output
  and undermine the human review gate (display-only; the DB is untouched).
- LLM boundary: `generateCaption()` (`src/writer/openrouter.ts`) uses a 60s
  abort timeout, `redirect: 'error'` (the bearer key must never follow a
  redirect), a 1 MB response cap enforced WHILE streaming (chunked replies
  with no content-length cannot OOM the run), drains the body on HTTP errors,
  and typed `llm write failed for article
  <id>: ...` errors with the API key redacted. Per-article isolation in
  `runWriter()`: a failed call leaves the article `selected` for retry.
- Secrets: `OPENROUTER_API_KEY` from env only; never logged (error paths
  sanitize it, and the key rides in a header, not the URL).

## Secrets

Telegram/LLM/NewsData keys come from the environment only (`.env`, never
committed — `.gitignore` covers `.env*`). Error messages never include API
keys or request URLs: NewsData uses `redirect: 'error'` (the key rides in the
query string) and redacts secrets from failure messages.

## SSRF / private-network guard (partial — see M2 TODO)

`isBlockedHost()` in `src/fetcher/canonical.ts` denylists loopback, RFC-1918,
link-local (incl. cloud metadata IPs), and `localhost`, applied at ingest
time (bad article URL → `invalid`; bad `image_url` → `NULL`). This stops
obvious cases only: DNS rebinding can bypass insert-time checks. When M2
fetches article bodies/images, it must resolve the hostname at fetch time and
re-apply `isBlockedHost()` to the resolved IP(s) before connecting (TODO in
code).

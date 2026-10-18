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

#!/usr/bin/env bash
# scripts/commits-helper.sh
#
# Fixed set of git subcommands for the `commits` agent. The agent never
# constructs a raw git command — it only invokes this script with one of
# the subcommands below, plus whatever arguments that subcommand needs.
#
# This exists because OpenCode 1.18.5's permission.bash pattern matching
# does not reliably restrict ad-hoc commands once a catch-all "*": deny is
# present in the same block (see build-verify.sh for the same finding).
# Real enforcement lives HERE, in the fixed set of subcommands below — not
# in permission.bash, which only needs to allow invoking this script.
#
# Force-push is hard-blocked at the script level, not just omitted from a
# permission allowlist — see the `push` case below.

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: commits-helper.sh <subcommand> [args...]

Subcommands:
  status                        git status --porcelain
  diff [path...]                git diff (optionally scoped to paths)
  diff-staged [path...]         git diff --staged (optionally scoped to paths)
  log [-n N]                    git log, oneline, default last 10
  current-branch                git rev-parse --abbrev-ref HEAD
  create-branch <name>          git checkout -b <name>
  stage <path...>                git add -- <path...> (explicit paths only, never '.' or '-A')
  commit <message>              git commit -m <message>
  push <branch>                 git push -u origin <branch> (NEVER force)
  sync-with-main                 git fetch origin main + git merge origin/main
                                  (ABORTS the merge and reports conflicted
                                  files if any conflict occurs — never
                                  resolves conflicts automatically)
EOF
}

SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  status)
    git status --porcelain
    ;;

  diff)
    git diff -- "$@"
    ;;

  diff-staged)
    git diff --staged -- "$@"
    ;;

  log)
    if [ "${1:-}" = "-n" ]; then
      git log --oneline -n "${2:-10}"
    else
      git log --oneline -n 10
    fi
    ;;

  current-branch)
    git rev-parse --abbrev-ref HEAD
    ;;

  create-branch)
    NAME="${1:-}"
    if [ -z "$NAME" ]; then
      echo "ERROR: create-branch requires a branch name" >&2
      exit 1
    fi
    git checkout -b "$NAME"
    ;;

  stage)
    if [ "$#" -eq 0 ]; then
      echo "ERROR: stage requires at least one explicit file path. Wildcards like '.' or '-A' are not permitted by this script." >&2
      exit 1
    fi
    for path in "$@"; do
      if [ "$path" = "." ] || [ "$path" = "-A" ] || [ "$path" = "--all" ]; then
        echo "ERROR: bulk-staging ('$path') is not permitted. Stage explicit file paths only." >&2
        exit 1
      fi
    done
    git add -- "$@"
    git status --porcelain
    ;;

  commit)
    MESSAGE="${1:-}"
    if [ -z "$MESSAGE" ]; then
      echo "ERROR: commit requires a message" >&2
      exit 1
    fi
    git commit -m "$MESSAGE"
    ;;

  push)
    BRANCH="${1:-}"
    if [ -z "$BRANCH" ]; then
      echo "ERROR: push requires a branch name" >&2
      exit 1
    fi
    # Hard block on force-push, enforced here regardless of what arguments
    # were passed — this is not just a permission.bash pattern, it's a
    # structural check in the script itself.
    for arg in "$@"; do
      case "$arg" in
        --force|-f|--force-with-lease)
          echo "ERROR: force-push is not permitted by this script, under any flag." >&2
          exit 1
          ;;
      esac
    done
    git push -u origin "$BRANCH"
    ;;

  sync-with-main)
    # Root cause (2026-08, ATO-9 / PR #8): a branch went stale relative to
    # main (specifically, package-lock.json diverged), which silently
    # blocked the pull_request workflow trigger — GitHub does not run
    # pull_request-triggered checks on a PR with unresolved merge
    # conflicts against its base branch, so CI appeared to "not run
    # automatically" with no direct error pointing at the real cause.
    #
    # This subcommand fetches and attempts a merge from origin/main. If it
    # conflicts, it ABORTS immediately and reports the conflicted files —
    # it does not attempt any resolution (ours/theirs/regeneration). File
    # conflicts, especially in generated files like package-lock.json,
    # need a human decision or a dedicated regeneration step (e.g. `npm
    # install` after resolving), not an agent guessing which side to keep.
    CURRENT="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$CURRENT" = "main" ]; then
      echo "ERROR: refusing to sync-with-main while checked out on main itself." >&2
      exit 1
    fi

    echo "Fetching origin/main..."
    if ! git fetch origin main; then
      echo "ERROR: git fetch origin main failed." >&2
      exit 1
    fi

    echo "Attempting merge of origin/main into $CURRENT..."
    if git merge origin/main --no-edit; then
      echo "OK: merged origin/main into $CURRENT with no conflicts."
      exit 0
    else
      echo ""
      echo "CONFLICT: merging origin/main into $CURRENT produced conflicts." >&2
      echo "Conflicted files:" >&2
      git diff --name-only --diff-filter=U >&2
      echo "" >&2
      echo "Aborting the merge. This script does not resolve conflicts." >&2
      git merge --abort
      exit 1
    fi
    ;;

  ""|-h|--help)
    usage
    exit 0
    ;;

  *)
    echo "ERROR: unknown subcommand '$SUBCOMMAND'" >&2
    usage
    exit 1
    ;;
esac
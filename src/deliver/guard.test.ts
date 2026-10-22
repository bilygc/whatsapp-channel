import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDeliverGuard, DELIVER_GUARD_DB_NAME } from './guard.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-guard-'));
}

describe('acquireDeliverGuard (single-instance claim for npm run deliver)', () => {
  it('creates the guard db under <repoRoot>/logs/ and a second claim fails typed', () => {
    const root = tmpRoot();
    try {
      const first = acquireDeliverGuard(root);
      expect(first.lockFile).toBe(path.join(root, 'logs', DELIVER_GUARD_DB_NAME));
      expect(fs.existsSync(first.lockFile)).toBe(true);
      expect(() => acquireDeliverGuard(root)).toThrow(
        /^deliver failed: another deliver is running/,
      );
      first.release();
      // After release the next window can claim it again.
      const second = acquireDeliverGuard(root);
      second.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('release is safe to call twice', () => {
    const root = tmpRoot();
    try {
      const guard = acquireDeliverGuard(root);
      guard.release();
      expect(() => guard.release()).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a throwing logs-dir creation surfaces as a typed error', () => {
    expect(() =>
      acquireDeliverGuard('/repo', {
        mkdir: () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    ).toThrow(/^deliver failed: could not create logs dir/);
  });

  it('a non-busy guard failure is typed but NOT reported as another run', () => {
    expect(() =>
      acquireDeliverGuard('/repo', {
        mkdir: () => {},
        openDb: () => {
          throw new Error('SQLITE_CORRUPT: bad file');
        },
      }),
    ).toThrow(/^deliver failed: could not open the deliver guard/);
  });

  it('a busy claim reports the typed already-running error even when the message differs', () => {
    const busy = new Error('database is locked') as Error & { code?: string };
    busy.code = 'SQLITE_BUSY';
    expect(() =>
      acquireDeliverGuard('/repo', {
        mkdir: () => {},
        openDb: () => {
          throw busy;
        },
      }),
    ).toThrow(/^deliver failed: another deliver is running/);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, resolveDbPath } from './migrate.js';

describe('resolveDbPath', () => {
  it('returns the default when DB_PATH is unset', () => {
    expect(resolveDbPath({})).toBe(DEFAULT_DB_PATH);
  });

  it.each([[''], ['   '], ['\t\n ']])(
    'falls back to the default when DB_PATH is empty/whitespace (%j)',
    (value) => {
      expect(resolveDbPath({ DB_PATH: value })).toBe(DEFAULT_DB_PATH);
    },
  );

  it('trims and honors a set DB_PATH', () => {
    expect(resolveDbPath({ DB_PATH: '  /tmp/custom.db  ' })).toBe('/tmp/custom.db');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Guardrails for §0.6 date semantics.
 *
 * The ledger stores a business day as `YYYY-MM-DD` (no zone) and an instant as
 * an ISO-8601 UTC string. Both are plain `string`, so nothing in the type system
 * stops a call site from deriving one out of the other the wrong way. That is
 * how several modules each grew their own "today": some used the local calendar,
 * the rest sliced the UTC date, and the two disagree for eight hours every day
 * in Beijing.
 *
 * These checks are deliberately mechanical. They encode the invariants a
 * reviewer would otherwise have to re-derive on every diff: a calendar day is
 * produced in exactly one place, an instant is never truncated into a day, and
 * the UTC "today" helper does not come back.
 */

const ROOT = new URL('../../../', import.meta.url);

const SOURCE_DIRS = [
  'apps/web/src',
  'packages/core/src',
  'packages/db/src',
  'apps/sync-server/src',
];

interface SourceFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  lines: string[];
}

const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]));

const sources: SourceFile[] = SOURCE_DIRS.flatMap((dir) => walk(new URL(`${dir}/`, ROOT))
  .filter((file) => /\.tsx?$/.test(file.pathname))
  .map((file) => ({
    path: file.pathname.slice(file.pathname.indexOf(`${dir}/`)),
    lines: readFileSync(file, 'utf8').split(/\r?\n/),
  })));

/** `path:line: text` for every line matching `pattern`, minus allowed ones. */
const matching = (pattern: RegExp): { path: string; line: number; text: string }[] => sources
  .flatMap((file) => file.lines
    .map((text, index) => ({ path: file.path, line: index + 1, text }))
    .filter((entry) => pattern.test(entry.text)));

const format = (entries: { path: string; line: number; text: string }[]) => entries
  .map((entry) => `${entry.path}:${entry.line}: ${entry.text.trim()}`);

/** The one module allowed to turn local `Date` parts into a calendar day. */
const CANONICAL_DAY_SOURCE = 'packages/core/src/dates.ts';

describe('calendar days are built in exactly one place', () => {
  /*
   * Every hand-rolled `${d.getFullYear()}-${...padStart...}` is a private
   * definition of "today". Five of them had accumulated across the app; when one
   * is written with UTC getters instead, that module silently disagrees with the
   * rest for part of every day.
   */
  it('builds local days only in the core date module', () => {
    const offenders = matching(/getFullYear\(\)/)
      .filter((entry) => entry.path !== CANONICAL_DAY_SOURCE);
    expect(format(offenders)).toEqual([]);
  });

  it('exposes exactly one implementation of the local day', () => {
    const definitions = matching(/export function localToday\(/);
    expect(format(definitions)).toEqual([`${CANONICAL_DAY_SOURCE}:163: export function localToday(now: Date = new Date()): string {`]);
  });

  /*
   * `toLocaleDateString('en-CA')` looks like a cheap day and is the other half of
   * the original split. It is locale-data dependent and duplicated `localToday`.
   */
  it('does not derive a day from locale formatting', () => {
    expect(format(matching(/toLocaleDateString\(/))).toEqual([]);
  });
});

describe('instants are never truncated into calendar days', () => {
  /*
   * An instant's UTC date is not its local date. Slicing one is the exact bug
   * that made backup retention keep two "daily" restore points on one local day
   * and none on the next.
   */
  it('does not slice an instant field down to a day or month', () => {
    const offenders = matching(
      /\.(createdAt|updatedAt|occurredAtUtc|expiresAt|verifiedAt|lastSyncAt|deletedAt|at)\.slice\(\s*0\s*,\s*(10|7)\s*\)/,
    );
    expect(format(offenders)).toEqual([]);
  });

  /*
   * `toISOString().slice(...)` is legitimate for *anchor* arithmetic: day maths
   * runs on UTC-midnight anchors precisely so DST cannot drift it (§0.6). Those
   * call sites either construct the anchor inline or reuse one, so they are
   * listed explicitly rather than pattern-matched by file.
   */
  it('only slices ISO strings that are UTC-midnight anchors', () => {
    const allowed = [
      { path: CANONICAL_DAY_SOURCE, contains: 'toISOString().slice(0, 10)', why: 'formats a numeric UTC-midnight anchor' },
      { path: 'apps/web/src/screens/Transactions.tsx', contains: 'lastDay.toISOString()', why: 'last day of a UTC-anchored month' },
      { path: 'apps/web/src/selectors/transactions.ts', contains: 'date.toISOString().slice(0, 7)', why: 'month key of a UTC-anchored month' },
    ];
    const offenders = matching(/toISOString\(\)\.slice\(/)
      .filter((entry) => !/Date\.UTC\(/.test(entry.text))
      .filter((entry) => !allowed.some((rule) => rule.path === entry.path && entry.text.includes(rule.contains)));
    expect(format(offenders)).toEqual([]);
  });
});

describe('the UTC "today" helper stays gone', () => {
  /*
   * `today()` returned the UTC date and was exported alongside `localToday()`.
   * Two names for "now" with different answers is a choice nobody makes
   * correctly twice, so the UTC one was removed rather than documented.
   */
  it('does not define or export a UTC-shaped today', () => {
    expect(format(matching(/export function today\(/))).toEqual([]);
  });

  it('publishes the day/instant conversion helpers from core', () => {
    const index = sources.find((file) => file.path === 'packages/core/src/index.ts');
    const text = index?.lines.join('\n') ?? '';
    for (const name of ['dayOfInstant', 'hourBucketOfInstant', 'toInstant', 'localToday', 'todayIn']) {
      expect(text).toContain(name);
    }
  });
});

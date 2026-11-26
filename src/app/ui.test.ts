/** Pure parts of the UI: layout modes, apsis grouping, leaderboard error wording, status line. */
import { describe, expect, it } from 'vitest';
import { groupApsides } from './editor-ui';
import type { ListedEvent } from './events-view';
import { modeFor } from './layout';
import { explainError } from './leaderboard-layer';

describe('layout modes', () => {
  it('picks wide, side or sheet from the viewport', () => {
    expect(modeFor(1280, 720)).toBe('wide');
    expect(modeFor(1920, 1080)).toBe('wide');
    expect(modeFor(1024, 768)).toBe('side');
    expect(modeFor(1180, 820)).toBe('side');
    expect(modeFor(844, 390)).toBe('side');
    expect(modeFor(390, 844)).toBe('sheet');
    expect(modeFor(360, 640)).toBe('sheet');
    expect(modeFor(820, 1180)).toBe('sheet');
  });
});

const ev = (index: number, kind: string, body: string, altitude: number, failure = false): ListedEvent =>
  ({ index, role: 'event', failure, ev: { t: index * 100, kind, body, altitude, speed: 7800 } }) as unknown as ListedEvent;

describe('apsis grouping', () => {
  it('collapses runs of near-circular apsides, keeps other events and eccentric orbits', () => {
    const list = [ev(0, 'enter', 'earth', 0), ...Array.from({ length: 10 }, (_, i) => ev(1 + i, i % 2 ? 'apoapsis' : 'periapsis', 'earth', 207e3 + (i % 2) * 2e3)), ev(11, 'periapsis', 'moon', 1800e3)];
    const g = groupApsides(list);
    expect(g.map((x) => x.length)).toEqual([1, 10, 1]);
    const ecc = Array.from({ length: 6 }, (_, i) => ev(i, i % 2 ? 'apoapsis' : 'periapsis', 'earth', i % 2 ? 40000e3 : 300e3));
    expect(groupApsides(ecc).every((x) => x.length === 1)).toBe(true);
    expect(groupApsides(list.slice(0, 3)).every((x) => x.length === 1)).toBe(true); // short runs stay
  });
});

describe('leaderboard error wording', () => {
  const codes = ['bad-request', 'unexpected-field', 'bad-secret', 'bad-name', 'name-rejected', 'body-too-large', 'not-found', 'method-not-allowed', 'unknown-mission', 'mission-version', 'version-mismatch', 'invalid-plan', 'rule-violation', 'objectives-not-met', 'replay-limit', 'rate-limited', 'replay-timeout', 'plans-not-public', 'server-error', 'network', 'bad-response', 'aborted'];
  it('has a title and text for every code', () => {
    for (const code of codes) {
      const x = explainError({ code, message: 'm' });
      expect(x.title.length, code).toBeGreaterThan(3);
      expect(x.text.length, code).toBeGreaterThan(0);
    }
  });
  it('carries the server reasons and the wait', () => {
    expect(explainError({ code: 'rule-violation', message: 'x', detail: { issues: [{ code: 's', path: 'p', message: 'launch site not allowed' }] } }).items).toEqual(['launch site not allowed']);
    expect(explainError({ code: 'objectives-not-met', message: 'x', detail: { objectives: [{ kind: 'flyby', ok: false, detail: 'closest 900 km' }] } }).items[0]).toContain('not met (closest 900 km)');
    expect(explainError({ code: 'rate-limited', message: 'x', retryAfter: 40 }).text).toContain('40 s');
    expect(explainError({ code: 'mission-version', message: 'x', detail: { current: '2' } }).text).toContain('version 2');
    expect(explainError({ code: 'version-mismatch', message: 'x' }).action).toBe('reload');
  });
});

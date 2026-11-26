/** Scoring: par-relative combined score, quantised leaderboard keys, board ordering. */
import { describe, expect, it } from 'vitest';
import { compareKeys, deltaVKey, leaderboardKeys, PAR_SCORE, score, timeKey, type LeaderboardKeys } from '../src/mission/objectives';

const W = { deltaVRef: 4000, deltaVWeight: 1, timeRef: 4 * 86400, timeWeight: 1 };

describe('score', () => {
  it('is PAR_SCORE at par, 0 on failure, and scales as 1 / (mean of the two ratios)', () => {
    expect(score(true, 4000, 4 * 86400, W)).toBe(PAR_SCORE);
    expect(score(false, 4000, 4 * 86400, W)).toBe(0);
    expect(score(true, 3600, 3.6 * 86400, W)).toBe(Math.floor(PAR_SCORE / 0.9));
    expect(score(true, 2000, 4 * 86400, W)).toBe(Math.floor(PAR_SCORE / 0.75));
    // Weights are relative: (2, 2) scores like (1, 1).
    expect(score(true, 3000, 5 * 86400, { ...W, deltaVWeight: 2, timeWeight: 2 })).toBe(score(true, 3000, 5 * 86400, W));
  });

  it('never increases when delta-v or time increases', () => {
    let prev = Infinity;
    for (let dv = 3000; dv < 5000; dv += 7.3) {
      const s = score(true, dv, 3 * 86400, W);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
    prev = Infinity;
    for (let t = 86400; t < 9 * 86400; t += 3333.3) {
      const s = score(true, 3500, t, W);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it('keys are quantised up (0.1 m/s, 1 s) and the score depends only on them', () => {
    expect(deltaVKey(3167.12)).toBe(31672);
    expect(deltaVKey(3167.2)).toBe(31672);
    expect(timeKey(252043.01)).toBe(252044);
    expect(score(true, 3167.11, 252043.2, W)).toBe(score(true, 3167.2, 252044, W));
    expect(leaderboardKeys(false, 1, 1, W)).toBeNull();
    expect(leaderboardKeys(true, 3167.11, 252043.2, W)).toEqual({ score: score(true, 3167.2, 252044, W), deltaV: 31672, time: 252044 });
  });

  it('orders each board with explicit tie-breaks', () => {
    const a: LeaderboardKeys = { score: 100, deltaV: 30000, time: 500 };
    const b: LeaderboardKeys = { score: 100, deltaV: 29000, time: 900 };
    const c: LeaderboardKeys = { score: 90, deltaV: 29000, time: 400 };
    const sort = (board: Parameters<typeof compareKeys>[0]) => [a, b, c].sort((x, y) => compareKeys(board, x, y));
    expect(sort('combined')).toEqual([b, a, c]);
    expect(sort('delta-v')).toEqual([c, b, a]);
    expect(sort('time')).toEqual([c, a, b]);
  });
});

/**
 * Boards, ranking order and the DynamoDB sort keys that encode it.
 *
 * ORDER (lower sort key ranks higher; fully deterministic; mirrors objectives.ts compareKeys):
 *  combined: score (better first: higher while SCORE_HIGHER_IS_BETTER), then
 *            delta-v ascending, then mission time ascending, then earlier
 *            submission of that result, then player hash.
 *  deltaV:   delta-v asc, mission time asc, earlier submission, player hash.
 *  time:     mission time asc, delta-v asc, earlier submission, player hash.
 * Values are the mission layer's integer keys, so results tie exactly when
 * their keys are equal; the earlier submission then wins.
 *
 * ENCODING. A double becomes 16 hex digits whose string order is numeric
 * order (sign bit flipped for positives, all bits flipped for negatives); a
 * descending field is its digit-wise complement. Submission time is 13
 * decimal digits of epoch ms. The player hash (64 hex) ends the key.
 */
export type BoardId = 'combined' | 'deltaV' | 'time';
export const BOARDS: readonly BoardId[] = ['combined', 'deltaV', 'time'];

/** Short attribute prefix per board (item attributes c / d / t and GSI keys cPk, cSk, ...). */
export const SLOT: Record<BoardId, 'c' | 'd' | 't'> = { combined: 'c', deltaV: 'd', time: 't' };

export interface Values {
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Order-preserving 16-hex-digit encoding of a double (finite or not; NaN after +Infinity). */
export function sortableF64(x: number): string {
  f64[0] = x === 0 ? 0 : x; // -0 sorts as 0
  let hi = u32[LITTLE ? 1 : 0];
  let lo = u32[LITTLE ? 0 : 1];
  if (hi & 0x80000000) {
    hi = ~hi >>> 0;
    lo = ~lo >>> 0;
  } else hi = (hi | 0x80000000) >>> 0;
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function complement(h: string): string {
  let s = '';
  for (let i = 0; i < h.length; i++) s += (15 - parseInt(h[i], 16)).toString(16);
  return s;
}

/** The part of the key that decides "better" (values only). */
export function valueKey(board: BoardId, v: Values, scoreHigherIsBetter: boolean): string {
  // The mission layer's integer keys (objectives.ts LeaderboardKeys): delta-v in tenths of m/s
  // (values arrive as key / 10, so x10 and rounding recovers the integer exactly), time in s.
  const dv = sortableF64(Math.round(v.deltaV * 10));
  const t = sortableF64(Math.round(v.missionTime));
  switch (board) {
    case 'combined': {
      const s = sortableF64(v.score);
      return (scoreHigherIsBetter ? complement(s) : s) + dv + t;
    }
    case 'deltaV':
      return dv + t;
    case 'time':
      return t + dv;
  }
}

export function sortKey(board: BoardId, v: Values, atMs: number, playerHash: string, scoreHigherIsBetter: boolean): string {
  return `${valueKey(board, v, scoreHigherIsBetter)}${String(Math.max(0, Math.floor(atMs))).padStart(13, '0')}${playerHash}`;
}

/** True if `a` is strictly better than `b` on the board (a tie keeps the earlier result). */
export function better(board: BoardId, a: Values, b: Values, scoreHigherIsBetter: boolean): boolean {
  return valueKey(board, a, scoreHigherIsBetter) < valueKey(board, b, scoreHigherIsBetter);
}

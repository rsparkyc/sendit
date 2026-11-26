/**
 * The app's single adapter to src/leaderboard. The client module is loaded
 * lazily (dynamic import), so the leaderboard adds nothing to the initial
 * page; this file itself holds only the error wording, which is pure.
 */
import type { BoardEntry, BoardId, BoardResponse, MeResponse, MissionsResponse, RankInfo, SubmitResponse } from '../leaderboard/client';

export type { BoardEntry, BoardId, BoardResponse, MeResponse, MissionsResponse, RankInfo, SubmitResponse };
export type LeaderboardClient = typeof import('../leaderboard/client');

let client: Promise<LeaderboardClient> | null = null;

export function loadClient(): Promise<LeaderboardClient> {
  client ??= import('../leaderboard/client');
  return client;
}

/** The parts of a LeaderboardError the wording needs. */
export interface ErrorLike {
  code: string;
  message: string;
  status?: number;
  detail?: unknown;
  retryAfter?: number;
}

export interface Explained {
  title: string;
  /** Plain sentences. */
  text: string;
  /** Bullet points (the server's reasons), if any. */
  items: string[];
  /** What the player can do. */
  action: 'reload' | 'retry' | 'wait' | 'fix' | 'none';
}

function list(detail: unknown, key: string): string[] {
  const v = detail && typeof detail === 'object' ? (detail as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.message === 'string') return o.message;
      if (typeof o.detail === 'string') return `${typeof o.kind === 'string' ? `${o.kind}: ` : ''}${o.ok === true ? 'met' : o.ok === false ? 'not met' : ''}${o.detail ? ` (${o.detail})` : ''}`;
    }
    return JSON.stringify(x);
  });
}

const secs = (s: number | undefined) => (s === undefined ? 'a little while' : s < 90 ? `${Math.ceil(s)} s` : `${Math.ceil(s / 60)} min`);

/** Player-facing explanation of every error the API (and the client) defines. */
export function explainError(e: ErrorLike): Explained {
  switch (e.code) {
    case 'version-mismatch':
      return { title: 'Game version out of date', text: 'The leaderboard runs a different physics version than this page, so it would fly your plan differently. Reload the page, check the flight, and submit again.', items: [], action: 'reload' };
    case 'mission-version': {
      const cur = e.detail && typeof e.detail === 'object' ? (e.detail as { current?: unknown }).current : undefined;
      return { title: 'This mission has changed', text: `The mission was updated on the server${cur !== undefined ? ` (now version ${String(cur)})` : ''}. Reload the page to get the new rules, re-check your plan, and submit again.`, items: [], action: 'reload' };
    }
    case 'rule-violation':
      return { title: 'The plan breaks the mission rules', text: 'The server refused the plan before flying it:', items: list(e.detail, 'issues').length ? list(e.detail, 'issues') : [e.message], action: 'fix' };
    case 'objectives-not-met':
      return { title: 'Objectives not met on the server', text: 'The server re-flew your plan and it did not complete the mission:', items: list(e.detail, 'objectives').length ? list(e.detail, 'objectives') : [e.message], action: 'fix' };
    case 'invalid-plan':
      return { title: 'The plan could not be flown', text: e.message, items: [], action: 'fix' };
    case 'replay-limit':
      return { title: 'Flight too long to verify', text: 'This flight needs more integrator steps or events than the leaderboard allows. A shorter flight duration usually fixes it.', items: [], action: 'fix' };
    case 'rate-limited':
      return { title: 'Too many submissions', text: `Please wait ${secs(e.retryAfter)} before submitting again.`, items: [], action: 'wait' };
    case 'replay-timeout':
      return { title: 'The server is busy', text: `Verifying your flight took too long. Try again in ${secs(e.retryAfter)}.`, items: [], action: 'wait' };
    case 'bad-name':
    case 'name-rejected':
      return { title: 'Choose another name', text: e.message || 'That display name is not allowed.', items: [], action: 'fix' };
    case 'bad-secret':
      return { title: 'Identity key not valid', text: 'Your identity key was rejected. Import a valid key or clear it to make a new one.', items: [], action: 'fix' };
    case 'unknown-mission':
      return { title: 'No leaderboard for this mission', text: 'This mission is not on the leaderboard.', items: [], action: 'none' };
    case 'plans-not-public':
      return { title: 'Flights are private', text: 'This leaderboard does not publish players’ flight plans.', items: [], action: 'none' };
    case 'network':
    case 'aborted':
      return { title: 'Leaderboard unreachable', text: 'Could not reach the leaderboard. Check your connection and try again; your plan is kept in this browser and in its share link.', items: [], action: 'retry' };
    case 'not-found':
    case 'method-not-allowed':
    case 'bad-response':
      return { title: 'Leaderboard not available', text: 'The leaderboard is not online on this site yet. Your plan is kept in this browser and in its share link.', items: [], action: 'none' };
    case 'server-error':
      return { title: 'Server error', text: 'The leaderboard hit an internal error. Try again later.', items: [], action: 'retry' };
    default:
      return { title: 'Submission refused', text: e.message || `Error ${e.code}`, items: [], action: 'none' };
  }
}

/**
 * Sharing and persistence. Pure apart from the small storage wrappers.
 *
 * Share link: `#m=<mission id>&p=<plan>` where <plan> is the plan layer's
 * encoder output (raw IEEE-754 doubles, so a link reproduces the flight bit
 * for bit). Local storage keeps the editor's working copy as JSON instead,
 * because a plan being edited may be temporarily invalid and the encoder only
 * accepts valid plans.
 */
import { PHYSICS_MODEL, PlanError, decodePlan, encodePlan, validatePlan, type MissionPlan } from './mission-layer';
import type { ManeuverNode } from './nodes';

export interface HashLoad {
  missionId: string | null;
  plan: MissionPlan | null;
  /** Why the link could not be used, or a warning about it. */
  error: string | null;
  /** The plan decodes but was made for another physics model or data set: replay will refuse it. */
  mismatch: string | null;
}

/** Build the hash for a plan (null if the plan is invalid and cannot be encoded). */
export function planHash(missionId: string, plan: MissionPlan): string | null {
  if (validatePlan(plan).length > 0) return null;
  return `#m=${encodeURIComponent(missionId)}&p=${encodePlan(plan)}`;
}

/** Parse a location hash. A hash without `p=` (e.g. view parameters) gives plan null and no error. */
export function parsePlanHash(hash: string, fingerprint: string): HashLoad {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const missionId = params.get('m');
  const p = params.get('p');
  if (p === null) return { missionId, plan: null, error: null, mismatch: null };
  try {
    const plan = decodePlan(p);
    const mismatch =
      plan.model !== PHYSICS_MODEL || plan.data !== fingerprint
        ? `This link was made with physics model ${plan.model} and data ${plan.data}; this build is model ${PHYSICS_MODEL} with data ${fingerprint}. ` +
          'Its replay would not match the original, so it is refused (outcome: version mismatch). You can adopt the plan for this build, which re-flies it under the current physics.'
        : null;
    return { missionId, plan, error: null, mismatch };
  } catch (e) {
    const msg = e instanceof PlanError ? e.message : String(e);
    return { missionId, plan: null, error: `Could not load the shared plan: ${msg}`, mismatch: null };
  }
}

// ---------------------------------------------------------------------------
// Local storage

export const STORAGE_KEY = 'sendit.editor.v1';

export interface SavedEditor {
  v: 1;
  missionId: string;
  plan: MissionPlan;
  parked: ManeuverNode[];
}

export function serializeEditor(missionId: string, plan: MissionPlan, parked: readonly ManeuverNode[]): string {
  return JSON.stringify({ v: 1, missionId, plan, parked: [...parked] } satisfies SavedEditor);
}

/** Parse a saved editor state; null if absent or unusable. Structural problems are left to validatePlan (shown in the UI). */
export function parseSavedEditor(text: string | null): SavedEditor | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as SavedEditor;
    if (s?.v !== 1 || typeof s.missionId !== 'string' || typeof s.plan !== 'object' || s.plan === null || !Array.isArray(s.plan.burns)) return null;
    if (!s.plan.start || !s.plan.spacecraft || !Array.isArray(s.plan.spacecraft.engines)) return null;
    return { ...s, parked: Array.isArray(s.parked) ? s.parked : [] };
  } catch {
    return null;
  }
}

export function loadSaved(): SavedEditor | null {
  try {
    return parseSavedEditor(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function save(missionId: string, plan: MissionPlan, parked: readonly ManeuverNode[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeEditor(missionId, plan, parked));
  } catch {
    // Storage full or blocked: the share link still works.
  }
}

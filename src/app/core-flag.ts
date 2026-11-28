/**
 * Feature flag for the Rust core (core/, as WebAssembly) in the replay worker.
 * Default OFF: the game runs the TypeScript physics only and never fetches the
 * module.
 *
 *  - 'off'     (default) TypeScript only.
 *  - 'shadow'  the replay worker also flies every full replay in the core and
 *              compares it bit for bit with the TypeScript (digest, outcome,
 *              steps, final state, every trajectory sample). The game still
 *              shows the TypeScript's result; a mismatch is logged
 *              (console.warn) and counted in ReplayClient.stats.core.
 *
 * Turn on with ?core=shadow in the page URL, or localStorage
 * 'sendit.core' = 'shadow' (per browser); ?core=off overrides the stored value.
 */
export type CoreMode = 'off' | 'shadow';

export const CORE_FLAG_KEY = 'sendit.core';

/** Where the site serves the core's module (public/core/ in the source tree, built by core/scripts/build-web.sh). */
export const CORE_WASM_URL = `${import.meta.env?.BASE_URL ?? '/'}core/sendit_core.wasm`;

function parse(v: string | null | undefined): CoreMode | null {
  return v === 'shadow' || v === 'off' ? v : null;
}

export function coreMode(): CoreMode {
  try {
    const q = parse(new URLSearchParams(globalThis.location?.search ?? '').get('core'));
    if (q) return q;
  } catch { /* no location */ }
  try {
    return parse(globalThis.localStorage?.getItem(CORE_FLAG_KEY)) ?? 'off';
  } catch {
    return 'off';
  }
}

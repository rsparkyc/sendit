/**
 * Display names: free text chosen by the player, cleaned up so it renders as
 * what it says.
 *
 *  1. Unicode NFKC (folds full-width, ligatures, compatibility forms).
 *  2. Remove control (Cc), format (Cf: zero-width joiners / spaces, bidi
 *     overrides, soft hyphen, BOM), private-use (Co), surrogate (Cs) and
 *     unassigned (Cn) code points, and characters that render blank (Hangul
 *     fillers, braille blank, Mongolian vowel separator).
 *  3. Any run of whitespace / separators becomes one space; trimmed.
 *  4. At most 2 combining marks per base character (no "zalgo" towers).
 *  5. 1 to 24 code points.
 *  6. The filter hook (blocklist, reserved names) may refuse it.
 *
 * Duplicates are allowed: every entry also shows a short tag derived from the
 * player hash (identity.ts), so equal names are distinguishable.
 */

export const NAME_MAX = 24;
const RAW_MAX = 256;

const REMOVE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}ᅟᅠㅤﾠ⠀᠎឴឵]/gu;
const SPACES = /[\s\p{Z}]+/gu;
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;

export type NameResult = { ok: true; name: string } | { ok: false; code: 'bad-name' | 'name-rejected'; message: string };

/**
 * Filter hook: return a reason string to refuse a (cleaned) name, or null.
 * `skeleton` is a lower-case letters-only folding (digits read as look-alike
 * letters) for matching blocklist terms against obfuscated spellings.
 */
export type NameFilter = (name: string, skeleton: string) => string | null;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };

export function skeletonOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, '');
}

/** Names that could pass as the operator. */
export const RESERVED_TERMS: readonly string[] = ['admin', 'administrator', 'moderator', 'official', 'sendit', 'system'];

/**
 * A filter refusing names whose skeleton contains any term's skeleton.
 * The deployment's blocklist (env NAME_BLOCKLIST, comma-separated) goes here;
 * the repo ships no offensive-word list.
 */
export function blocklistFilter(terms: readonly string[]): NameFilter {
  const sk = terms.map(skeletonOf).filter((t) => t.length >= 3);
  return (_name, skeleton) => (sk.some((t) => skeleton.includes(t)) ? 'this name is not allowed' : null);
}

export function sanitizeName(raw: unknown, filter: NameFilter | null = null): NameResult {
  if (typeof raw !== 'string') return { ok: false, code: 'bad-name', message: 'name must be a string' };
  if (raw.length > RAW_MAX) return { ok: false, code: 'bad-name', message: `name is too long (at most ${NAME_MAX} characters)` };
  let s = raw.normalize('NFKC').replace(REMOVE, '').replace(SPACES, ' ').trim().replace(MARK_RUN, '$1');
  // A mark with no base after trimming would combine with whatever is shown before the name.
  s = s.replace(/^\p{M}+/u, '').trim();
  const n = Array.from(s).length;
  if (n === 0) return { ok: false, code: 'bad-name', message: 'name is empty' };
  if (n > NAME_MAX) return { ok: false, code: 'bad-name', message: `name is too long (at most ${NAME_MAX} characters)` };
  const why = filter?.(s, skeletonOf(s)) ?? null;
  if (why) return { ok: false, code: 'name-rejected', message: why };
  return { ok: true, name: s };
}

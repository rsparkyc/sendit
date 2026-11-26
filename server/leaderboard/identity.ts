/**
 * Player identity without accounts, and client-IP hashing.
 *
 * The browser makes a random 256-bit secret once (base64url, 43 characters),
 * keeps it in local storage and sends it with every submission. The server
 * stores only SHA-256 of it (the player hash); the same secret is the same
 * player. Nothing else identifies a player.
 *
 * Shown publicly per entry: a 5-character tag (from a hash of the player
 * hash) next to the free-text name, so two players called "Ada" are told
 * apart, and `pid` (16 hex digits of the player hash), an opaque entry id.
 *
 * IPs are only used for rate limiting and are never stored in clear: the rate
 * item key holds HMAC-SHA256(salt, utcDay | ip), truncated. The salt is a
 * deployment secret; the day in the input means the same IP maps to unrelated
 * values on different days.
 */
import { hmacHex, sha256Hex } from './hash';

/** 32 random bytes, base64url without padding. Longer secrets (up to 64 characters) are accepted too. */
export const SECRET_RE = /^[A-Za-z0-9_-]{43,64}$/;

export function validSecret(s: unknown): s is string {
  return typeof s === 'string' && SECRET_RE.test(s);
}

export async function playerHashOf(secret: string): Promise<string> {
  return sha256Hex(`sendit-player-v1|${secret}`);
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** 5 Crockford base32 characters (25 bits) derived from the player hash. Distinguishes; does not authenticate. */
export async function tagOf(playerHash: string): Promise<string> {
  const h = await sha256Hex(`sendit-tag-v1|${playerHash}`);
  const n = parseInt(h.slice(0, 8), 16) >>> 7; // top 25 bits
  let s = '';
  for (let i = 4; i >= 0; i--) s += CROCKFORD[(n >>> (5 * i)) & 31];
  return s;
}

/** Public opaque entry id. */
export function pidOf(playerHash: string): string {
  return playerHash.slice(0, 16);
}

/** Viewer IP from CloudFront's CloudFront-Viewer-Address header ("ip:port", IPv6 unbracketed), else the fallback. */
export function clientIp(headers: Readonly<Record<string, string | undefined>>, fallback: string): string {
  const v = headers['cloudfront-viewer-address'];
  if (v) {
    const i = v.lastIndexOf(':');
    const ip = i > 0 ? v.slice(0, i) : v;
    if (/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return ip.toLowerCase();
  }
  return fallback;
}

export async function ipHashOf(ip: string, salt: string, nowMs: number): Promise<string> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return (await hmacHex(salt, `${day}|${ip}`)).slice(0, 32);
}

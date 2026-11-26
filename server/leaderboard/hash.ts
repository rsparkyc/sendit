/** SHA-256 and HMAC-SHA256 through Web Crypto (global in Node 22 and in browsers). */

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function bytes(x: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return (typeof x === 'string' ? enc.encode(x) : new Uint8Array(x)) as Uint8Array<ArrayBuffer>;
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

export async function hmac(key: string | Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes(msg)));
}

export async function hmacHex(key: string | Uint8Array, msg: string): Promise<string> {
  return hex(await hmac(key, msg));
}

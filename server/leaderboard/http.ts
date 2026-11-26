/**
 * HTTP layer: a Lambda function URL event (payload format 2.0) in, a function
 * URL response out. Routing, the body-size cap, JSON parsing and response
 * headers live here; everything else is in service.ts.
 */
import { clientIp } from './identity';
import { fail, type Reply, type Service } from './service';

export interface UrlEvent {
  readonly rawPath?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: { readonly http?: { readonly method?: string; readonly sourceIp?: string } };
}

export interface UrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const PREFIX = '/api/leaderboard';

/**
 * Which routes this function serves. Two functions run the same bundle:
 * 'submit' (only POST /submit: replays, low reserved concurrency) and 'read'
 * (everything else), so a flood of submissions cannot starve board reads.
 */
export type Role = 'submit' | 'read' | 'all';

export async function handle(service: Service, ev: UrlEvent, maxBodyBytes: number, log: (o: Record<string, unknown>) => void = () => {}, role: Role = 'all'): Promise<UrlResponse> {
  const t0 = Date.now();
  const method = ev.requestContext?.http?.method ?? 'GET';
  const path = (ev.rawPath ?? '/').replace(/\/+$/, '');
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(ev.headers ?? {})) headers[k.toLowerCase()] = v;
  let reply: Reply;
  try {
    const isSubmit = path === `${PREFIX}/submit`;
    reply = (role === 'submit' && !isSubmit) || (role === 'read' && isSubmit) ? fail('not-found', 'no such route') : await route(service, method, path, headers, ev, maxBodyBytes);
  } catch (e) {
    log({ level: 'error', path, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
    reply = fail('server-error', 'internal error');
  }
  const body = reply.body as { error?: string };
  log({ level: 'info', method, path, status: reply.status, error: body?.error, ms: Date.now() - t0 });
  return respond(reply);
}

async function route(service: Service, method: string, path: string, headers: Record<string, string | undefined>, ev: UrlEvent, maxBodyBytes: number): Promise<Reply> {
  if (!path.startsWith(PREFIX)) return fail('not-found', 'no such route');
  const r = path.slice(PREFIX.length);
  const q = ev.queryStringParameters ?? {};
  const get = method === 'GET' || method === 'HEAD';
  switch (r) {
    case '/missions':
      return get ? service.missions() : fail('method-not-allowed', 'use GET');
    case '/board':
      return get ? service.board(q) : fail('method-not-allowed', 'use GET');
    case '/plan':
      return get ? service.plan(q) : fail('method-not-allowed', 'use GET');
    case '/submit':
    case '/me': {
      if (method !== 'POST') return fail('method-not-allowed', 'use POST');
      const declared = Number(headers['content-length'] ?? '0');
      if (declared > maxBodyBytes) return fail('body-too-large', `request body over ${maxBodyBytes} bytes`);
      const raw = ev.body ?? '';
      // Cheap bound before decoding: base64 is 4/3 the size, UTF-16 length <= UTF-8 bytes.
      if (raw.length > (ev.isBase64Encoded ? Math.ceil((maxBodyBytes * 4) / 3) + 4 : maxBodyBytes)) return fail('body-too-large', `request body over ${maxBodyBytes} bytes`);
      const bytes = ev.isBase64Encoded ? base64Bytes(raw) : new TextEncoder().encode(raw);
      if (bytes.length > maxBodyBytes) return fail('body-too-large', `request body over ${maxBodyBytes} bytes`);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return fail('bad-request', 'body must be UTF-8 JSON');
      }
      const ip = clientIp(headers, ev.requestContext?.http?.sourceIp ?? '0.0.0.0');
      return r === '/me' ? service.me(json, ip) : service.submit(json, ip);
    }
    default:
      return fail('not-found', 'no such route');
  }
}

function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function respond(reply: Reply): UrlResponse {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': reply.cache ? `public, max-age=${reply.cache}` : 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (reply.retryAfter !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(reply.retryAfter)));
  return { statusCode: reply.status, headers, body: JSON.stringify(reply.body) };
}

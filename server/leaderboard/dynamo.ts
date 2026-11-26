/**
 * Minimal DynamoDB client: the JSON protocol over fetch, signed with SigV4
 * (Web Crypto). No AWS SDK, so the bundle carries no dependency and the code
 * runs unchanged in Lambda and in a local admin script. Credentials come from
 * the standard environment variables (Lambda sets them; locally use
 * `eval "$(aws configure export-credentials --format env)"`).
 */
import { hex, hmac, sha256Hex } from './hash';

// ------------------------------------------------------------ attribute values

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { M: Record<string, AttributeValue> }
  | { L: AttributeValue[] };

export type Item = Record<string, AttributeValue>;
export type Plain = string | number | boolean | null | Plain[] | { [k: string]: Plain };

export function marshal(v: Plain): AttributeValue {
  if (v === null) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`marshal: non-finite number ${v}`);
    return { N: String(v) };
  }
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(marshal) };
  const m: Record<string, AttributeValue> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) m[k] = marshal(x);
  return { M: m };
}

export function marshalItem(o: Record<string, Plain | undefined>): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = marshal(v);
  return out;
}

export function unmarshal(a: AttributeValue): Plain {
  if ('S' in a) return a.S;
  if ('N' in a) return Number(a.N);
  if ('BOOL' in a) return a.BOOL;
  if ('NULL' in a) return null;
  if ('L' in a) return a.L.map(unmarshal);
  const o: Record<string, Plain> = {};
  for (const [k, v] of Object.entries(a.M)) o[k] = unmarshal(v);
  return o;
}

export function unmarshalItem(i: Item): Record<string, Plain> {
  const o: Record<string, Plain> = {};
  for (const [k, v] of Object.entries(i)) o[k] = unmarshal(v);
  return o;
}

// ------------------------------------------------------------------ transport

/** One DynamoDB API call: operation name (e.g. 'GetItem') and its JSON input; resolves to the JSON output. */
export interface DynamoApi {
  send(op: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class DynamoError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`);
    this.name = 'DynamoError';
  }
}

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export function credentialsFromEnv(env: Readonly<Record<string, string | undefined>>): Credentials {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials not found in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)');
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined };
}

export interface SignInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** Already-canonical query string (sorted, encoded), or ''. */
  readonly query: string;
  /** Lower-case header names. host and x-amz-date are added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  /** YYYYMMDD'T'HHMMSS'Z' */
  readonly amzDate: string;
}

/** AWS Signature Version 4: returns the headers to send (including authorization). */
export async function signV4(req: SignInput, creds: Credentials): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...req.headers, host: req.host, 'x-amz-date': req.amzDate };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((k) => `${k}:${lower[k]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [req.method, req.path, req.query, canonicalHeaders, signedHeaders, await sha256Hex(req.body)].join('\n');
  const day = req.amzDate.slice(0, 8);
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', req.amzDate, scope, await sha256Hex(canonical)].join('\n');
  let k = await hmac(`AWS4${creds.secretAccessKey}`, day);
  k = await hmac(k, req.region);
  k = await hmac(k, req.service);
  k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, toSign));
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

function amzDateOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const RETRYABLE = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'InternalServerError', 'ServiceUnavailable']);

/** DynamoDB over HTTPS. Retries throttling and 5xx up to `retries` times with jittered backoff. */
export class HttpDynamo implements DynamoApi {
  private readonly host: string;
  constructor(
    private readonly region: string,
    private readonly creds: () => Credentials,
    private readonly retries = 3,
  ) {
    this.host = `dynamodb.${region}.amazonaws.com`;
  }

  async send(op: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(input);
    for (let attempt = 0; ; attempt++) {
      const headers = await signV4(
        {
          method: 'POST',
          host: this.host,
          path: '/',
          query: '',
          headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${op}` },
          body,
          region: this.region,
          service: 'dynamodb',
          amzDate: amzDateOf(Date.now()),
        },
        this.creds(),
      );
      delete headers.host; // fetch sets it
      let res: Response;
      try {
        res = await fetch(`https://${this.host}/`, { method: 'POST', headers, body });
      } catch (e) {
        if (attempt < this.retries) { await backoff(attempt); continue; }
        throw new DynamoError('NetworkError', (e as Error).message, 0);
      }
      const text = await res.text();
      const json = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      if (res.ok) return json;
      const code = String(json.__type ?? 'Unknown').split('#').pop()!;
      if ((RETRYABLE.has(code) || res.status >= 500) && attempt < this.retries) { await backoff(attempt); continue; }
      throw new DynamoError(code, String(json.message ?? json.Message ?? text), res.status);
    }
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.random() * 50 * 2 ** attempt));
}

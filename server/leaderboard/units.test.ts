/** Unit tests: name sanitisation, sort-key encoding, identity helpers, SigV4, config. */
import { describe, expect, it } from 'vitest';
import { parseLimits } from './config';
import { FakeDynamo, LEADERBOARD_INDEXES } from './fake-dynamo';
import { DynamoError } from './dynamo';
import { readAsset } from './node-io';
import { marshalItem, signV4, unmarshalItem } from './dynamo';
import { clientIp, ipHashOf, playerHashOf, tagOf } from './identity';
import { better, sortableF64, sortKey } from './keys';
import { blocklistFilter, RESERVED_TERMS, sanitizeName, skeletonOf } from './names';

describe('display names', () => {
  const ok = (raw: string) => {
    const r = sanitizeName(raw, blocklistFilter([...RESERVED_TERMS, 'badword']));
    if (!r.ok) throw new Error(`${raw}: ${r.message}`);
    return r.name;
  };
  const code = (raw: unknown) => {
    const r = sanitizeName(raw, blocklistFilter([...RESERVED_TERMS, 'badword']));
    return r.ok ? 'ok' : r.code;
  };

  it('normalises Unicode (NFKC) and whitespace', () => {
    expect(ok('  Ａｄａ\t\n Lovelace  ')).toBe('Ada Lovelace');
    expect(ok('ﬁnn')).toBe('finn');
    expect(ok('Café')).toBe('Café');
    expect(ok('Ünïcödé 宇宙 🚀')).toBe('Ünïcödé 宇宙 🚀');
  });

  it('strips control, format (zero-width, bidi), private-use and blank-rendering characters', () => {
    expect(ok('A​d‍a⁠')).toBe('Ada');
    expect(ok('‮evil‬')).toBe('evil');
    expect(ok('x\u0000\u0007\u001b[31my')).toBe('x[31my');
    expect(ok('priv')).toBe('priv');
    expect(ok('aㅤb⠀cᅟd')).toBe('abcd');
    expect(ok('soft­hyphen﻿')).toBe('softhyphen');
  });

  it('caps combining marks and length; rejects empty and non-strings', () => {
    expect(Array.from(ok('Z̀́̂̃̄')).length).toBe(3);
    expect(code('́́abc')).toBe('ok');
    expect(code('a'.repeat(24))).toBe('ok');
    expect(code('a'.repeat(25))).toBe('bad-name');
    expect(code('🚀'.repeat(24))).toBe('ok'); // code points, not UTF-16 units
    expect(code('x'.repeat(300))).toBe('bad-name');
    expect(code(' ​‌ ')).toBe('bad-name');
    expect(code(42)).toBe('bad-name');
  });

  it('blocklist hook sees obfuscated spellings; reserved names are refused', () => {
    expect(skeletonOf('B4d-W0rd!!')).toBe('badwordii');
    expect(code('xX_b4dw0rd_Xx')).toBe('name-rejected');
    expect(code('Ｂａｄｗｏｒｄ')).toBe('name-rejected');
    expect(code('The Admin')).toBe('name-rejected');
    expect(code('s3nd1t team')).toBe('name-rejected');
    expect(code('Badger')).toBe('ok');
  });
});

describe('sort keys', () => {
  it('sortableF64 orders like the numbers', () => {
    const xs = [-Infinity, -1e300, -2.5, -1, -Number.MIN_VALUE, 0, Number.MIN_VALUE, 1e-300, 0.1, 1, 1.0000000000000002, 2, 3168.3, 1e300, Infinity];
    const enc = xs.map(sortableF64);
    expect([...enc].sort()).toEqual(enc);
    expect(sortableF64(-0)).toBe(sortableF64(0));
    for (const e of enc) expect(e).toMatch(/^[0-9a-f]{16}$/);
  });

  it('orders boards as the mission layer does, then by submission time, then player', () => {
    const a = { score: 9000, deltaV: 3100, missionTime: 400000 };
    const b = { score: 9000, deltaV: 3100.1, missionTime: 300000 };
    expect(better('combined', a, b, true)).toBe(true); // same score: lower delta-v
    expect(better('time', b, a, true)).toBe(true);
    expect(better('deltaV', a, a, true)).toBe(false); // ties never "improve"
    expect(better('combined', { ...a, score: 9001 }, a, true)).toBe(true);
    expect(better('combined', { ...a, score: 9001 }, a, false)).toBe(false);
    const k1 = sortKey('deltaV', a, 1000, 'aa', true);
    const k2 = sortKey('deltaV', a, 2000, 'aa', true);
    const k3 = sortKey('deltaV', a, 2000, 'ab', true);
    expect(k1 < k2 && k2 < k3).toBe(true);
  });
});

describe('identity', () => {
  it('hashes secrets, derives a stable 5-character tag, and reads the CloudFront viewer address', async () => {
    const h = await playerHashOf('s'.repeat(43));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await playerHashOf('s'.repeat(43))).toBe(h);
    expect(await tagOf(h)).toMatch(/^[0-9a-hjkmnp-tv-z]{5}$/);
    expect(clientIp({ 'cloudfront-viewer-address': '203.0.113.9:443' }, 'x')).toBe('203.0.113.9');
    expect(clientIp({ 'cloudfront-viewer-address': '2001:db8::1:51234' }, 'x')).toBe('2001:db8::1');
    expect(clientIp({ 'cloudfront-viewer-address': '<script>:1' }, 'fallback')).toBe('fallback');
    expect(clientIp({}, 'fallback')).toBe('fallback');
    const d1 = await ipHashOf('203.0.113.9', 'salt-salt-salt-salt', Date.UTC(2026, 0, 1, 1));
    expect(d1).toBe(await ipHashOf('203.0.113.9', 'salt-salt-salt-salt', Date.UTC(2026, 0, 1, 23)));
    expect(d1).not.toBe(await ipHashOf('203.0.113.9', 'salt-salt-salt-salt', Date.UTC(2026, 0, 2, 1)));
    expect(d1).not.toBe(await ipHashOf('203.0.113.9', 'other-salt-other-salt', Date.UTC(2026, 0, 1, 1)));
  });
});

describe('dynamo client', () => {
  it('signs requests with SigV4 (AWS documentation test vector, IAM ListUsers)', async () => {
    const h = await signV4(
      {
        method: 'GET',
        host: 'iam.amazonaws.com',
        path: '/',
        query: 'Action=ListUsers&Version=2010-05-08',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: '',
        region: 'us-east-1',
        service: 'iam',
        amzDate: '20150830T123600Z',
      },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    );
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('marshals and unmarshals items', () => {
    const o = { pk: 'E#m#1', n: 3.5, ok: true, none: null, m: { a: [1, 'x'] } };
    expect(unmarshalItem(marshalItem(o))).toEqual(o);
    expect(marshalItem({ a: 1 })).toEqual({ a: { N: '1' } });
  });

  it('parses rate-limit settings', () => {
    expect(parseLimits('6/60, 40/3600', [])).toEqual([[6, 60], [40, 3600]]);
    expect(parseLimits(undefined, [[1, 2]])).toEqual([[1, 2]]);
    expect(() => parseLimits('6 per minute', [])).toThrow();
  });
});

describe('infra/leaderboard.yaml', () => {
  it('defines exactly the indexes, keys and projections the store uses, plus TTL and PITR', async () => {
    const y = new TextDecoder().decode(await readAsset('../../infra/leaderboard.yaml', import.meta.url));
    const found: Record<string, { pk: string; sk: string; include: string[] }> = {};
    const re = /- IndexName: (\w+)\s+KeySchema:\s+- \{ AttributeName: (\w+), KeyType: HASH \}\s+- \{ AttributeName: (\w+), KeyType: RANGE \}\s+Projection: \{ ProjectionType: INCLUDE, NonKeyAttributes: \[([^\]]*)\] \}/g;
    for (const m of y.matchAll(re)) found[m[1]] = { pk: m[2], sk: m[3], include: m[4].split(',').map((x) => x.trim()) };
    expect(found).toEqual(LEADERBOARD_INDEXES);
    expect(y).toMatch(/AttributeName: expiresAt\s+Enabled: true/);
    expect(y).toMatch(/PointInTimeRecoveryEnabled: true/);
    expect(y).toMatch(/BillingMode: PAY_PER_REQUEST/);
  });
});

describe('fake DynamoDB enforces the request rules real DynamoDB does', () => {
  const db = () => new FakeDynamo(LEADERBOARD_INDEXES);
  const rejects = async (op: string, input: Record<string, unknown>, re: RegExp) => {
    const e = await db().send(op, { TableName: 't', ...input }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DynamoError);
    expect((e as DynamoError).code).toBe('ValidationException');
    expect((e as DynamoError).message).toMatch(re);
  };

  it('rejects unused and missing expression names and values (the board query without a cursor)', async () => {
    // The request the read function sent in production.
    await rejects('Query', { IndexName: 'combined', KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'cPk', '#sk': 'cSk' }, ExpressionAttributeValues: { ':pk': { S: 'm#1#p' } }, Limit: 5 }, /unused in expressions: keys: \{#sk\}/);
    await rejects('Query', { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' }, ExpressionAttributeValues: { ':pk': { S: 'x' }, ':extra': { S: 'y' } } }, /unused.*:extra/);
    await rejects('Query', { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' } }, /missing placeholder :pk/);
    await rejects('PutItem', { Item: { pk: { S: 'a' }, sk: { S: 'b' } }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' }, ExpressionAttributeValues: {} }, /must not be empty/);
  });

  it('rejects reserved words used bare, bad start keys, COUNT with projection, empty keys, bad numbers, oversized items', async () => {
    await rejects('PutItem', { Item: { pk: { S: 'a' }, sk: { S: 'b' } }, ConditionExpression: 'attribute_not_exists(name)' }, /reserved keyword: name/);
    await rejects('Query', { IndexName: 'time', KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'tPk' }, ExpressionAttributeValues: { ':pk': { S: 'x' } }, ExclusiveStartKey: { tPk: { S: 'x' }, tSk: { S: 'y' } } }, /starting key/);
    await rejects('Query', { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' }, ExpressionAttributeValues: { ':pk': { S: 'x' } }, Select: 'COUNT', ProjectionExpression: '#pk' }, /COUNT/);
    await rejects('Query', { IndexName: 'time', KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'tPk' }, ExpressionAttributeValues: { ':pk': { S: 'x' } }, ConsistentRead: true }, /Consistent/);
    await rejects('GetItem', { Key: { pk: { S: '' }, sk: { S: 'b' } } }, /empty string/);
    await rejects('PutItem', { Item: { pk: { S: 'a' }, sk: { S: 'b' }, cPk: { S: '' } } }, /empty string/);
    await rejects('PutItem', { Item: { pk: { S: 'a' }, sk: { S: 'b' }, n: { N: 'NaN' } } }, /invalid number/);
    await rejects('PutItem', { Item: { pk: { S: 'a' }, sk: { S: 'b' }, big: { S: 'x'.repeat(410 * 1024) } } }, /size/);
    await rejects('Query', { KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' }, ExpressionAttributeValues: { ':pk': { S: 'x' } }, Limit: 0 }, /Limit/);
  });
});

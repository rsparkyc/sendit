/**
 * In-memory stand-in for the DynamoDB calls the store makes, for tests. It
 * interprets the requests (it does not just record them), with DynamoDB's
 * semantics for exactly the expression forms store.ts uses, and throws on any
 * other form so a change in the store cannot silently go untested:
 *
 *  GetItem    Key
 *  PutItem    Item, ConditionExpression of terms joined by AND / OR (no parentheses):
 *             attribute_not_exists(#a), #a = :v, #a < :v
 *  UpdateItem Key, UpdateExpression "ADD #a :v SET #b = if_not_exists(#b, :v)" (clauses in
 *             any order; SET also "#b = :v"), the same ConditionExpression forms
 *  TransactWriteItems  Put only (each validated as a PutItem, with its own condition);
 *             all-or-nothing: any failed condition cancels all with
 *             TransactionCanceledException (CancellationReasons per item); at most
 *             100 items, at most one operation per item
 *  Query      table or a GSI; KeyConditionExpression "#pk = :v" optionally
 *             "AND #sk < :v | #sk > :v | begins_with(#sk, :v)"; ScanIndexForward,
 *             Limit, Select COUNT, ExclusiveStartKey / LastEvaluatedKey, with a page
 *             size cap standing in for the 1 MB page limit
 *
 * Sparse GSIs (an item is indexed only if it has both index key attributes)
 * and INCLUDE projections are modelled.
 *
 * REQUEST VALIDATION, as real DynamoDB does it (validateRequest / validateItem):
 * every ExpressionAttributeNames / Values entry must be used by an expression
 * and every placeholder used must be defined; the maps must not be empty;
 * reserved words may not appear bare in expressions; Select COUNT cannot be
 * combined with a projection; an index query's ExclusiveStartKey must carry
 * the index keys and the table keys; key attributes (table and index) must be
 * non-empty strings; numbers must be well-formed and at most 38 digits; items
 * at most 400 KB; Limit a positive integer; unknown request fields refused.
 *
 * NOT modelled: capacity, throttling and its retries, item size limits (400
 * KB) and the byte-based 1 MB page limit (a fixed item count is used), GSI
 * replication lag (the fake's indexes are always consistent; the real ones
 * are eventually consistent, so a board read right after a submission may not
 * show it yet), TTL deletion (expired items stay; rate windows are separate
 * items anyway), String comparison by UTF-8 bytes rather than UTF-16 units
 * (identical for the ASCII keys used), transactions, and IAM.
 */
import { DynamoError, type AttributeValue, type DynamoApi, type Item } from './dynamo';

export interface FakeIndex {
  readonly pk: string;
  readonly sk: string;
  /** Non-key attributes projected (INCLUDE). */
  readonly include: readonly string[];
}

export class FakeDynamo implements DynamoApi {
  readonly items = new Map<string, Item>();
  readonly calls: { op: string; index?: string }[] = [];

  constructor(
    readonly indexes: Readonly<Record<string, FakeIndex>>,
    /** Items per Query page before LastEvaluatedKey (stands in for the 1 MB limit). */
    readonly pageSize = 1000,
  ) {}

  private static id(key: Item): string {
    return `${str(key.pk)}\u0000${str(key.sk)}`;
  }

  async send(op: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ op, index: input.IndexName as string | undefined });
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, AttributeValue>;
    validateRequest(op, input, this.indexes);
    switch (op) {
      case 'GetItem': {
        const it = this.items.get(FakeDynamo.id(input.Key as Item));
        return it ? { Item: clone(it) } : {};
      }
      case 'PutItem': {
        const item = input.Item as Item;
        validateItem(item, this.indexes);
        const id = FakeDynamo.id(item);
        if (input.ConditionExpression) check(input.ConditionExpression as string, this.items.get(id), names, values);
        this.items.set(id, clone(item));
        return {};
      }
      case 'UpdateItem': {
        const key = input.Key as Item;
        const id = FakeDynamo.id(key);
        const cur = this.items.get(id);
        if (input.ConditionExpression) check(input.ConditionExpression as string, cur, names, values);
        const next: Item = cur ? clone(cur) : clone(key);
        applyUpdate(input.UpdateExpression as string, next, names, values);
        validateItem(next, this.indexes);
        this.items.set(id, next);
        return {};
      }
      case 'Query':
        return this.query(input, names, values);
      case 'TransactWriteItems':
        return this.transact(input);
      default:
        throw new Error(`FakeDynamo: unsupported operation ${op}`);
    }
  }

  private transact(input: Record<string, unknown>): Record<string, unknown> {
    const tx = input.TransactItems as Record<string, Record<string, unknown>>[];
    if (!Array.isArray(tx) || tx.length === 0 || tx.length > 100) invalid('TransactItems must hold 1-100 items');
    const seen = new Set<string>();
    for (const t of tx) {
      if (Object.keys(t).join() !== 'Put') throw new Error('FakeDynamo: only Put is supported in transactions');
      validateRequest('PutItem', t.Put, this.indexes);
      validateItem(t.Put.Item as Item, this.indexes);
      const id = FakeDynamo.id(t.Put.Item as Item);
      if (seen.has(id)) invalid('Transaction request cannot include multiple operations on one item');
      seen.add(id);
    }
    const reasons = tx.map((t) => {
      const p = t.Put;
      if (!p.ConditionExpression) return 'None';
      try {
        check(p.ConditionExpression as string, this.items.get(FakeDynamo.id(p.Item as Item)), (p.ExpressionAttributeNames ?? {}) as Record<string, string>, (p.ExpressionAttributeValues ?? {}) as Record<string, AttributeValue>);
        return 'None';
      } catch (e) {
        if (e instanceof DynamoError && e.code === 'ConditionalCheckFailedException') return 'ConditionalCheckFailed';
        throw e;
      }
    });
    if (reasons.some((r) => r !== 'None')) throw new DynamoError('TransactionCanceledException', `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.join(', ')}]`, 400);
    for (const t of tx) this.items.set(FakeDynamo.id(t.Put.Item as Item), clone(t.Put.Item as Item));
    return {};
  }

  private query(input: Record<string, unknown>, names: Record<string, string>, values: Record<string, AttributeValue>): Record<string, unknown> {
    const indexName = input.IndexName as string | undefined;
    const idx = indexName ? this.indexes[indexName] : { pk: 'pk', sk: 'sk', include: null };
    if (!idx) throw new DynamoError('ValidationException', `no index ${indexName}`, 400);
    const m = /^(#\w+) = (:\w+)(?: AND (?:(#\w+) ([<>]) (:\w+)|begins_with\((#\w+), (:\w+)\)))?$/.exec(input.KeyConditionExpression as string);
    if (!m) throw new Error(`FakeDynamo: unsupported KeyConditionExpression ${String(input.KeyConditionExpression)}`);
    const [, pkName, pkVal, skName1, op, skVal1, skName2, skVal2] = m;
    if (names[pkName] !== idx.pk) throw new DynamoError('ValidationException', 'key condition must use the partition key', 400);
    const skName = skName1 ?? skName2;
    if (skName && names[skName] !== idx.sk) throw new DynamoError('ValidationException', 'key condition must use the sort key', 400);
    const pkv = str(values[pkVal]);
    let rows = [...this.items.values()].filter((it) => it[idx.pk] !== undefined && it[idx.sk] !== undefined && str(it[idx.pk]) === pkv);
    if (skName1) rows = rows.filter((it) => (op === '<' ? str(it[idx.sk]) < str(values[skVal1]) : str(it[idx.sk]) > str(values[skVal1])));
    if (skName2) rows = rows.filter((it) => str(it[idx.sk]).startsWith(str(values[skVal2])));
    // Sort by index sort key, then table key (DynamoDB's order for equal GSI sort keys is unspecified; ours never tie).
    rows.sort((a, b) => cmp(str(a[idx.sk]), str(b[idx.sk])) || cmp(FakeDynamo.id(a), FakeDynamo.id(b)));
    if (input.ScanIndexForward === false) rows.reverse();
    const start = input.ExclusiveStartKey as Item | undefined;
    if (start) {
      const i = rows.findIndex((r) => FakeDynamo.id(r) === FakeDynamo.id(start));
      rows = i < 0 ? [] : rows.slice(i + 1);
    }
    const limit = Math.min(Number(input.Limit ?? Infinity), this.pageSize);
    const page = rows.slice(0, limit);
    const more = rows.length > page.length;
    const last = page[page.length - 1];
    const lastKey = more && last ? pick(last, ['pk', 'sk', idx.pk, idx.sk]) : undefined;
    if (input.Select === 'COUNT') return { Count: page.length, ...(lastKey ? { LastEvaluatedKey: lastKey } : {}) };
    const proj = (it: Item): Item => (idx.include ? pick(it, ['pk', 'sk', idx.pk, idx.sk, ...idx.include]) : clone(it));
    return { Items: page.map(proj), Count: page.length, ...(lastKey ? { LastEvaluatedKey: lastKey } : {}) };
  }
}

function str(a: AttributeValue | undefined): string {
  if (!a || !('S' in a)) throw new Error('FakeDynamo: expected a string attribute');
  return a.S;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function pick(it: Item, keys: readonly string[]): Item {
  const o: Item = {};
  for (const k of keys) if (it[k] !== undefined) o[k] = clone(it[k]);
  return o;
}

function compare(a: AttributeValue, b: AttributeValue): number {
  if ('N' in a && 'N' in b) return Number(a.N) - Number(b.N);
  if ('S' in a && 'S' in b) return cmp(a.S, b.S);
  throw new DynamoError('ValidationException', 'incomparable types', 400);
}

function check(expr: string, item: Item | undefined, names: Record<string, string>, values: Record<string, AttributeValue>): void {
  const term = (t: string): boolean => {
    let m = /^attribute_not_exists\((#\w+)\)$/.exec(t);
    if (m) return item?.[names[m[1]]] === undefined;
    m = /^(#\w+) ([=<]) (:\w+)$/.exec(t);
    if (m) {
      const a = item?.[names[m[1]]];
      if (a === undefined) return false;
      const c = compare(a, values[m[3]]);
      return m[2] === '=' ? c === 0 : c < 0;
    }
    throw new Error(`FakeDynamo: unsupported condition term ${t}`);
  };
  const ok = expr.split(' OR ').some((disj) => disj.split(' AND ').every((t) => term(t.trim())));
  if (!ok) throw new DynamoError('ConditionalCheckFailedException', 'The conditional request failed', 400);
}

function applyUpdate(expr: string, item: Item, names: Record<string, string>, values: Record<string, AttributeValue>): void {
  const parts = expr.split(/\s(?=ADD |SET )/);
  for (const part of parts) {
    const m = /^(ADD|SET) (.+)$/.exec(part.trim());
    if (!m) throw new Error(`FakeDynamo: unsupported update ${part}`);
    for (const clause of m[2].split(/,(?![^(]*\))/).map((x) => x.trim())) {
      if (m[1] === 'ADD') {
        const a = /^(#\w+) (:\w+)$/.exec(clause);
        if (!a) throw new Error(`FakeDynamo: unsupported ADD ${clause}`);
        const cur = item[names[a[1]]];
        const inc = values[a[2]];
        if (!('N' in inc)) throw new Error('FakeDynamo: ADD needs a number');
        item[names[a[1]]] = { N: String((cur && 'N' in cur ? Number(cur.N) : 0) + Number(inc.N)) };
      } else {
        let s = /^(#\w+) = if_not_exists\((#\w+), (:\w+)\)$/.exec(clause);
        if (s) {
          if (item[names[s[2]]] === undefined) item[names[s[1]]] = clone(values[s[3]]);
          else item[names[s[1]]] = clone(item[names[s[2]]]);
          continue;
        }
        s = /^(#\w+) = (:\w+)$/.exec(clause);
        if (!s) throw new Error(`FakeDynamo: unsupported SET ${clause}`);
        item[names[s[1]]] = clone(values[s[2]]);
      }
    }
  }
}

/** The indexes infra/leaderboard.yaml defines (kept in sync by a test). */
export const LEADERBOARD_INDEXES: Readonly<Record<string, FakeIndex>> = {
  combined: { pk: 'cPk', sk: 'cSk', include: ['pid', 'name', 'tag', 'cV'] },
  deltaV: { pk: 'dPk', sk: 'dSk', include: ['pid', 'name', 'tag', 'dV'] },
  time: { pk: 'tPk', sk: 'tSk', include: ['pid', 'name', 'tag', 'tV'] },
};

// ------------------------------------------------------------ validation

/** Part of DynamoDB's reserved-word list (all words the store could plausibly use bare). */
export const RESERVED = new Set(
  'ABORT ACTION ADD ALL AND ANY AS ASC AT ATTRIBUTE BETWEEN BY CASE COUNT CREATE DATA DATE DAY DELETE DESC EXISTS FROM GET HASH HIDDEN IN INDEX IS KEY KEYS LIMIT NAME NOT NULL NUMBER OF ON OR ORDER PLAN RANGE RANK REV SCORE SELECT SET SIZE STATUS STRING TABLE TAG TIME TIMESTAMP TTL TYPE UPDATE USER VALUE VALUES VERSION'.split(' '),
);

const ALLOWED: Record<string, readonly string[]> = {
  GetItem: ['TableName', 'Key', 'ConsistentRead', 'ProjectionExpression', 'ExpressionAttributeNames'],
  PutItem: ['TableName', 'Item', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'],
  UpdateItem: ['TableName', 'Key', 'UpdateExpression', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'],
  TransactWriteItems: ['TransactItems', 'ClientRequestToken', 'ReturnConsumedCapacity'],
  Query: ['TableName', 'IndexName', 'KeyConditionExpression', 'FilterExpression', 'ProjectionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues', 'ScanIndexForward', 'Limit', 'Select', 'ExclusiveStartKey', 'ConsistentRead'],
};
const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'ADD', 'SET', 'REMOVE', 'DELETE', 'attribute_not_exists', 'attribute_exists', 'if_not_exists', 'begins_with', 'contains', 'size', 'list_append']);

function invalid(msg: string): never {
  throw new DynamoError('ValidationException', msg, 400);
}

export function validateRequest(op: string, input: Record<string, unknown>, indexes: Readonly<Record<string, FakeIndex>>): void {
  const allowed = ALLOWED[op];
  if (!allowed) return;
  for (const k of Object.keys(input)) if (!allowed.includes(k)) invalid(`unexpected request field ${k}`);
  const exprs = ['KeyConditionExpression', 'ConditionExpression', 'UpdateExpression', 'FilterExpression', 'ProjectionExpression'].map((k) => input[k]).filter((x): x is string => typeof x === 'string');
  const text = exprs.join(' ');
  for (const [field, prefix] of [['ExpressionAttributeNames', '#'], ['ExpressionAttributeValues', ':']] as const) {
    const map = input[field] as Record<string, unknown> | undefined;
    const used = new Set(text.match(prefix === '#' ? /#\w+/g : /:\w+/g) ?? []);
    if (map !== undefined) {
      if (Object.keys(map).length === 0) invalid(`${field} must not be empty`);
      const unused = Object.keys(map).filter((k) => !used.has(k));
      if (unused.length > 0) invalid(`Value provided in ${field} unused in expressions: keys: {${unused.join(', ')}}`);
      if (prefix === ':') for (const v of Object.values(map)) validateValue(v as AttributeValue);
    }
    for (const u of used) if (!map || !(u in map)) invalid(`${field} missing placeholder ${u}`);
  }
  // Bare words in expressions: functions and keywords only; attribute names must be placeholders if reserved.
  for (const w of text.replace(/[#:]\w+/g, ' ').match(/[A-Za-z_]\w*/g) ?? []) {
    if (KEYWORDS.has(w) || KEYWORDS.has(w.toUpperCase())) continue;
    if (RESERVED.has(w.toUpperCase())) invalid(`Attribute name is a reserved keyword; reserved keyword: ${w}`);
  }
  if (input.Limit !== undefined && !(Number.isInteger(input.Limit) && (input.Limit as number) > 0)) invalid('Limit must be a positive integer');
  if (op === 'Query') {
    if (input.Select === 'COUNT' && input.ProjectionExpression !== undefined) invalid('Cannot specify Select COUNT with a ProjectionExpression');
    const idx = input.IndexName as string | undefined;
    if (idx !== undefined && !indexes[idx]) invalid(`The table does not have the specified index: ${idx}`);
    if (idx !== undefined && input.ConsistentRead === true) invalid('Consistent reads are not supported on global secondary indexes');
    const start = input.ExclusiveStartKey as Item | undefined;
    if (start) {
      const need = idx ? ['pk', 'sk', indexes[idx].pk, indexes[idx].sk] : ['pk', 'sk'];
      const have = Object.keys(start).sort().join();
      if (have !== [...new Set(need)].sort().join()) invalid(`The provided starting key is invalid: needs exactly ${need.join(', ')}`);
    }
  }
  if (op === 'GetItem' || op === 'UpdateItem') {
    const key = input.Key as Item;
    if (Object.keys(key).sort().join() !== 'pk,sk') invalid('The provided key element does not match the schema');
    for (const k of ['pk', 'sk']) keyString(key[k], k);
  }
}

function keyString(a: AttributeValue | undefined, name: string): void {
  if (!a || !('S' in a)) invalid(`key attribute ${name} must be a string`);
  if (a.S.length === 0) invalid(`One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: ${name}`);
}

function validateValue(a: AttributeValue): void {
  if ('N' in a) {
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(a.N)) invalid(`invalid number ${a.N}`);
    const digits = a.N.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '');
    if (digits.length > 38) invalid(`number ${a.N} has more than 38 significant digits`);
  } else if ('M' in a) Object.values(a.M).forEach(validateValue);
  else if ('L' in a) a.L.forEach(validateValue);
}

export function validateItem(item: Item, indexes: Readonly<Record<string, FakeIndex>>): void {
  keyString(item.pk, 'pk');
  keyString(item.sk, 'sk');
  for (const ix of Object.values(indexes)) for (const k of [ix.pk, ix.sk]) if (item[k] !== undefined) keyString(item[k], k);
  Object.values(item).forEach(validateValue);
  // Item size: attribute names plus values (UTF-8 length of the JSON is a close upper bound).
  const size = Object.entries(item).reduce((n, [k, v]) => n + new TextEncoder().encode(k).length + new TextEncoder().encode(JSON.stringify(v)).length, 0);
  if (size > 400 * 1024) invalid('Item size has exceeded the maximum allowed size');
}

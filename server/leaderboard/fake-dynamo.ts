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
 *  Query      table or a GSI; KeyConditionExpression "#pk = :v" optionally
 *             "AND #sk < :v | #sk > :v | begins_with(#sk, :v)"; ScanIndexForward,
 *             Limit, Select COUNT, ExclusiveStartKey / LastEvaluatedKey, with a page
 *             size cap standing in for the 1 MB page limit
 *
 * Sparse GSIs (an item is indexed only if it has both index key attributes)
 * and INCLUDE projections are modelled.
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
    switch (op) {
      case 'GetItem': {
        const it = this.items.get(FakeDynamo.id(input.Key as Item));
        return it ? { Item: clone(it) } : {};
      }
      case 'PutItem': {
        const item = input.Item as Item;
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
        this.items.set(id, next);
        return {};
      }
      case 'Query':
        return this.query(input, names, values);
      default:
        throw new Error(`FakeDynamo: unsupported operation ${op}`);
    }
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

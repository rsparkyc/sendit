/**
 * Leaderboard storage on one DynamoDB table (on-demand) with three sparse GSIs.
 *
 * TABLE  pk (S), sk (S); TTL attribute `expiresAt` (epoch seconds).
 *
 *  Entries: a player's GROUP per mission version, all under one partition
 *  pk = E#<mission>#<version>, sorted together by sk:
 *    sk = P#<playerHash>           the ALL-SITES entry (site '*'): on each board,
 *                                  the player's best over every launch site
 *    sk = P#<playerHash>#<site>    one SITE entry per launch site flown: on each
 *                                  board, the player's best from that site
 *  Every entry item carries
 *    name, tag, pid, rev (optimistic-concurrency counter), hidden, created, updated
 *    c / d / t: the result on the combined / delta-v / time board
 *       { score, deltaV, missionTime, at (ms), digest, planHash, physics, site, status, reason? }
 *       (`site`: where the flight launched; on the all-sites entry, the site the best came from)
 *    cPlan / dPlan / tPlan: the encoded plan of that result (for re-verification)
 *    cPk, cSk, cV / dPk, dSk, dV / tPk, tSk, tV: GSI keys and a compact copy of
 *       the slot's values ("score|deltaV|missionTime|at|site"), present only while
 *       that slot is valid and the entry is not hidden (sparse indexes)
 *       xPk = <mission>#<version>#<physicsVersion>#<site or *>, xSk = keys.ts sortKey
 *  So each board partition holds each player at most once: a site partition
 *  holds site entries, the '*' partition holds all-sites entries.
 *
 *  INVARIANT (kept by every writer, in one transaction per group): the
 *  all-sites slot of a board is the best valid current-physics slot among the
 *  player's site entries on that board (ties: the earlier submission), and
 *  `hidden` is the same on every item of the group. Every group write puts
 *  the all-sites item with its rev condition, so it serialises the group.
 *
 *  Score cache, one per (physics version, mission version, exact plan):
 *    pk = S#<sha256>  sk = '-'   verdict fields; expiresAt = +90 days
 *
 *  Rate counter, one per (who, window):
 *    pk = R#<p|ip>#<hash>#<window>#<bucket>  sk = '-'   n; expiresAt = window end + 60 s
 *
 * GSIs `combined`, `deltaV`, `time`: partition xPk, sort xSk, projection
 * INCLUDE name, tag, pid and that board's xV (index items stay ~0.4 KB, which
 * is what own-rank COUNT queries pay for per row). Because the physics version is
 * part of the GSI partition, entries verified under an older physics build
 * drop out of the boards the moment the server's physics version changes,
 * until re-verification rewrites them (reverify.ts).
 *
 * Every read is a GetItem or a Query on a known partition: no scans.
 */
import { DynamoError, marshalItem, unmarshalItem, type DynamoApi, type Item, type Plain } from './dynamo';
import { BOARDS, SLOT, type BoardId } from './keys';

/** Site key of the all-sites entry and board partition. */
export const ALL = '*';

export interface Slot {
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
  /** Submission time of this result, ms. */
  readonly at: number;
  /** Replay digest. */
  readonly digest: string;
  readonly planHash: string;
  /** Physics version this result was verified under. */
  readonly physics: string;
  /** Launch site of the flight (absent only on entries written before sites existed). */
  readonly site?: string;
  readonly status: 'valid' | 'invalid';
  readonly reason?: string;
  /** Precomputed board sort key. */
  readonly key: string;
}

export interface Entry {
  readonly mission: string;
  readonly version: string;
  readonly playerHash: string;
  /** Launch site id, or ALL for the all-sites entry. */
  readonly site: string;
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
  readonly hidden: boolean;
  readonly created: number;
  readonly updated: number;
  /** Incremented on every write; 0 for an entry not yet stored. */
  readonly rev: number;
  readonly slots: Partial<Record<BoardId, Slot>>;
  readonly plans: Partial<Record<BoardId, string>>;
}

/** A player's entries for one mission version. */
export interface Group {
  readonly mission: string;
  readonly version: string;
  readonly playerHash: string;
  readonly all: Entry | null;
  /** Site entries by site id. */
  readonly sites: ReadonlyMap<string, Entry>;
}

export interface BoardRow {
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
  readonly site: string;
  readonly values: { readonly score: number; readonly deltaV: number; readonly missionTime: number; readonly at: number };
  readonly key: string;
}

export interface CachedVerdict {
  readonly status: string;
  readonly success: boolean;
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
  readonly digest: string;
  readonly outcome: string;
  readonly reason: string;
  readonly objectives: readonly { kind: string; ok: boolean; detail: string }[];
}

export const INDEX: Record<BoardId, string> = { combined: 'combined', deltaV: 'deltaV', time: 'time' };

export function entryPk(mission: string, version: string): string {
  return `E#${mission}#${version}`;
}

export function entrySk(playerHash: string, site: string): string {
  return site === ALL ? `P#${playerHash}` : `P#${playerHash}#${site}`;
}

/** Board partition of a mission version under a physics version, for one site or ALL. */
export function boardPk(mission: string, version: string, physics: string, site: string): string {
  return `${mission}#${version}#${physics}#${site}`;
}

/** A fresh (unstored) entry. */
export function newEntry(g: { mission: string; version: string; playerHash: string }, site: string, base: Pick<Entry, 'pid' | 'name' | 'tag' | 'hidden' | 'created'>): Entry {
  return { mission: g.mission, version: g.version, playerHash: g.playerHash, site, ...base, updated: base.created, rev: 0, slots: {}, plans: {} };
}

/** Most items one group write may touch (DynamoDB transactions take up to 100). */
const MAX_GROUP_WRITE = 100;

export class Store {
  constructor(private readonly db: DynamoApi, private readonly table: string) {}

  // ------------------------------------------------------------ rate limiting

  /**
   * Count one request against `key` in the current fixed window. Returns
   * false (and counts nothing) once `limit` requests were counted. One write.
   */
  async hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<boolean> {
    const bucket = Math.floor(nowMs / 1000 / windowSec);
    try {
      await this.db.send('UpdateItem', {
        TableName: this.table,
        Key: { pk: { S: `R#${key}#${windowSec}#${bucket}` }, sk: { S: '-' } },
        UpdateExpression: 'ADD #n :one SET #e = if_not_exists(#e, :exp)',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :lim',
        ExpressionAttributeNames: { '#n': 'n', '#e': 'expiresAt' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':lim': { N: String(limit) }, ':exp': { N: String((bucket + 1) * windowSec + 60) } },
      });
      return true;
    } catch (e) {
      if (e instanceof DynamoError && e.code === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  // ------------------------------------------------------------- score cache

  async getCached(hash: string): Promise<CachedVerdict | null> {
    const out = await this.db.send('GetItem', { TableName: this.table, Key: { pk: { S: `S#${hash}` }, sk: { S: '-' } } });
    const item = out.Item as Item | undefined;
    if (!item) return null;
    const o = unmarshalItem(item);
    return JSON.parse(String(o.v)) as CachedVerdict;
  }

  async putCached(hash: string, v: CachedVerdict, nowMs: number, ttlDays = 90): Promise<void> {
    await this.db.send('PutItem', {
      TableName: this.table,
      Item: marshalItem({ pk: `S#${hash}`, sk: '-', v: JSON.stringify(v), expiresAt: Math.floor(nowMs / 1000) + ttlDays * 86400 }),
    });
  }

  // ------------------------------------------------------------------ entries

  /** A player's group (all-sites entry and site entries): one strongly consistent Query. */
  async getGroup(mission: string, version: string, playerHash: string): Promise<Group> {
    const items = await this.queryAll(entryPk(mission, version), `P#${playerHash}`, true);
    return groupOf(mission, version, playerHash, items.map(entryOf));
  }

  /**
   * Write the changed entries of one group atomically, each only if its
   * stored rev is still `entry.rev` (or it does not exist and rev is 0).
   * One entry: a conditional PutItem; more: one TransactWriteItems. Returns
   * false on a lost race (nothing written).
   */
  async putEntries(entries: readonly Entry[]): Promise<boolean> {
    if (entries.length === 0) return true;
    if (entries.length > MAX_GROUP_WRITE) throw new Error('group write too large');
    const puts = entries.map((e) => ({ TableName: this.table, Item: itemOf({ ...e, rev: e.rev + 1 }), ...revCondition(e.rev) }));
    try {
      if (puts.length === 1) await this.db.send('PutItem', puts[0]);
      else await this.db.send('TransactWriteItems', { TransactItems: puts.map((p) => ({ Put: p })) });
      return true;
    } catch (e) {
      if (e instanceof DynamoError && (e.code === 'ConditionalCheckFailedException' || e.code === 'TransactionCanceledException' || e.code === 'TransactionConflictException')) return false;
      throw e;
    }
  }

  /** One entry (kept for simple callers). */
  async putEntry(entry: Entry): Promise<boolean> {
    return this.putEntries([entry]);
  }

  /** All groups of a mission version (admin / re-verification), streamed page by page. */
  async *groups(mission: string, version: string): AsyncGenerator<Group> {
    let cur: Entry[] = [];
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :p)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: entryPk(mission, version) }, ':p': { S: 'P#' } },
        ConsistentRead: true,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      for (const i of (out.Items as Item[]) ?? []) {
        const e = entryOf(i);
        if (cur.length > 0 && cur[0].playerHash !== e.playerHash) {
          yield groupOf(mission, version, cur[0].playerHash, cur);
          cur = [];
        }
        cur.push(e);
      }
      start = out.LastEvaluatedKey;
    } while (start);
    if (cur.length > 0) yield groupOf(mission, version, cur[0].playerHash, cur);
  }

  /** Group by public id (16 hex digits of the player hash); null if none or ambiguous. */
  async findByPid(mission: string, version: string, pid: string): Promise<Group | null> {
    const items = (await this.queryAll(entryPk(mission, version), `P#${pid}`, false)).map(entryOf);
    if (items.length === 0 || items.some((e) => e.playerHash !== items[0].playerHash)) return null;
    return groupOf(mission, version, items[0].playerHash, items);
  }

  private async queryAll(pk: string, prefix: string, consistent: boolean): Promise<Item[]> {
    const items: Item[] = [];
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :p)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: pk }, ':p': { S: prefix } },
        ...(consistent ? { ConsistentRead: true } : {}),
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      items.push(...((out.Items as Item[]) ?? []));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  // ------------------------------------------------------------------- boards

  /** Top rows of a board partition after `afterKey` (exclusive), best first, up to `limit` (fewer only at the end). Eventually consistent. */
  async board(board: BoardId, pk: string, limit: number, afterKey?: string): Promise<BoardRow[]> {
    const s = SLOT[board];
    const rows: BoardRow[] = [];
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        IndexName: INDEX[board],
        KeyConditionExpression: afterKey ? '#pk = :pk AND #sk > :after' : '#pk = :pk',
        // DynamoDB rejects unused names / values: #sk only with a cursor.
        ExpressionAttributeNames: { '#pk': `${s}Pk`, ...(afterKey ? { '#sk': `${s}Sk` } : {}) },
        ExpressionAttributeValues: { ':pk': { S: pk }, ...(afterKey ? { ':after': { S: afterKey } } : {}) },
        ScanIndexForward: true,
        Limit: limit - rows.length,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      for (const i of (out.Items as Item[]) ?? []) {
        const o = unmarshalItem(i);
        const [score, deltaV, missionTime, at, site = ''] = String(o[`${s}V`]).split('|');
        rows.push({ pid: String(o.pid), name: String(o.name), tag: String(o.tag), site, values: { score: Number(score), deltaV: Number(deltaV), missionTime: Number(missionTime), at: Number(at) }, key: String(o[`${s}Sk`]) });
      }
      // A page can end early (1 MB): continue until `limit` rows or the end of the partition.
      start = out.LastEvaluatedKey;
    } while (start && rows.length < limit);
    return rows;
  }

  /**
   * Number of rows ranked above `key` on a board partition (so rank = count + 1),
   * counting at most `max` (null beyond). A COUNT query over the rows above:
   * its read cost grows with the rank (see infra/leaderboard.yaml notes).
   */
  async countAbove(board: BoardId, pk: string, key: string, max: number): Promise<number | null> {
    const s = SLOT[board];
    let n = 0;
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        IndexName: INDEX[board],
        KeyConditionExpression: '#pk = :pk AND #sk < :k',
        ExpressionAttributeNames: { '#pk': `${s}Pk`, '#sk': `${s}Sk` },
        ExpressionAttributeValues: { ':pk': { S: pk }, ':k': { S: key } },
        Select: 'COUNT',
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      n += Number(out.Count ?? 0);
      if (n > max) return null;
      start = out.LastEvaluatedKey;
    } while (start);
    return n;
  }
}

function revCondition(rev: number): Record<string, unknown> {
  return rev === 0
    ? { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } }
    : { ConditionExpression: '#rev = :rev', ExpressionAttributeNames: { '#rev': 'rev' }, ExpressionAttributeValues: { ':rev': { N: String(rev) } } };
}

function groupOf(mission: string, version: string, playerHash: string, entries: readonly Entry[]): Group {
  let all: Entry | null = null;
  const sites = new Map<string, Entry>();
  for (const e of entries) {
    if (e.playerHash !== playerHash) continue;
    if (e.site === ALL) all = e;
    else sites.set(e.site, e);
  }
  return { mission, version, playerHash, all, sites };
}

// ------------------------------------------------------------- item mapping

function itemOf(e: Entry): Item {
  const o: Record<string, Plain | undefined> = {
    pk: entryPk(e.mission, e.version),
    sk: entrySk(e.playerHash, e.site),
    pid: e.pid,
    name: e.name,
    tag: e.tag,
    hidden: e.hidden,
    created: e.created,
    updated: e.updated,
    rev: e.rev,
  };
  for (const b of BOARDS) {
    const s = SLOT[b];
    const slot = e.slots[b];
    if (!slot) continue;
    o[s] = { ...slot } as unknown as Plain;
    const plan = e.plans[b];
    if (plan !== undefined) o[`${s}Plan`] = plan;
    if (slot.status === 'valid' && !e.hidden && slot.site !== undefined) {
      o[`${s}Pk`] = boardPk(e.mission, e.version, slot.physics, e.site);
      o[`${s}Sk`] = slot.key;
      o[`${s}V`] = `${slot.score}|${slot.deltaV}|${slot.missionTime}|${slot.at}|${slot.site}`;
    }
  }
  return marshalItem(o);
}

function entryOf(i: Item): Entry {
  const o = unmarshalItem(i);
  const [, mission, version] = /^E#(.+)#([^#]+)$/.exec(String(o.pk)) ?? [];
  const [, playerHash, site] = /^P#([0-9a-f]+)(?:#(.+))?$/.exec(String(o.sk)) ?? [];
  const slots: Partial<Record<BoardId, Slot>> = {};
  const plans: Partial<Record<BoardId, string>> = {};
  for (const b of BOARDS) {
    const s = SLOT[b];
    if (o[s]) slots[b] = o[s] as unknown as Slot;
    if (typeof o[`${s}Plan`] === 'string') plans[b] = o[`${s}Plan`] as string;
  }
  return {
    mission,
    version,
    playerHash,
    site: site ?? ALL,
    pid: String(o.pid),
    name: String(o.name),
    tag: String(o.tag),
    hidden: o.hidden === true,
    created: Number(o.created),
    updated: Number(o.updated),
    rev: Number(o.rev),
    slots,
    plans,
  };
}

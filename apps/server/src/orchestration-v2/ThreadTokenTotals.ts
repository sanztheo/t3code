import type { OrchestrationV2ThreadTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * What each thread and its delegated threads spent, kept current as turns end. Created here, not by
 * a numbered migration: this patch is rebased onto upstream, whose next migration number would
 * collide with ours and never run.
 */
export const TOKEN_TOTALS_TABLE = "orchestration_v2_projection_thread_token_totals";

/** The provider turn rows the totals have counted, so a start can tell when another build wrote some. */
const SEEN_TURNS_TABLE = `${TOKEN_TOTALS_TABLE}_seen`;

/** Lineage is shallow; the bound only stops a corrupted parent cycle. */
const MAX_LINEAGE_DEPTH = 64;

/**
 * The thread a thread's spend rolls up to, over a thread row aliased `alias`. Subagents and side
 * chats live in their parent's view; a fork is listed on its own and keeps its spend.
 */
export const delegatingParentSql = (alias: string) => `CASE
  WHEN json_extract(${alias}.payload_json, '$.lineage.relationshipToParent') = 'subagent'
    OR json_extract(${alias}.payload_json, '$.lineage.sideChat') = 1
  THEN json_extract(${alias}.payload_json, '$.lineage.parentThreadId')
END`;

const UNKNOWN_MODEL = "unknown";

const ModelTokens = Schema.Record(Schema.String, Schema.Number);
const ModelTokensJson = Schema.fromJsonString(ModelTokens);
const decodeModelTokens = Schema.decodeEffect(ModelTokensJson);
const encodeModelTokens = Schema.encodeEffect(ModelTokensJson);

const StoredTurnUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  models: Schema.optional(Schema.Array(Schema.String)),
  otherUsage: Schema.optional(
    Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }),
  ),
});
type StoredTurnUsage = typeof StoredTurnUsage.Type;
export const decodeStoredTurnUsage = Schema.decodeEffect(Schema.fromJsonString(StoredTurnUsage));

export interface TurnSpend {
  readonly tokens: number;
  readonly cachedTokens: number;
  readonly model: string;
}

/**
 * What a turn cost: its main agent plus the native subagents and compactions the provider counted
 * apart (`otherUsage`), which for Claude often outweigh the main agent.
 */
export function turnSpend(usage: StoredTurnUsage | undefined, turnModel?: string): TurnSpend {
  return {
    tokens:
      (usage?.inputTokens ?? 0) +
      (usage?.outputTokens ?? 0) +
      (usage?.otherUsage?.inputTokens ?? 0) +
      (usage?.otherUsage?.outputTokens ?? 0),
    cachedTokens: usage?.cachedInputTokens ?? 0,
    model: usage?.models?.[0] ?? turnModel ?? UNKNOWN_MODEL,
  };
}

/** `turnSpend` in SQL over a provider turn row aliased `p`, for reads that sum many turns. */
export const TURN_TOKENS_SQL = `(
  COALESCE(json_extract(p.payload_json, '$.turnTokenUsage.inputTokens'), 0)
  + COALESCE(json_extract(p.payload_json, '$.turnTokenUsage.outputTokens'), 0)
  + COALESCE(json_extract(p.payload_json, '$.turnTokenUsage.otherUsage.inputTokens'), 0)
  + COALESCE(json_extract(p.payload_json, '$.turnTokenUsage.otherUsage.outputTokens'), 0)
)`;
const TURN_CACHED_TOKENS_SQL = `COALESCE(json_extract(p.payload_json, '$.turnTokenUsage.cachedInputTokens'), 0)`;
const TURN_MODEL_SQL = `COALESCE(
  json_extract(p.payload_json, '$.turnTokenUsage.models[0]'),
  json_extract(p.payload_json, '$.model'),
  '${UNKNOWN_MODEL}'
)`;

export interface TokenTotalsRow {
  readonly self_tokens: number;
  readonly delegated_tokens: number;
  readonly delegated_threads: number;
  readonly cached_tokens: number;
  readonly models_json: string;
}

/** Null for a thread whose turns, and its delegated threads' turns, spent nothing. */
export const tokenTotalsFromRow = Effect.fn("ThreadTokenTotals.fromRow")(function* (
  row: TokenTotalsRow,
) {
  if (row.self_tokens + row.delegated_tokens <= 0) return null;
  return {
    selfTokens: row.self_tokens,
    delegatedTokens: row.delegated_tokens,
    delegatedThreads: row.delegated_threads,
    cachedTokens: row.cached_tokens,
    byModel: yield* decodeModelTokens(row.models_json),
  } satisfies OrchestrationV2ThreadTokenTotals;
});

interface TotalsChange {
  readonly self: number;
  readonly delegated: number;
  readonly delegatedThreads: number;
  readonly cached: number;
  readonly models: ReadonlyMap<string, number>;
}

const addModels = (current: Record<string, number>, models: ReadonlyMap<string, number>) => {
  const next = { ...current };
  for (const [model, tokens] of models) {
    const value = (next[model] ?? 0) + tokens;
    if (value > 0) next[model] = value;
    else delete next[model];
  }
  return next;
};

/** Returns the thread's own spend before the change. */
const changeRow = Effect.fn("ThreadTokenTotals.changeRow")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  change: TotalsChange,
) {
  const current = (yield* sql<TokenTotalsRow>`
    SELECT * FROM ${sql(TOKEN_TOTALS_TABLE)} WHERE thread_id = ${threadId}
  `)[0];
  const models = yield* encodeModelTokens(
    addModels(
      current === undefined ? {} : yield* decodeModelTokens(current.models_json),
      change.models,
    ),
  );
  yield* sql`
    INSERT INTO ${sql(TOKEN_TOTALS_TABLE)} (
      thread_id, self_tokens, delegated_tokens, delegated_threads, cached_tokens, models_json
    )
    VALUES (
      ${threadId},
      ${Math.max(0, (current?.self_tokens ?? 0) + change.self)},
      ${Math.max(0, (current?.delegated_tokens ?? 0) + change.delegated)},
      ${Math.max(0, (current?.delegated_threads ?? 0) + change.delegatedThreads)},
      ${Math.max(0, (current?.cached_tokens ?? 0) + change.cached)},
      ${models}
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      self_tokens = excluded.self_tokens,
      delegated_tokens = excluded.delegated_tokens,
      delegated_threads = excluded.delegated_threads,
      cached_tokens = excluded.cached_tokens,
      models_json = excluded.models_json
  `;
  return current?.self_tokens ?? 0;
});

/** The threads that delegated, directly or not, to any of these, nearest first. */
export const ancestorThreadIds = Effect.fn("ThreadTokenTotals.ancestorThreadIds")(function* (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<string>,
) {
  if (threadIds.length === 0) return [];
  const rows = yield* sql<{ readonly thread_id: string }>`
    WITH RECURSIVE chain(thread_id, depth) AS (
      SELECT ${sql.literal(delegatingParentSql("t"))}, 1
      FROM orchestration_v2_projection_threads t
      WHERE ${sql.in("t.thread_id", threadIds)}
      UNION
      SELECT ${sql.literal(delegatingParentSql("t"))}, chain.depth + 1
      FROM orchestration_v2_projection_threads t
      JOIN chain ON t.thread_id = chain.thread_id
      WHERE chain.depth < ${MAX_LINEAGE_DEPTH}
    )
    SELECT thread_id FROM chain WHERE thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY MIN(depth)
  `;
  return rows.map((row) => row.thread_id);
});

/**
 * The ancestors a client still shows. An archived or deleted one is out of the sidebar, and a
 * refresh of it would only repeat its removal at a later sequence than its own.
 */
export const shownAncestorThreadIds = Effect.fn("ThreadTokenTotals.shownAncestorThreadIds")(
  function* (sql: SqlClient.SqlClient, threadIds: ReadonlyArray<string>) {
    const ancestors = yield* ancestorThreadIds(sql, threadIds);
    if (ancestors.length === 0) return [];
    const shown = new Set(
      (yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE ${sql.in("thread_id", ancestors)} AND deleted_at IS NULL
          AND json_extract(payload_json, '$.archivedAt') IS NULL
      `).map((row) => row.thread_id),
    );
    return ancestors.filter((threadId) => shown.has(threadId));
  },
);

/** Moves one thread's spend by `delta`, and its ancestors' delegated spend with it. */
const changeThreadSpend = Effect.fn("ThreadTokenTotals.changeThreadSpend")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  delta: {
    readonly tokens: number;
    readonly cached: number;
    readonly models: ReadonlyMap<string, number>;
  },
) {
  if (
    delta.tokens === 0 &&
    delta.cached === 0 &&
    [...delta.models.values()].every((v) => v === 0)
  ) {
    return;
  }
  const selfBefore = yield* changeRow(sql, threadId, {
    self: delta.tokens,
    delegated: 0,
    delegatedThreads: 0,
    cached: delta.cached,
    models: delta.models,
  });
  const selfAfter = Math.max(0, selfBefore + delta.tokens);
  const delegatedThreads =
    selfBefore === 0 && selfAfter > 0 ? 1 : selfBefore > 0 && selfAfter === 0 ? -1 : 0;
  for (const ancestorId of yield* ancestorThreadIds(sql, [threadId])) {
    yield* changeRow(sql, ancestorId, {
      self: 0,
      delegated: delta.tokens,
      delegatedThreads,
      cached: delta.cached,
      models: delta.models,
    });
  }
});

const spendDelta = (spend: TurnSpend, sign: 1 | -1) => ({
  tokens: sign * spend.tokens,
  cached: sign * spend.cachedTokens,
  models: new Map([[spend.model, sign * spend.tokens]]),
});

/**
 * Applies a provider turn's new usage over what its row held before. Replaying an event that
 * changes nothing adds nothing, so totals stay right however often a turn is updated.
 */
export const applyTurnSpend = Effect.fn("ThreadTokenTotals.applyTurnSpend")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly before: { readonly threadId: string; readonly spend: TurnSpend } | null;
    readonly after: { readonly threadId: string; readonly spend: TurnSpend };
  },
) {
  const { before, after } = input;
  if (before !== null && before.threadId !== after.threadId) {
    yield* changeThreadSpend(sql, before.threadId, spendDelta(before.spend, -1));
    return yield* changeThreadSpend(sql, after.threadId, spendDelta(after.spend, 1));
  }
  const models = new Map<string, number>();
  if (before !== null) models.set(before.spend.model, -before.spend.tokens);
  models.set(after.spend.model, (models.get(after.spend.model) ?? 0) + after.spend.tokens);
  yield* changeThreadSpend(sql, after.threadId, {
    tokens: after.spend.tokens - (before?.spend.tokens ?? 0),
    cached: after.spend.cachedTokens - (before?.spend.cachedTokens ?? 0),
    models,
  });
});

/** Forgets every total, for a projection rebuilt from its events. */
export const clearTokenTotals = (sql: SqlClient.SqlClient) =>
  sql`DELETE FROM ${sql(TOKEN_TOTALS_TABLE)}`;

/** Records that the totals counted this provider turn's row. */
export const markTurnCounted = (sql: SqlClient.SqlClient, providerTurnId: string) =>
  sql`
    UPDATE ${sql(SEEN_TURNS_TABLE)}
    SET turn_rowid = MAX(turn_rowid, COALESCE((
      SELECT rowid FROM orchestration_v2_projection_provider_turns
      WHERE provider_turn_id = ${providerTurnId}
    ), 0))
  `;

/**
 * Creates the tables and fills them from the turns already projected. A later start refills them
 * only when provider turns appeared that the totals never counted, such as turns an older build,
 * which lacks this patch, projected on the same database.
 */
export const ensureTokenTotals = Effect.fn("ThreadTokenTotals.ensure")(function* (
  sql: SqlClient.SqlClient,
) {
  const projected = yield* sql`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'orchestration_v2_projection_provider_turns'
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(TOKEN_TOTALS_TABLE)} (
          thread_id TEXT PRIMARY KEY,
          self_tokens INTEGER NOT NULL DEFAULT 0,
          delegated_tokens INTEGER NOT NULL DEFAULT 0,
          delegated_threads INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          models_json TEXT NOT NULL DEFAULT '{}'
        )
      `;
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(SEEN_TURNS_TABLE)} (turn_rowid INTEGER NOT NULL)
      `;
      const latest =
        projected.length === 0
          ? 0
          : ((yield* sql<{ readonly rowid: number | null }>`
              SELECT MAX(rowid) AS rowid FROM orchestration_v2_projection_provider_turns
            `)[0]?.rowid ?? 0);
      const seen = (yield* sql<{ readonly turn_rowid: number }>`
        SELECT turn_rowid FROM ${sql(SEEN_TURNS_TABLE)}
      `)[0];
      if (seen?.turn_rowid === latest) return;
      yield* clearTokenTotals(sql);
      if (projected.length > 0) yield* backfill(sql);
      yield* sql`DELETE FROM ${sql(SEEN_TURNS_TABLE)}`;
      yield* sql`INSERT INTO ${sql(SEEN_TURNS_TABLE)} (turn_rowid) VALUES (${latest})`;
    }),
  );
});

interface BackfillRow {
  self: number;
  delegated: number;
  threads: number;
  cached: number;
  readonly models: Map<string, number>;
}

const backfill = Effect.fn("ThreadTokenTotals.backfill")(function* (sql: SqlClient.SqlClient) {
  const spends = yield* sql<{
    readonly thread_id: string;
    readonly model: string;
    readonly tokens: number;
    readonly cached: number;
  }>`
    SELECT p.thread_id, ${sql.literal(TURN_MODEL_SQL)} AS model,
      SUM(${sql.literal(TURN_TOKENS_SQL)}) AS tokens,
      SUM(${sql.literal(TURN_CACHED_TOKENS_SQL)}) AS cached
    FROM orchestration_v2_projection_provider_turns p
    WHERE json_type(p.payload_json, '$.turnTokenUsage') IS NOT NULL
    GROUP BY p.thread_id, model
  `;
  if (spends.length === 0) return;
  const parents = new Map(
    (yield* sql<{ readonly thread_id: string; readonly parent_id: string }>`
      SELECT * FROM (
        SELECT t.thread_id, ${sql.literal(delegatingParentSql("t"))} AS parent_id
        FROM orchestration_v2_projection_threads t
      ) WHERE parent_id IS NOT NULL
    `).map((row) => [row.thread_id, row.parent_id] as const),
  );
  const ancestorsOf = (threadId: string) => {
    const ancestors: Array<string> = [];
    const seen = new Set([threadId]);
    for (let parent = parents.get(threadId); parent !== undefined; parent = parents.get(parent)) {
      if (seen.has(parent) || ancestors.length >= MAX_LINEAGE_DEPTH) break;
      seen.add(parent);
      ancestors.push(parent);
    }
    return ancestors;
  };
  const rows = new Map<string, BackfillRow>();
  const rowOf = (threadId: string) => {
    const row = rows.get(threadId) ?? {
      self: 0,
      delegated: 0,
      threads: 0,
      cached: 0,
      models: new Map(),
    };
    rows.set(threadId, row);
    return row;
  };
  const addModel = (row: BackfillRow, model: string, tokens: number) =>
    row.models.set(model, (row.models.get(model) ?? 0) + tokens);
  const spending = new Set<string>();
  for (const spend of spends) {
    const own = rowOf(spend.thread_id);
    own.self += spend.tokens;
    own.cached += spend.cached;
    addModel(own, spend.model, spend.tokens);
    const startsSpending = spend.tokens > 0 && !spending.has(spend.thread_id);
    if (startsSpending) spending.add(spend.thread_id);
    for (const ancestorId of ancestorsOf(spend.thread_id)) {
      const ancestor = rowOf(ancestorId);
      ancestor.delegated += spend.tokens;
      ancestor.cached += spend.cached;
      if (startsSpending) ancestor.threads += 1;
      addModel(ancestor, spend.model, spend.tokens);
    }
  }
  for (const [threadId, row] of rows) {
    const models = yield* encodeModelTokens(addModels({}, row.models));
    yield* sql`
      INSERT INTO ${sql(TOKEN_TOTALS_TABLE)} (
        thread_id, self_tokens, delegated_tokens, delegated_threads, cached_tokens, models_json
      )
      VALUES (${threadId}, ${row.self}, ${row.delegated}, ${row.threads}, ${row.cached}, ${models})
    `;
  }
});

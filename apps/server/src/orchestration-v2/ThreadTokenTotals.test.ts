import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  applyTurnSpend,
  ensureTokenTotals,
  markTurnCounted,
  TOKEN_TOTALS_TABLE,
  turnSpend,
  type TurnSpend,
} from "./ThreadTokenTotals.ts";

// root ← child ← grandchild as subagents, a fork of root that keeps its own spend, and an
// unrelated thread.
const THREADS = [
  { id: "root", parent: null, relationship: null },
  { id: "child", parent: "root", relationship: "subagent" },
  { id: "grandchild", parent: "child", relationship: "subagent" },
  { id: "fork", parent: "root", relationship: "fork" },
  { id: "other", parent: null, relationship: null },
] as const;

const TURNS = [
  {
    id: "t1",
    thread: "root",
    usage: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 80, models: ["opus"] },
  },
  {
    id: "t2",
    thread: "child",
    usage: {
      inputTokens: 40,
      outputTokens: 10,
      otherUsage: { inputTokens: 7, outputTokens: 3 },
      models: ["sol"],
    },
  },
  { id: "t3", thread: "grandchild", usage: { inputTokens: 4, outputTokens: 1, models: ["sol"] } },
  { id: "t4", thread: "other", usage: { inputTokens: 2, outputTokens: 1 } },
  { id: "t5", thread: "fork", usage: { inputTokens: 8, outputTokens: 1, models: ["opus"] } },
] as const;

const createProjectionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  for (const thread of THREADS) {
    const lineage =
      thread.parent === null
        ? {}
        : { parentThreadId: thread.parent, relationshipToParent: thread.relationship };
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.id}, ${JSON.stringify({ lineage })})`;
  }
});

const insertTurn = Effect.fnUntraced(function* (turn: (typeof TURNS)[number]) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES (${turn.id}, ${turn.thread}, ${JSON.stringify({ turnTokenUsage: { usageStatus: "complete", usageScope: "main_agent", hasSubagents: false, ...turn.usage } })})`;
});

const insertTurns = Effect.forEach(TURNS, insertTurn, { discard: true });

const readTotals = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly self_tokens: number;
    readonly delegated_tokens: number;
    readonly delegated_threads: number;
    readonly cached_tokens: number;
    readonly models_json: string;
  }>`SELECT * FROM ${sql(TOKEN_TOTALS_TABLE)} ORDER BY thread_id`;
  return Object.fromEntries(
    rows.map((row) => [
      row.thread_id,
      {
        self: row.self_tokens,
        delegated: row.delegated_tokens,
        delegatedThreads: row.delegated_threads,
        cached: row.cached_tokens,
        models: JSON.parse(row.models_json) as Record<string, number>,
      },
    ]),
  );
});

const EXPECTED = {
  child: { self: 60, delegated: 5, delegatedThreads: 1, cached: 0, models: { sol: 65 } },
  fork: { self: 9, delegated: 0, delegatedThreads: 0, cached: 0, models: { opus: 9 } },
  grandchild: { self: 5, delegated: 0, delegatedThreads: 0, cached: 0, models: { sol: 5 } },
  other: { self: 3, delegated: 0, delegatedThreads: 0, cached: 0, models: { unknown: 3 } },
  root: {
    self: 100,
    delegated: 65,
    delegatedThreads: 2,
    cached: 80,
    models: { opus: 100, sol: 65 },
  },
};

const spendOf = (turn: (typeof TURNS)[number]): TurnSpend => turnSpend(turn.usage);

describe("ThreadTokenTotals", () => {
  it("counts the native subagent and compaction usage a turn reports apart", () => {
    assert.deepStrictEqual(spendOf(TURNS[1]), { tokens: 60, cachedTokens: 0, model: "sol" });
  });

  it.effect("fills totals from turns already projected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjectionTables;
      yield* insertTurns;
      yield* ensureTokenTotals(sql);
      assert.deepStrictEqual(yield* readTotals, EXPECTED);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the same totals when turns end one by one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjectionTables;
      yield* ensureTokenTotals(sql);
      for (const turn of TURNS) {
        yield* applyTurnSpend(sql, {
          before: null,
          after: { threadId: turn.thread, spend: spendOf(turn) },
        });
      }
      assert.deepStrictEqual(yield* readTotals, EXPECTED);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refills totals when turns appear that they never counted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjectionTables;
      yield* insertTurn(TURNS[0]);
      yield* ensureTokenTotals(sql);
      // An older build, without the totals, projects the other turns on the same database.
      for (const turn of TURNS.slice(1)) yield* insertTurn(turn);
      yield* ensureTokenTotals(sql);
      assert.deepStrictEqual(yield* readTotals, EXPECTED);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps totals across starts while every turn was counted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjectionTables;
      yield* ensureTokenTotals(sql);
      for (const turn of TURNS) {
        yield* insertTurn(turn);
        yield* applyTurnSpend(sql, {
          before: null,
          after: { threadId: turn.thread, spend: spendOf(turn) },
        });
        yield* markTurnCounted(sql, turn.id);
      }
      // A marker the refill would erase.
      yield* sql`UPDATE ${sql(TOKEN_TOTALS_TABLE)} SET models_json = '{"kept":1}' WHERE thread_id = 'other'`;
      yield* ensureTokenTotals(sql);
      assert.deepStrictEqual((yield* readTotals).other?.models, { kept: 1 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds nothing when a turn is updated again with the same usage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createProjectionTables;
      yield* ensureTokenTotals(sql);
      const grandchild = { threadId: "grandchild", spend: spendOf(TURNS[2]) };
      yield* applyTurnSpend(sql, { before: null, after: grandchild });
      yield* applyTurnSpend(sql, { before: grandchild, after: grandchild });
      yield* applyTurnSpend(sql, {
        before: grandchild,
        after: { threadId: "grandchild", spend: { ...grandchild.spend, tokens: 25 } },
      });
      const totals = yield* readTotals;
      assert.strictEqual(totals.grandchild?.self, 25);
      assert.strictEqual(totals.root?.delegated, 25);
      assert.strictEqual(totals.root?.delegatedThreads, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

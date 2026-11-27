import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  applyTurnSpend,
  ensureTokenTotals,
  TOKEN_TOTALS_TABLE,
  turnSpend,
  type TurnSpend,
} from "./ThreadTokenTotals.ts";

// root ← child ← grandchild, plus an unrelated thread.
const THREADS = [
  { id: "root", parent: null },
  { id: "child", parent: "root" },
  { id: "grandchild", parent: "child" },
  { id: "other", parent: null },
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
] as const;

const createProjectionTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  for (const thread of THREADS) {
    const lineage =
      thread.parent === null
        ? {}
        : { parentThreadId: thread.parent, relationshipToParent: "subagent" };
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.id}, ${JSON.stringify({ lineage })})`;
  }
});

const insertTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const turn of TURNS) {
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES (${turn.id}, ${turn.thread}, ${JSON.stringify({ turnTokenUsage: { usageStatus: "complete", usageScope: "main_agent", hasSubagents: false, ...turn.usage } })})`;
  }
});

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

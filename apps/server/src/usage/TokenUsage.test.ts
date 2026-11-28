import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as TokenUsage from "./TokenUsage.ts";

// "lead" runs two steps in one thread; "build" delegated to "helper" and was forked into "fork",
// a conversation of its own; "remote" ran elsewhere. Run 2 reuses "helper"; run 3 retried a step.
const THREADS = [
  { id: "lead", parent: null, relationship: null, title: "Lead" },
  { id: "build", parent: null, relationship: null, title: "Build" },
  { id: "helper", parent: "build", relationship: "subagent", title: "Helper" },
  { id: "fork", parent: "build", relationship: "fork", title: "Fork" },
  { id: "remote", parent: null, relationship: null, title: "Remote" },
  { id: "chat", parent: null, relationship: null, title: "A chat" },
  { id: "retrier", parent: null, relationship: null, title: "Retrier" },
] as const;

const RUNS = [
  { id: "run-1", startedAt: "2026-11-27T10:00:00Z" },
  { id: "run-2", startedAt: "2026-11-27T12:00:00Z" },
  { id: "run-3", startedAt: "2026-11-27T13:00:00Z" },
] as const;

const STEPS = [
  {
    run: "run-1",
    attempts: 1,
    name: "plan",
    thread: "lead",
    from: "2026-11-27T10:00:00Z",
    until: "2026-11-27T10:10:00Z",
    env: null,
  },
  {
    run: "run-1",
    attempts: 1,
    name: "build",
    thread: "build",
    from: "2026-11-27T10:10:00Z",
    until: "2026-11-27T10:30:00Z",
    env: null,
  },
  {
    run: "run-1",
    attempts: 1,
    name: "review",
    thread: "lead",
    from: "2026-11-27T10:30:00Z",
    until: null,
    env: null,
  },
  {
    run: "run-1",
    attempts: 1,
    name: "remote",
    thread: "remote",
    from: "2026-11-27T10:30:00Z",
    until: null,
    env: "env-2",
  },
  {
    run: "run-2",
    attempts: 1,
    name: "reuse",
    thread: "helper",
    from: "2026-11-27T12:00:00Z",
    until: null,
    env: null,
  },
  // Its row keeps only the last attempt's start.
  {
    run: "run-3",
    attempts: 2,
    name: "flaky",
    thread: "retrier",
    from: "2026-11-27T13:30:00Z",
    until: null,
    env: null,
  },
] as const;

const TURNS = [
  {
    id: "t1",
    thread: "lead",
    at: "2026-11-27T10:01:00.000Z",
    tokens: 100,
    cached: 60,
    model: "opus",
  },
  {
    id: "t2",
    thread: "build",
    at: "2026-11-27T10:11:00.000Z",
    tokens: 300,
    cached: 0,
    model: "opus",
  },
  {
    id: "t3",
    thread: "helper",
    at: "2026-11-27T10:12:00.000Z",
    tokens: 50,
    cached: 0,
    model: "sol",
  },
  { id: "t4", thread: "lead", at: "2026-11-27T10:31:00.000Z", tokens: 20, cached: 0, model: "sol" },
  // Before any step of this run: the lead thread's earlier life, not this run's.
  {
    id: "t5",
    thread: "lead",
    at: "2026-11-26T09:00:00.000Z",
    tokens: 999,
    cached: 0,
    model: "opus",
  },
  {
    id: "t6",
    thread: "remote",
    at: "2026-11-27T10:31:00.000Z",
    tokens: 7,
    cached: 0,
    model: "sol",
  },
  {
    id: "t7",
    thread: "chat",
    at: "2026-11-20T12:00:00.000Z",
    tokens: 40,
    cached: 0,
    model: "opus",
  },
  // Inside the build step, but a fork is not a delegate.
  {
    id: "t8",
    thread: "fork",
    at: "2026-11-27T10:15:00.000Z",
    tokens: 30,
    cached: 0,
    model: "opus",
  },
  {
    id: "t9",
    thread: "helper",
    at: "2026-11-27T12:01:00.000Z",
    tokens: 5,
    cached: 0,
    model: "sol",
  },
  {
    id: "t10",
    thread: "retrier",
    at: "2026-11-27T13:05:00.000Z",
    tokens: 100,
    cached: 0,
    model: "sol",
  },
  {
    id: "t11",
    thread: "retrier",
    at: "2026-11-27T13:31:00.000Z",
    tokens: 50,
    cached: 0,
    model: "sol",
  },
] as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, started_at TEXT, completed_at TEXT, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE workflow_steps (run_id TEXT NOT NULL, name TEXT NOT NULL, thread_id TEXT, environment_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, attempts INTEGER NOT NULL, PRIMARY KEY (run_id, name))`;
  for (const run of RUNS) {
    yield* sql`INSERT INTO workflow_runs VALUES (${run.id}, ${run.startedAt})`;
  }
  for (const thread of THREADS) {
    const lineage =
      thread.parent === null
        ? {}
        : { parentThreadId: thread.parent, relationshipToParent: thread.relationship };
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.id}, ${JSON.stringify({ title: thread.title, lineage })})`;
  }
  for (const step of STEPS) {
    yield* sql`INSERT INTO workflow_steps VALUES (${step.run}, ${step.name}, ${step.thread}, ${step.env}, ${step.from}, ${step.until}, ${step.attempts})`;
  }
  for (const turn of TURNS) {
    const usage = {
      inputTokens: turn.tokens,
      outputTokens: 0,
      cachedInputTokens: turn.cached,
      models: [turn.model],
    };
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES (${turn.id}, ${turn.thread}, ${turn.at}, ${turn.at}, ${JSON.stringify({ turnTokenUsage: usage })})`;
  }
});

const layer = TokenUsage.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("TokenUsage", () => {
  it.effect("totals a workflow run by step and model, delegated threads included", () =>
    Effect.gen(function* () {
      yield* seed;
      const tokenUsage = yield* TokenUsage.TokenUsage;
      assert.deepStrictEqual(yield* tokenUsage.workflowRun("run-1"), {
        total: 470,
        cachedTokens: 60,
        byModel: [
          { model: "opus", tokens: 400, steps: 2 },
          { model: "sol", tokens: 70, steps: 2 },
        ],
        byStep: { plan: 100, build: 350, review: 20 },
      });
      assert.deepStrictEqual(
        yield* tokenUsage.workflowRunTotals(["run-1", "run-2", "run-3", "run-4"]),
        { "run-1": 470, "run-2": 5, "run-3": 150 },
      );
      assert.strictEqual(yield* tokenUsage.workflowRun("run-4"), undefined);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ranks top-level conversations in a window, with what their delegates spent", () =>
    Effect.gen(function* () {
      yield* seed;
      const tokenUsage = yield* TokenUsage.TokenUsage;
      const conversations = yield* tokenUsage.conversations({
        sinceDay: "2026-11-27" as never,
        untilDay: "2026-11-27" as never,
        timeZone: "Europe/Paris" as never,
      });
      assert.deepStrictEqual(conversations, [
        {
          threadId: "build",
          title: "Build",
          selfTokens: 300,
          delegatedTokens: 55,
          delegatedThreads: 1,
        },
        {
          threadId: "retrier",
          title: "Retrier",
          selfTokens: 150,
          delegatedTokens: 0,
          delegatedThreads: 0,
        },
        {
          threadId: "lead",
          title: "Lead",
          selfTokens: 120,
          delegatedTokens: 0,
          delegatedThreads: 0,
        },
        {
          threadId: "fork",
          title: "Fork",
          selfTokens: 30,
          delegatedTokens: 0,
          delegatedThreads: 0,
        },
        {
          threadId: "remote",
          title: "Remote",
          selfTokens: 7,
          delegatedTokens: 0,
          delegatedThreads: 0,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

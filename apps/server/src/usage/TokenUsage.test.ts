import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as TokenUsage from "./TokenUsage.ts";

// "build" delegated to "helper" and was forked into "fork", a conversation of its own.
const THREADS = [
  { id: "lead", parent: null, relationship: null, title: "Lead" },
  { id: "build", parent: null, relationship: null, title: "Build" },
  { id: "helper", parent: "build", relationship: "subagent", title: "Helper" },
  { id: "fork", parent: "build", relationship: "fork", title: "Fork" },
  { id: "remote", parent: null, relationship: null, title: "Remote" },
  { id: "chat", parent: null, relationship: null, title: "A chat" },
  { id: "retrier", parent: null, relationship: null, title: "Retrier" },
  { id: "shared", parent: null, relationship: null, title: "Shared" },
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
  // A fork is not a delegate.
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
  ...(
    [
      ["t12", "14:01", 100],
      ["t13", "14:15", 30],
      ["t14", "14:21", 7],
      ["t15", "14:31", 50],
      ["t16", "14:40", 4],
      ["t17", "14:46", 9],
      ["t18", "14:13", 3],
    ] as const
  ).map(([id, time, tokens]) => ({
    id,
    thread: "shared",
    at: `2026-11-27T${time}:00.000Z`,
    tokens,
    cached: 0,
    model: "sol",
  })),
] as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, started_at TEXT, completed_at TEXT, payload_json TEXT NOT NULL)`;
  for (const thread of THREADS) {
    const lineage =
      thread.parent === null
        ? {}
        : { parentThreadId: thread.parent, relationshipToParent: thread.relationship };
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.id}, ${JSON.stringify({ title: thread.title, lineage })})`;
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
          threadId: "shared",
          title: "Shared",
          selfTokens: 203,
          delegatedTokens: 0,
          delegatedThreads: 0,
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

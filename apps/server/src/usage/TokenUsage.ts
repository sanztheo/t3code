import type {
  ConversationUsage,
  ConversationUsageInput,
  WorkflowRunTokens,
  WorkflowRunTokenTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  TURN_CACHED_TOKENS_SQL,
  TURN_MODEL_SQL,
  TURN_TOKENS_SQL,
} from "../orchestration-v2/ThreadTokenTotals.ts";
import { usageTimestampFilter } from "./usageAggregation.ts";

/** Lineage is shallow; the bound only stops a corrupted parent cycle. */
const MAX_LINEAGE_DEPTH = 64;
/** The Usage page lists the costliest conversations, not all of them. */
const CONVERSATION_LIMIT = 25;
const DAY_MS = 86_400_000;

interface SpendingTurn {
  readonly thread_id: string;
  readonly turn_id: string;
  readonly started_at: string | null;
  readonly model: string;
  readonly tokens: number;
  readonly cached: number;
}

interface AgentStep {
  readonly run_id: string;
  readonly name: string;
  readonly thread_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
}

/** Each thread with the threads it delegated to, directly or not. */
const delegationTrees = Effect.fn("TokenUsage.delegationTrees")(function* (
  sql: SqlClient.SqlClient,
  rootIds: ReadonlyArray<string>,
) {
  const roots = new Set(rootIds);
  const parentOf = new Map<string, string>();
  let frontier = [...roots];
  for (let depth = 0; frontier.length > 0 && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    const children = yield* sql<{ readonly thread_id: string; readonly parent_id: string }>`
      SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.lineage.parentThreadId') IN ${sql.in(frontier)}
    `;
    frontier = [];
    for (const child of children) {
      if (parentOf.has(child.thread_id) || roots.has(child.thread_id)) continue;
      parentOf.set(child.thread_id, child.parent_id);
      frontier.push(child.thread_id);
    }
  }
  const trees = new Map([...roots].map((rootId) => [rootId, [rootId]] as const));
  for (const threadId of parentOf.keys()) {
    let root = threadId;
    for (let parent = parentOf.get(root); parent !== undefined; parent = parentOf.get(root)) {
      root = parent;
    }
    trees.get(root)?.push(threadId);
  }
  return trees;
});

/**
 * The turns each agent step of these runs spent: its thread's and its delegated threads' turns
 * that started while the step ran. Steps in a linked environment ran elsewhere and are left out.
 */
const runSpending = Effect.fn("TokenUsage.runSpending")(function* (
  sql: SqlClient.SqlClient,
  runIds: ReadonlyArray<string>,
) {
  if (runIds.length === 0) return [];
  const steps = yield* sql<AgentStep>`
    SELECT run_id, name, thread_id, started_at, ended_at
    FROM workflow_steps
    WHERE ${sql.in("run_id", runIds)} AND thread_id IS NOT NULL AND environment_id IS NULL
  `;
  if (steps.length === 0) return [];
  const trees = yield* delegationTrees(
    sql,
    steps.map((step) => step.thread_id),
  );
  const threadIds = [...new Set([...trees.values()].flat())];
  const turns = yield* sql<SpendingTurn>`
    SELECT p.thread_id, p.provider_turn_id AS turn_id, p.started_at,
      ${sql.literal(TURN_MODEL_SQL)} AS model,
      ${sql.literal(TURN_TOKENS_SQL)} AS tokens,
      ${sql.literal(TURN_CACHED_TOKENS_SQL)} AS cached
    FROM orchestration_v2_projection_provider_turns p
    WHERE ${sql.in("p.thread_id", threadIds)}
      AND json_type(p.payload_json, '$.turnTokenUsage') IS NOT NULL
  `;
  const turnsByThread = Map.groupBy(turns, (turn) => turn.thread_id);
  return steps.map((step) => {
    const from = Date.parse(step.started_at);
    const until = step.ended_at === null ? Number.POSITIVE_INFINITY : Date.parse(step.ended_at);
    const stepTurns = (trees.get(step.thread_id) ?? []).flatMap((threadId) =>
      (turnsByThread.get(threadId) ?? []).filter((turn) => {
        if (turn.started_at === null) return false;
        const startedAt = Date.parse(turn.started_at);
        return startedAt >= from && startedAt < until;
      }),
    );
    return { runId: step.run_id, step: step.name, turns: stepTurns };
  });
});

const summarizeRun = (
  steps: ReadonlyArray<{ readonly step: string; readonly turns: ReadonlyArray<SpendingTurn> }>,
): WorkflowRunTokens | undefined => {
  const byStep: Record<string, number> = {};
  const counted = new Map<string, SpendingTurn>();
  const stepsByModel = new Map<string, Set<string>>();
  for (const { step, turns } of steps) {
    for (const turn of turns) {
      if (turn.tokens <= 0) continue;
      byStep[step] = (byStep[step] ?? 0) + turn.tokens;
      counted.set(turn.turn_id, turn);
      const modelSteps = stepsByModel.get(turn.model) ?? new Set();
      stepsByModel.set(turn.model, modelSteps.add(step));
    }
  }
  if (counted.size === 0) return undefined;
  const tokensByModel = new Map<string, number>();
  let total = 0;
  let cachedTokens = 0;
  for (const turn of counted.values()) {
    total += turn.tokens;
    cachedTokens += turn.cached;
    tokensByModel.set(turn.model, (tokensByModel.get(turn.model) ?? 0) + turn.tokens);
  }
  const byModel = [...tokensByModel]
    .map(([model, tokens]) => ({ model, tokens, steps: stepsByModel.get(model)?.size ?? 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  return { total, cachedTokens, byModel, byStep };
};

/** The top-level thread each delegated thread descends from. */
const rootOf = (parents: ReadonlyMap<string, string>) => (threadId: string) => {
  let root = threadId;
  const seen = new Set([root]);
  for (let parent = parents.get(root); parent !== undefined; parent = parents.get(root)) {
    if (seen.has(parent) || seen.size > MAX_LINEAGE_DEPTH) break;
    seen.add(parent);
    root = parent;
  }
  return root;
};

export class TokenUsage extends Context.Service<
  TokenUsage,
  {
    /** What a workflow run spent, or nothing when its agents spent nothing yet. */
    readonly workflowRun: (
      runId: string,
    ) => Effect.Effect<WorkflowRunTokens | undefined, SqlError.SqlError>;
    readonly workflowRunTotals: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<WorkflowRunTokenTotals, SqlError.SqlError>;
    /** The top-level conversations that spent the most in a Usage page window. */
    readonly conversations: (
      input: ConversationUsageInput,
    ) => Effect.Effect<ReadonlyArray<ConversationUsage>, SqlError.SqlError>;
  }
>()("t3/usage/TokenUsage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const workflowRun = Effect.fn("TokenUsage.workflowRun")(function* (runId: string) {
    return summarizeRun(yield* runSpending(sql, [runId]));
  });

  const workflowRunTotals = Effect.fn("TokenUsage.workflowRunTotals")(function* (
    runIds: ReadonlyArray<string>,
  ) {
    const spending = Map.groupBy(yield* runSpending(sql, runIds), (step) => step.runId);
    const totals: Record<string, number> = {};
    for (const [runId, steps] of spending) {
      const total = summarizeRun(steps)?.total;
      if (total !== undefined) totals[runId] = total;
    }
    return totals;
  });

  const conversations = Effect.fn("TokenUsage.conversations")(function* (
    input: ConversationUsageInput,
  ) {
    const sinceTimeMs = input.sinceTime === undefined ? undefined : Date.parse(input.sinceTime);
    const untilTimeMs = input.untilTime === undefined ? undefined : Date.parse(input.untilTime);
    const inWindow = usageTimestampFilter({ ...input, sinceTimeMs, untilTimeMs });
    // A day in the window's zone spans at most a day either side of the same UTC day.
    const from = new Date(sinceTimeMs ?? Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS);
    const until = new Date(untilTimeMs ?? Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS);
    const turns = yield* sql<{
      readonly thread_id: string;
      readonly at: string;
      readonly tokens: number;
    }>`
      SELECT p.thread_id, COALESCE(p.completed_at, p.started_at) AS at,
        ${sql.literal(TURN_TOKENS_SQL)} AS tokens
      FROM orchestration_v2_projection_provider_turns p
      WHERE COALESCE(p.completed_at, p.started_at) >= ${from.toISOString()}
        AND COALESCE(p.completed_at, p.started_at) < ${until.toISOString()}
        AND json_type(p.payload_json, '$.turnTokenUsage') IS NOT NULL
    `;
    const parents = new Map(
      (yield* sql<{ readonly thread_id: string; readonly parent_id: string }>`
        SELECT thread_id, json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id
        FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      `).map((row) => [row.thread_id, row.parent_id] as const),
    );
    const toRoot = rootOf(parents);
    const roots = new Map<string, { self: number; delegated: number; threads: Set<string> }>();
    for (const turn of turns) {
      if (turn.tokens <= 0 || !inWindow(Date.parse(turn.at))) continue;
      const rootId = toRoot(turn.thread_id);
      const root = roots.get(rootId) ?? { self: 0, delegated: 0, threads: new Set() };
      roots.set(rootId, root);
      if (rootId === turn.thread_id) root.self += turn.tokens;
      else {
        root.delegated += turn.tokens;
        root.threads.add(turn.thread_id);
      }
    }
    const top = [...roots]
      .sort(([, a], [, b]) => b.self + b.delegated - (a.self + a.delegated))
      .slice(0, CONVERSATION_LIMIT);
    if (top.length === 0) return [];
    const titles = new Map(
      (yield* sql<{ readonly thread_id: string; readonly title: string | null }>`
        SELECT thread_id, json_extract(payload_json, '$.title') AS title
        FROM orchestration_v2_projection_threads
        WHERE ${sql.in(
          "thread_id",
          top.map(([threadId]) => threadId),
        )}
      `).map((row) => [row.thread_id, row.title ?? ""] as const),
    );
    return top.map(([threadId, root]) => ({
      threadId,
      title: titles.get(threadId) ?? "",
      selfTokens: root.self,
      delegatedTokens: root.delegated,
      delegatedThreads: root.threads.size,
    }));
  });

  return TokenUsage.of({ workflowRun, workflowRunTotals, conversations });
});

export const layer = Layer.effect(TokenUsage, make);

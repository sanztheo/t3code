import type {
  ConversationUsage,
  ConversationUsageInput,
  WorkflowRunTokens,
  WorkflowRunTokenTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  delegatingParentSql,
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
  readonly attempts: number;
  readonly run_started_at: string;
}

/**
 * Each thread with the threads it delegated to, directly or not. Each tree stands alone: a thread
 * that is also another root, such as a subagent a later run reused, still counts under this one.
 */
const delegationTrees = Effect.fn("TokenUsage.delegationTrees")(function* (
  sql: SqlClient.SqlClient,
  rootIds: ReadonlyArray<string>,
) {
  const childrenOf = new Map<string, Array<string>>();
  const fetched = new Set<string>();
  let frontier = [...new Set(rootIds)];
  for (let depth = 0; frontier.length > 0 && depth < MAX_LINEAGE_DEPTH; depth += 1) {
    for (const threadId of frontier) fetched.add(threadId);
    const children = yield* sql<{ readonly thread_id: string; readonly parent_id: string }>`
      SELECT * FROM (
        SELECT t.thread_id, ${sql.literal(delegatingParentSql("t"))} AS parent_id
        FROM orchestration_v2_projection_threads t
      ) WHERE parent_id IN ${sql.in(frontier)}
    `;
    frontier = [];
    for (const child of children) {
      childrenOf.set(child.parent_id, [
        ...(childrenOf.get(child.parent_id) ?? []),
        child.thread_id,
      ]);
      if (!fetched.has(child.thread_id)) frontier.push(child.thread_id);
    }
  }
  const treeOf = (rootId: string) => {
    const tree = new Set([rootId]);
    for (const threadId of tree) {
      for (const child of childrenOf.get(threadId) ?? []) tree.add(child);
    }
    return [...tree];
  };
  return new Map(rootIds.map((rootId) => [rootId, treeOf(rootId)] as const));
});

/**
 * The turns each agent step of these runs spent: its thread's and its delegated threads' turns
 * that started while the step ran. A retried step keeps only its last attempt's start, so the run's
 * turns on its thread that no step's window holds go to the first retried step after them. Steps
 * in a linked environment ran elsewhere and are left out.
 */
const runSpending = Effect.fn("TokenUsage.runSpending")(function* (
  sql: SqlClient.SqlClient,
  runIds: ReadonlyArray<string>,
) {
  if (runIds.length === 0) return [];
  const steps = yield* sql<AgentStep>`
    SELECT s.run_id, s.name, s.thread_id, s.started_at, s.ended_at, s.attempts,
      r.started_at AS run_started_at
    FROM workflow_steps s
    JOIN workflow_runs r ON r.run_id = s.run_id
    WHERE ${sql.in("s.run_id", runIds)} AND s.thread_id IS NOT NULL AND s.environment_id IS NULL
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
  const windowOf = (step: AgentStep) => ({
    from: Date.parse(step.started_at),
    until: step.ended_at === null ? Number.POSITIVE_INFINITY : Date.parse(step.ended_at),
  });
  const siblingsOf = (step: AgentStep) =>
    steps.filter(
      (other) =>
        other !== step && other.run_id === step.run_id && other.thread_id === step.thread_id,
    );
  // Earlier attempts left no window. A turn no step's window holds belongs to the first retried
  // step on that thread whose last attempt began after it.
  const ownsUnwindowedTurn = (step: AgentStep, at: number) => {
    const siblings = siblingsOf(step);
    if (siblings.some((other) => at >= windowOf(other).from && at < windowOf(other).until)) {
      return false;
    }
    return !siblings.some(
      (other) =>
        other.attempts > 1 &&
        at < windowOf(other).from &&
        windowOf(other).from < windowOf(step).from,
    );
  };
  return steps.map((step) => {
    const { from, until } = windowOf(step);
    const ownsTurnAt = (at: number) =>
      at < until &&
      (at >= from ||
        (step.attempts > 1 &&
          at >= Date.parse(step.run_started_at) &&
          ownsUnwindowedTurn(step, at)));
    const stepTurns = (trees.get(step.thread_id) ?? []).flatMap((threadId) =>
      (turnsByThread.get(threadId) ?? []).filter(
        (turn) => turn.started_at !== null && ownsTurnAt(Date.parse(turn.started_at)),
      ),
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
    const inWindow = usageTimestampFilter({
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      timeZone: input.timeZone,
      ...(sinceTimeMs === undefined ? {} : { sinceTimeMs }),
      ...(untilTimeMs === undefined ? {} : { untilTimeMs }),
    });
    // A day in the window's zone spans at most a day either side of the same UTC day.
    const from = DateTime.formatIso(
      DateTime.makeUnsafe(sinceTimeMs ?? Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS),
    );
    const until = DateTime.formatIso(
      DateTime.makeUnsafe(untilTimeMs ?? Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS),
    );
    const turns = yield* sql<{
      readonly thread_id: string;
      readonly at: string;
      readonly tokens: number;
    }>`
      SELECT p.thread_id, COALESCE(p.completed_at, p.started_at) AS at,
        ${sql.literal(TURN_TOKENS_SQL)} AS tokens
      FROM orchestration_v2_projection_provider_turns p
      WHERE COALESCE(p.completed_at, p.started_at) >= ${from}
        AND COALESCE(p.completed_at, p.started_at) < ${until}
        AND json_type(p.payload_json, '$.turnTokenUsage') IS NOT NULL
    `;
    const parents = new Map(
      (yield* sql<{ readonly thread_id: string; readonly parent_id: string }>`
        SELECT * FROM (
          SELECT t.thread_id, ${sql.literal(delegatingParentSql("t"))} AS parent_id
          FROM orchestration_v2_projection_threads t
        ) WHERE parent_id IS NOT NULL
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

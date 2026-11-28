import type { ConversationUsage, ConversationUsageInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { delegatingParentSql, TURN_TOKENS_SQL } from "../orchestration-v2/ThreadTokenTotals.ts";
import { usageTimestampFilter } from "./usageAggregation.ts";

/** Lineage is shallow; the bound only stops a corrupted parent cycle. */
const MAX_LINEAGE_DEPTH = 64;
/** The Usage page lists the costliest conversations, not all of them. */
const CONVERSATION_LIMIT = 25;
const DAY_MS = 86_400_000;

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
    /** The top-level conversations that spent the most in a Usage page window. */
    readonly conversations: (
      input: ConversationUsageInput,
    ) => Effect.Effect<ReadonlyArray<ConversationUsage>, SqlError.SqlError>;
  }
>()("t3/usage/TokenUsage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  return TokenUsage.of({ conversations });
});

export const layer = Layer.effect(TokenUsage, make);

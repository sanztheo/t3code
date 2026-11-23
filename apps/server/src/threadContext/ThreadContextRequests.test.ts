import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type ThreadContextBreakdown,
  type ThreadContextBreakdownError,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadContextRequests from "./ThreadContextRequests.ts";

const threadId = ThreadId.make("thread-context");
const claudeThreadId = ProviderThreadId.make("provider-thread-claude");
const codexThreadId = ProviderThreadId.make("provider-thread-codex");
const claudeSessionId = ProviderSessionId.make("provider-session-claude");
const codexSessionId = ProviderSessionId.make("provider-session-codex");

const breakdown: ThreadContextBreakdown = {
  model: "claude-opus-5-5",
  totalTokens: 18_000,
  maxTokens: 1_000_000,
  categories: [{ id: "messages", name: "Messages", tokens: 18_000, kind: "used" }],
  details: [],
};

const claudeRuntime = {
  readContextBreakdown: () => Effect.succeed(breakdown),
} as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
const codexRuntime = {} as ProviderAdapter.ProviderAdapterV2SessionRuntime;

function makeLayer(input: {
  readonly providerThreads: ReadonlyArray<Partial<OrchestrationV2ProviderThread>>;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly sessions: ReadonlyMap<
    ProviderSessionId,
    ProviderAdapter.ProviderAdapterV2SessionRuntime
  >;
}) {
  return ThreadContextRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: input.activeProviderThreadId },
              providerThreads: input.providerThreads,
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: (sessionId: ProviderSessionId) =>
            Effect.succeed(Option.fromNullishOr(input.sessions.get(sessionId))),
        }),
      ),
    ),
  );
}

const reason = <A, R>(effect: Effect.Effect<A, ThreadContextBreakdownError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const ask = Effect.gen(function* () {
  const requests = yield* ThreadContextRequests.ThreadContextRequests;
  return yield* requests.breakdown({ threadId, revision: "2026-11-23T00:00:00.000Z" });
});

describe("ThreadContextRequests", () => {
  it.effect("answers session-stopped when the thread never ran", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reason(ask), "session-stopped");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [{ id: claudeThreadId, providerSessionId: null }],
          activeProviderThreadId: claudeThreadId,
          sessions: new Map(),
        }),
      ),
    ),
  );

  it.effect("answers session-stopped when the session was released", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reason(ask), "session-stopped");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [{ id: claudeThreadId, providerSessionId: claudeSessionId }],
          activeProviderThreadId: claudeThreadId,
          sessions: new Map(),
        }),
      ),
    ),
  );

  it.effect("answers provider-unsupported on the active Codex thread after a Claude one", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reason(ask), "provider-unsupported");
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [
            { id: claudeThreadId, providerSessionId: claudeSessionId },
            { id: codexThreadId, providerSessionId: codexSessionId },
          ],
          activeProviderThreadId: codexThreadId,
          sessions: new Map([
            [claudeSessionId, claudeRuntime],
            [codexSessionId, codexRuntime],
          ]),
        }),
      ),
    ),
  );

  it.effect("returns the runtime's breakdown", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* ask, breakdown);
    }).pipe(
      Effect.provide(
        makeLayer({
          providerThreads: [{ id: claudeThreadId, providerSessionId: claudeSessionId }],
          activeProviderThreadId: claudeThreadId,
          sessions: new Map([[claudeSessionId, claudeRuntime]]),
        }),
      ),
    ),
  );
});

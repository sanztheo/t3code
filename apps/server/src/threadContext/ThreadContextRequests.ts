import {
  ThreadContextBreakdownError,
  type ThreadContextBreakdown,
  type ThreadContextBreakdownInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Asks the thread's live session only; a breakdown never starts one or spends a turn. */
export class ThreadContextRequests extends Context.Service<
  ThreadContextRequests,
  {
    readonly breakdown: (
      input: ThreadContextBreakdownInput,
    ) => Effect.Effect<ThreadContextBreakdown, ThreadContextBreakdownError>;
  }
>()("t3/threadContext/ThreadContextRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const fail = (
    input: ThreadContextBreakdownInput,
    reason: ThreadContextBreakdownError["reason"],
    cause?: unknown,
  ) =>
    new ThreadContextBreakdownError({
      threadId: input.threadId,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const breakdown = Effect.fn("ThreadContextRequests.breakdown")(function* (
    input: ThreadContextBreakdownInput,
  ) {
    const projection = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail(input, "request-failed", cause)));
    // The active provider thread, as provider.uploadFeedback picks it: a switch retires the older one.
    const providerThread =
      projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      ) ?? projection.providerThreads.at(-1);
    if (providerThread?.providerSessionId == null) {
      return yield* fail(input, "session-stopped");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail(input, "request-failed", cause))),
    );
    if (runtime === undefined) return yield* fail(input, "session-stopped");
    if (runtime.readContextBreakdown === undefined) {
      return yield* fail(input, "provider-unsupported");
    }
    return yield* runtime
      .readContextBreakdown({ providerThread })
      .pipe(
        Effect.mapError((cause: ProviderAdapter.ProviderAdapterV2Error) =>
          fail(
            input,
            cause._tag === "ProviderAdapterSessionStoppedError"
              ? "session-stopped"
              : "request-failed",
            cause,
          ),
        ),
      );
  });

  return ThreadContextRequests.of({ breakdown });
});

export const layer = Layer.effect(ThreadContextRequests, make);

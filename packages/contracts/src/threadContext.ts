import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** `used` fills the window, `deferred` is listed but outside it, `buffer` is the compaction reserve. */
export const ThreadContextCategoryKind = Schema.Literals(["used", "free", "buffer", "deferred"]);
export type ThreadContextCategoryKind = typeof ThreadContextCategoryKind.Type;

export const ThreadContextCategory = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  tokens: NonNegativeInt,
  kind: ThreadContextCategoryKind,
});
export type ThreadContextCategory = typeof ThreadContextCategory.Type;

export const ThreadContextDetailRow = Schema.Struct({
  label: Schema.String,
  tokens: NonNegativeInt,
  note: Schema.optional(Schema.String),
});
export type ThreadContextDetailRow = typeof ThreadContextDetailRow.Type;

export const ThreadContextDetailGroup = Schema.Struct({
  categoryId: Schema.String,
  rows: Schema.Array(ThreadContextDetailRow),
});
export type ThreadContextDetailGroup = typeof ThreadContextDetailGroup.Type;

export const ThreadContextBreakdown = Schema.Struct({
  model: Schema.String,
  totalTokens: NonNegativeInt,
  maxTokens: NonNegativeInt,
  autoCompactThreshold: Schema.optional(NonNegativeInt),
  categories: Schema.Array(ThreadContextCategory),
  details: Schema.Array(ThreadContextDetailGroup),
});
export type ThreadContextBreakdown = typeof ThreadContextBreakdown.Type;

/** `revision` only keys the client cache: a new usage report asks again. */
export const ThreadContextBreakdownInput = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.String,
});
export type ThreadContextBreakdownInput = typeof ThreadContextBreakdownInput.Type;

export const ThreadContextBreakdownErrorReason = Schema.Literals([
  "provider-unsupported",
  "session-stopped",
  "request-failed",
]);
export type ThreadContextBreakdownErrorReason = typeof ThreadContextBreakdownErrorReason.Type;

export class ThreadContextBreakdownError extends Schema.TaggedError<ThreadContextBreakdownError>()(
  "ThreadContextBreakdownError",
  {
    threadId: ThreadId,
    reason: ThreadContextBreakdownErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-unsupported":
        return "This thread's provider does not report a context breakdown.";
      case "session-stopped":
        return "The thread's session is not running. Send a message to see the breakdown.";
      case "request-failed":
        return "The context breakdown request failed.";
    }
  }
}

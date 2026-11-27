import { useAtomValue } from "@effect/atom-react";
import type {
  ConversationUsage,
  ConversationUsageInput,
  EnvironmentId,
  ThreadId,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { T, useGT } from "gt-react";

import { serverEnvironment } from "../../state/server";
import { Skeleton } from "../ui/skeleton";

/** Each environment already returns its costliest conversations; the merged list keeps as many. */
const CONVERSATIONS_SHOWN = 25;

interface EnvironmentConversation extends ConversationUsage {
  readonly environmentId: EnvironmentId;
}

interface ConversationsView {
  readonly conversations: readonly EnvironmentConversation[];
  readonly isPending: boolean;
  readonly failed: boolean;
}

const spentBy = (conversation: ConversationUsage) =>
  conversation.selfTokens + conversation.delegatedTokens;

const conversationsAtom = Atom.family((key: string) =>
  Atom.make((get): ConversationsView => {
    const { environmentIds, input } = JSON.parse(key) as {
      readonly environmentIds: readonly EnvironmentId[];
      readonly input: ConversationUsageInput;
    };
    const conversations: EnvironmentConversation[] = [];
    let isPending = false;
    let failed = false;
    for (const environmentId of environmentIds) {
      const result = get(serverEnvironment.conversationUsage({ environmentId, input }));
      isPending ||= result.waiting;
      failed ||= result._tag === "Failure";
      for (const conversation of AsyncResult.getOrElse(result, () => null)?.conversations ?? []) {
        conversations.push({ ...conversation, environmentId });
      }
    }
    conversations.sort((a, b) => spentBy(b) - spentBy(a));
    return { conversations: conversations.slice(0, CONVERSATIONS_SHOWN), isPending, failed };
  }).pipe(Atom.withLabel(`web-usage:conversations:${key}`)),
);

/** The conversations that spent the most in the shown window, delegated threads folded in. */
export function UsageConversations({
  environmentIds,
  window,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly window: UsageSummaryInput;
}) {
  const gt = useGT();
  const input: ConversationUsageInput = {
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
    timeZone: window.timeZone,
    ...(window.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
    ...(window.untilTime === undefined ? {} : { untilTime: window.untilTime }),
  };
  const { conversations, isPending, failed } = useAtomValue(
    conversationsAtom(JSON.stringify({ environmentIds, input })),
  );
  if (conversations.length === 0 && isPending) return <Skeleton className="h-44" />;
  const peak = conversations[0] === undefined ? 0 : spentBy(conversations[0]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-right text-xs text-muted-foreground">
          <th className="py-2 pr-3 pl-2 text-left font-normal">#</th>
          <th className="w-full py-2 text-left font-normal">
            <T>Conversation</T>
          </th>
          <th className="hidden py-2 pl-6 font-normal sm:table-cell">
            <T>Delegated</T>
          </th>
          <th className="py-2 pr-2 pl-6 font-normal">
            <T>Tokens</T>
          </th>
        </tr>
      </thead>
      <tbody>
        {conversations.length === 0 ? (
          <tr>
            <td colSpan={4} className="py-6 text-center text-muted-foreground">
              {failed ? (
                <T>Conversations could not be read.</T>
              ) : (
                <T>No activity in this window.</T>
              )}
            </td>
          </tr>
        ) : (
          conversations.map((conversation, index) => {
            const total = spentBy(conversation);
            return (
              <tr
                key={`${conversation.environmentId}:${conversation.threadId}`}
                className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
              >
                <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                <td className="max-w-0 py-2.5 text-left">
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: conversation.environmentId,
                      threadId: conversation.threadId as ThreadId,
                    }}
                    className="block truncate text-foreground outline-none after:absolute after:inset-0"
                  >
                    {conversation.title.trim() || gt("Untitled conversation")}
                  </Link>
                  {/* Grey is what the conversation spent itself, amber what its delegates spent. */}
                  <div
                    aria-hidden
                    className="mt-1.5 flex h-0.5 max-w-48 gap-px"
                    style={{ width: `max(0.5rem, ${(total / peak) * 100}%)` }}
                  >
                    <div
                      className="rounded-full bg-muted-foreground/60"
                      style={{ flex: `${conversation.selfTokens} 1 0` }}
                    />
                    {conversation.delegatedTokens > 0 ? (
                      <div
                        className="rounded-full bg-warning"
                        style={{ flex: `${conversation.delegatedTokens} 1 0` }}
                      />
                    ) : null}
                  </div>
                </td>
                <td className="hidden py-2.5 pl-6 sm:table-cell">
                  {conversation.delegatedThreads > 0
                    ? gt(
                        "{count, plural, one {{tokens} in {count} thread} other {{tokens} in {count} threads}}",
                        {
                          count: conversation.delegatedThreads,
                          tokens: formatTokens(conversation.delegatedTokens),
                        },
                      )
                    : ""}
                </td>
                <td className="py-2.5 pr-2 pl-6 text-foreground">{formatTokens(total)}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

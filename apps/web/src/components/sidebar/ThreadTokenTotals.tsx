import type { OrchestrationV2ThreadTokenTotals } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import { useGT } from "gt-react";

import { cn } from "../../lib/utils";

/** A conversation past this many tokens stands out in the list. */
const HEAVY_THREAD_TOKENS = 500_000_000;
const MODELS_SHOWN = 3;

const totalOf = (totals: OrchestrationV2ThreadTokenTotals) =>
  totals.selfTokens + totals.delegatedTokens;

/** What a thread spent, its delegated threads included, as a small figure on its row. */
export function ThreadTokenTotal({
  totals,
}: {
  readonly totals: OrchestrationV2ThreadTokenTotals;
}) {
  const total = totalOf(totals);
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums",
        total >= HEAVY_THREAD_TOKENS
          ? "font-medium text-warning-foreground"
          : "text-secondary-label",
      )}
    >
      {formatTokens(total)}
    </span>
  );
}

/** The same figure split: this chat, the threads it delegated to, and by model. */
export function ThreadTokenTotalsFacts({
  totals,
}: {
  readonly totals: OrchestrationV2ThreadTokenTotals;
}) {
  const gt = useGT();
  const total = totalOf(totals);
  const models = Object.entries(totals.byModel)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MODELS_SHOWN);
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2 pl-0.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 font-medium text-foreground tabular-nums">
          {gt("{tokens} tokens", { tokens: formatTokens(total) })}
        </span>
        {totals.cachedTokens > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            {gt("{share} cache reads", { share: formatPercent(totals.cachedTokens / total, 0) })}
          </span>
        ) : null}
      </div>
      {totals.delegatedTokens > 0 ? (
        <>
          <div aria-hidden className="flex h-1 gap-0.5 overflow-hidden rounded-full">
            <div
              className="bg-muted-foreground/60"
              style={{ width: `${(totals.selfTokens / total) * 100}%` }}
            />
            <div className="flex-1 bg-warning" />
          </div>
          <div className="flex gap-2 text-foreground/75">
            <span className="min-w-0 flex-1 truncate">
              {gt("This chat", { $context: "the tokens a conversation spent itself" })}
            </span>
            <span className="tabular-nums">{formatTokens(totals.selfTokens)}</span>
          </div>
          <div className="flex gap-2 text-foreground/75">
            <span className="min-w-0 flex-1 truncate">
              {gt(
                "{count, plural, one {{count} delegated thread} other {{count} delegated threads}}",
                { count: totals.delegatedThreads },
              )}
            </span>
            <span className="tabular-nums">{formatTokens(totals.delegatedTokens)}</span>
          </div>
        </>
      ) : null}
      {models.length > 0 ? (
        <div className="truncate text-muted-foreground">
          {models
            .map(([model, tokens]) => `${formatModelSlugName(model)} ${formatTokens(tokens)}`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

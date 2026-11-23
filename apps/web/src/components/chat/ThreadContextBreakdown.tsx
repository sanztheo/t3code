import type {
  EnvironmentId,
  ThreadContextBreakdown,
  ThreadContextBreakdownError,
  ThreadContextCategory,
  ThreadContextDetailGroup,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { threadContextEnvironment } from "../../state/threadContext";

/** Swatches for what fills the window; the rest stays grey (Décision 7). */
const USED_SWATCH: Record<string, string> = {
  system_prompt: "bg-sky-400",
  system_tools: "bg-violet-400",
  mcp_tools: "bg-emerald-400",
  custom_agents: "bg-amber-400",
  memory_files: "bg-orange-400",
  skills: "bg-teal-400",
  messages: "bg-rose-400",
};
const OTHER_USED_SWATCH = "bg-foreground/60";
const GREY_SWATCH = "bg-muted-foreground/40";

function swatchOf(category: ThreadContextCategory): string {
  if (category.kind !== "used") return GREY_SWATCH;
  return (category.id && USED_SWATCH[category.id]) || OTHER_USED_SWATCH;
}

/** Share of the window with one decimal; integer math so 44.65 % rounds to 44.7. */
function shareOf(tokens: number, maxTokens: number): string {
  return maxTokens > 0 ? `${(Math.round((tokens * 1000) / maxTokens) / 10).toFixed(1)}%` : "";
}

export function ThreadContextBreakdownList({
  breakdown,
}: {
  readonly breakdown: ThreadContextBreakdown;
}) {
  const { maxTokens } = breakdown;
  const detailsById = new Map(breakdown.details.map((group) => [group.categoryId, group]));
  // Over the limit, segments still fill exactly 100 %.
  const used = breakdown.categories.filter((category) => category.kind === "used");
  const scale = Math.max(
    maxTokens,
    used.reduce((sum, category) => sum + category.tokens, 0),
  );
  const tick =
    breakdown.autoCompactThreshold !== undefined &&
    maxTokens > 0 &&
    breakdown.autoCompactThreshold < maxTokens
      ? (breakdown.autoCompactThreshold / maxTokens) * 100
      : null;

  return (
    <div className="flex flex-col gap-1.5 px-2.5 pt-1 pb-2 text-xs">
      <div className="relative flex h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
        {scale > 0
          ? used.map((category) => (
              <span
                key={category.id ?? category.name}
                data-segment
                className={cn(
                  "h-full first:rounded-l-full last:rounded-r-full",
                  swatchOf(category),
                )}
                style={{ width: `${(category.tokens / scale) * 100}%` }}
              />
            ))
          : null}
        {tick !== null ? (
          <span
            aria-hidden
            className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
            style={{ left: `${tick}%` }}
          />
        ) : null}
      </div>
      <div className="flex flex-col">
        {breakdown.categories.map((category) => (
          <CategoryRow
            key={category.id ?? category.name}
            category={category}
            maxTokens={maxTokens}
            details={category.id ? detailsById.get(category.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  maxTokens,
  details,
}: {
  readonly category: ThreadContextCategory;
  readonly maxTokens: number;
  readonly details: ThreadContextDetailGroup | undefined;
}) {
  const [open, setOpen] = useState(false);
  const muted = category.kind !== "used";
  const content = (
    <>
      <span className={cn("size-2 shrink-0 rounded-xs", swatchOf(category))} />
      <span className="min-w-0 flex-1 truncate text-start">{category.name}</span>
      <span className="tabular-nums">{formatContextWindowTokens(category.tokens)}</span>
      <span className="w-12 text-end tabular-nums">{shareOf(category.tokens, maxTokens)}</span>
    </>
  );
  const rowClass = cn(
    "flex h-6 items-center gap-2 rounded-lg px-1",
    muted ? "text-muted-foreground" : "text-foreground/80",
  );
  if (details === undefined) {
    return (
      <div data-kind={category.kind} className={cn(rowClass, "ps-5")}>
        {content}
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={category.name}
        data-kind={category.kind}
        className={cn(
          rowClass,
          "w-full cursor-pointer hover:bg-black/[0.035] dark:hover:bg-white/[0.08]",
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {content}
      </button>
      {open ? (
        <div className="flex flex-col ps-9 pe-1">
          {details.rows.map((row) => (
            <div key={row.label} className="flex h-5 items-center gap-2 text-muted-foreground">
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                  {row.label}
                </TooltipTrigger>
                <TooltipPopup side="left" sideOffset={16}>
                  {row.label}
                </TooltipPopup>
              </Tooltip>
              {row.note ? (
                <span className="shrink-0 text-muted-foreground/70">{row.note}</span>
              ) : null}
              <span className="tabular-nums">{formatContextWindowTokens(row.tokens)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ThreadContextBreakdownTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Asks the live session once per usage report (`revision`) while mounted. */
export function ThreadContextBreakdownPanel({
  target,
  revision,
}: {
  readonly target: ThreadContextBreakdownTarget;
  readonly revision: string;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    threadContextEnvironment.breakdownQuery({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, revision },
    }),
  );
  // Each report swaps in a new query; until it answers, keep the last breakdown of this thread
  // on screen so the list stays mounted and unfolded categories stay open.
  const [shown, setShown] = useState<{
    readonly threadId: ThreadId;
    readonly breakdown: ThreadContextBreakdown;
  } | null>(null);
  if (query.data !== null && shown?.breakdown !== query.data) {
    setShown({ threadId: target.threadId, breakdown: query.data });
  }
  const breakdown = query.data ?? (shown?.threadId === target.threadId ? shown.breakdown : null);
  const failure = query.failure as ThreadContextBreakdownError | null;
  const stopped = failure?.reason === "session-stopped";
  const notice = stopped
    ? gt("Send a message to see the breakdown")
    : query.error !== null
      ? gt("Couldn't load the breakdown")
      : breakdown === null
        ? gt("Loading…")
        : null;
  return (
    <>
      {notice !== null ? (
        <p className="px-2.5 pt-1 pb-2 text-xs text-muted-foreground">{notice}</p>
      ) : null}
      {breakdown !== null && !stopped ? <ThreadContextBreakdownList breakdown={breakdown} /> : null}
    </>
  );
}

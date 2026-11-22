import { ChevronDownIcon } from "lucide-react";
import { useGT } from "gt-react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { TopStatusIcon } from "./SidebarThreadRow";

// The row under the toggle opens its thread, starts a drag or a rename; the toggle does none of that.
const keepFromRow = (event: ReactMouseEvent | ReactPointerEvent) => event.stopPropagation();

/**
 * Folds a parent's running children. Folded, a chip says how many there are, with the
 * working icon while one of them still works, so a folded parent never hides activity.
 */
export function SidebarChildToggle(props: {
  count: number;
  anyWorking: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const gt = useGT();
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={props.expanded ? gt("Collapse child threads") : gt("Expand child threads")}
        onClick={(event) => {
          event.preventDefault();
          keepFromRow(event);
          props.onToggle();
        }}
        onDoubleClick={keepFromRow}
        onPointerDown={keepFromRow}
        className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            !props.expanded && "-rotate-90",
          )}
        />
      </button>
      {props.expanded ? null : (
        <span
          data-testid="sidebar-child-chip"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sidebar-border px-1.5 text-xs tabular-nums text-secondary-label"
        >
          {gt("{count, plural, one {{count} child} other {{count} children}}", {
            count: props.count,
          })}
          {props.anyWorking ? (
            <TopStatusIcon icon="working" className="size-3 text-info-foreground" />
          ) : null}
        </span>
      )}
    </span>
  );
}

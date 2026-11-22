import { cn } from "~/lib/utils";

export type SidebarChildConnectorShape = {
  depth: 1 | 2 | 3;
  isLast: boolean;
  // Entry i: the line of the ancestor at depth i + 1 still runs past this row.
  lineContinues: readonly boolean[];
  // The parent row's content inset, so the lines start under the parent's chevron.
  offsetPx?: number;
};

// Each nesting level shifts the row by one step; a level's line runs down the
// middle of its step so the stub reaches the row with room to spare.
const STEP_PX = 16;
const LINE_OFFSET_PX = 8;

const lineStart = (depth: number) => (depth - 1) * STEP_PX + LINE_OFFSET_PX;

/** The row's start inset, leaving the gutter its connectors are drawn in. */
export function sidebarChildInsetPx(
  depth: SidebarChildConnectorShape["depth"],
  offsetPx = 0,
): number {
  return offsetPx + depth * STEP_PX + 4;
}

/**
 * Draws ├ for a child with siblings below it and a rounded └ for the last one,
 * with CSS borders so the lines meet across rows at any row height.
 */
export function SidebarChildConnector(props: SidebarChildConnectorShape) {
  const ownLineStart = lineStart(props.depth);
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0"
      style={{ insetInlineStart: props.offsetPx ?? 0 }}
    >
      {props.lineContinues
        .flatMap((continues, index) => (continues ? [index + 1] : []))
        .map((ancestorDepth) => (
          <span
            key={ancestorDepth}
            data-connector-ancestor
            className="absolute inset-y-0 border-s border-sidebar-border"
            style={{ insetInlineStart: lineStart(ancestorDepth) }}
          />
        ))}
      <span
        data-connector={props.isLast ? "last" : "mid"}
        className={cn(
          "absolute top-0 border-s border-sidebar-border",
          props.isLast ? "h-1/2 rounded-es-lg border-b" : "bottom-0",
        )}
        style={{
          insetInlineStart: ownLineStart,
          width: sidebarChildInsetPx(props.depth) - ownLineStart,
        }}
      >
        {props.isLast ? null : (
          <span className="absolute inset-x-0 top-1/2 border-t border-sidebar-border" />
        )}
      </span>
    </span>
  );
}

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { splitPaneTargetProps, useSplitDropPreview } from "./splitDrag";
import { splitPaneRects, type SplitNode } from "./splitLayout.logic";

export interface SplitPaneSlot {
  readonly threadKey: string;
  readonly active: boolean;
  /** Only the pane under the window's own controls makes room for them. */
  readonly reserveTitleBarControlInset: boolean;
}

function percent(fraction: number) {
  return `${fraction * 100}%`;
}

function SplitPaneTitle({ threadKey }: { threadKey: string }) {
  const gt = useGT();
  const shell = useQuietThreadShell(parseScopedThreadKey(threadKey));
  return <span className="min-w-0 flex-1 truncate">{shell?.title || gt("Thread")}</span>;
}

/**
 * The threads of one split group, each in its own pane. Panes are siblings keyed by thread and
 * placed from the layout tree, so splitting, closing or moving a pane never remounts the others.
 * The active pane is the route's thread; pressing or focusing another pane makes it active.
 */
export function SplitThreadLayout(props: {
  readonly group: SplitNode;
  readonly activeThreadKey: string;
  readonly onActivate: (threadKey: string) => void;
  readonly onClose: (threadKey: string) => void;
  readonly renderPane: (slot: SplitPaneSlot) => ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="relative min-h-0 flex-1" data-testid="split-layout">
      {splitPaneRects(props.group).map((rect) => {
        const active = rect.threadKey === props.activeThreadKey;
        const activate = (target: EventTarget) => {
          // The close button closes the pane without making it active first.
          const fromClose = target instanceof Element && target.closest("[data-split-pane-close]");
          if (!active && !fromClose) props.onActivate(rect.threadKey);
        };
        return (
          <section
            key={rect.threadKey}
            {...splitPaneTargetProps(rect.threadKey)}
            data-active={active}
            aria-label={gt("Split pane")}
            className={cn(
              "absolute flex min-h-0 min-w-0 flex-col overflow-hidden border-border",
              rect.left > 0 && "border-l",
              rect.top > 0 && "border-t",
            )}
            style={{
              left: percent(rect.left),
              top: percent(rect.top),
              width: percent(rect.width),
              height: percent(rect.height),
            }}
            onPointerDownCapture={(event) => activate(event.target)}
            onFocusCapture={(event) => activate(event.target)}
          >
            <div
              className={cn(
                "flex h-7 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3 text-xs",
                active ? "bg-accent/50 text-foreground" : "text-muted-foreground",
                rect.left === 0 && rect.top === 0 && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
              )}
            >
              <SplitPaneTitle threadKey={rect.threadKey} />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Close pane")}
                data-split-pane-close=""
                onClick={() => props.onClose(rect.threadKey)}
              >
                <XIcon />
              </Button>
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {props.renderPane({
                threadKey: rect.threadKey,
                active,
                // Thirds do not add up to exactly 1 in floating point.
                reserveTitleBarControlInset: rect.top === 0 && rect.left + rect.width > 0.999,
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Shows the part of the pane a dragged thread will take if dropped now. */
export function SplitDropPreview() {
  const preview = useSplitDropPreview();
  if (preview === null) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="split-drop-preview"
      className="pointer-events-none fixed z-[90] rounded-lg border-2 border-primary/60 bg-primary/10 transition-[left,top,width,height] duration-150 ease-out"
      style={{
        left: preview.left,
        top: preview.top,
        width: preview.width,
        height: preview.height,
      }}
    />,
    document.body,
  );
}

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { SPLIT_GROUP_PANE_ATTRIBUTE, splitPaneTargetProps, useSplitDropPreview } from "./splitDrag";
import {
  splitPaneRects,
  type SplitNode,
  type SplitPaneAvailability,
  type SplitRect,
} from "./splitLayout.logic";
import { useSplitPaneState } from "./useSplitPaneState";

export interface SplitPaneSlot {
  readonly threadKey: string;
  readonly active: boolean;
  /** A pane whose thread is gone or hidden says so instead of showing its chat. */
  readonly availability: SplitPaneAvailability;
  /** Only the pane under the window's own controls makes room for them. */
  readonly reserveTitleBarControlInset: boolean;
}

interface SplitLayoutHandlers {
  readonly onActivate: (threadKey: string) => void;
  readonly onClose: (threadKey: string) => void;
  readonly renderPane: (slot: SplitPaneSlot) => ReactNode;
}

function percent(fraction: number) {
  return `${fraction * 100}%`;
}

function SplitPane(
  props: SplitLayoutHandlers & {
    readonly threadRef: ScopedThreadRef;
    readonly rect: SplitRect & { readonly threadKey: string };
    readonly active: boolean;
  },
) {
  const gt = useGT();
  const { rect, active } = props;
  const { availability, title } = useSplitPaneState(props.threadRef);
  const activate = (target: EventTarget) => {
    // The close button closes the pane without making it active first, and a pane whose
    // thread is gone or hidden has no route to make active.
    const fromClose = target instanceof Element && target.closest("[data-split-pane-close]");
    if (!active && !fromClose && availability !== "unavailable") props.onActivate(rect.threadKey);
  };
  return (
    <section
      {...splitPaneTargetProps(rect.threadKey)}
      {...{ [SPLIT_GROUP_PANE_ATTRIBUTE]: "" }}
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
        <span className="min-w-0 flex-1 truncate">{title || gt("Thread")}</span>
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
          availability,
          // Thirds do not add up to exactly 1 in floating point.
          reserveTitleBarControlInset: rect.top === 0 && rect.left + rect.width > 0.999,
        })}
      </div>
    </section>
  );
}

/**
 * The threads of one split group, each in its own pane. Panes are siblings keyed by thread and
 * placed from the layout tree, so splitting, closing or moving a pane never remounts the others.
 * The active pane is the route's thread; pressing or focusing another pane makes it active.
 */
export function SplitThreadLayout(
  props: SplitLayoutHandlers & {
    readonly group: SplitNode;
    readonly activeThreadKey: string;
  },
) {
  return (
    <div className="relative min-h-0 flex-1" data-testid="split-layout">
      {splitPaneRects(props.group).map((rect) => {
        const threadRef = parseScopedThreadKey(rect.threadKey);
        return threadRef === null ? null : (
          <SplitPane
            key={rect.threadKey}
            threadRef={threadRef}
            rect={rect}
            active={rect.threadKey === props.activeThreadKey}
            onActivate={props.onActivate}
            onClose={props.onClose}
            renderPane={props.renderPane}
          />
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

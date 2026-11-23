import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readThreadShell } from "../../state/entities";
import { isOverThreadContextDropTarget } from "../chat/threadContextDrag";
import {
  canSplitPane,
  resolveDropRegion,
  splitDropPreviewRect,
  type SplitDropRegion,
  type SplitRect,
} from "./splitLayout.logic";
import { useSplitViewStore } from "./splitViewStore";

/**
 * A thread dragged out of the sidebar splits the pane it is dropped on. The drag is the sidebar's
 * pointer drag, so panes are found under the pointer rather than through HTML5 drag events, whose
 * `dragleave` also fires on every child element.
 */
const PANE_ATTRIBUTE = "data-split-pane";

/** Marks the element showing `threadKey` as a pane a dragged thread can split. */
export function splitPaneTargetProps(threadKey: string) {
  return { [PANE_ATTRIBUTE]: threadKey } as const;
}

/** Gives the keyboard to the composer of the pane showing `threadKey`, once it has rendered. */
export function focusSplitPane(threadKey: string) {
  requestAnimationFrame(() => {
    document
      .querySelector(`[${PANE_ATTRIBUTE}="${CSS.escape(threadKey)}"]`)
      ?.querySelector<HTMLElement>('[data-testid="composer-editor"]')
      ?.focus();
  });
}

let preview: SplitRect | null = null;
const listeners = new Set<() => void>();

function setPreview(next: SplitRect | null) {
  if (preview === next) return;
  preview = next;
  for (const listener of listeners) listener();
}

/** Where the dropped thread would land, in viewport pixels, while a drag is over a pane. */
export function useSplitDropPreview(): SplitRect | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preview,
    () => null,
  );
}

/** One thread at a time gets a pane; a multi-selection drag only goes to the composer. */
function draggedThreadKey(threads: ReadonlyArray<ScopedThreadRef>): string | null {
  const [thread] = threads;
  // A draft has no shell yet, and a pane shows a server thread.
  if (threads.length !== 1 || thread === undefined || readThreadShell(thread) === null) return null;
  return scopedThreadKey(thread);
}

function findSplitDrop(
  point: { x: number; y: number },
  dragged: string,
): { targetThreadKey: string; rect: SplitRect; region: SplitDropRegion } | null {
  // The composer keeps its own drop: the thread joins the next message as context.
  if (isOverThreadContextDropTarget(point)) return null;
  const element = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>(`[${PANE_ATTRIBUTE}]`);
  const targetThreadKey = element?.getAttribute(PANE_ATTRIBUTE);
  if (!element || !targetThreadKey || targetThreadKey === dragged) return null;
  const rect = element.getBoundingClientRect();
  const canSplit = canSplitPane(useSplitViewStore.getState().groups, targetThreadKey, dragged);
  return { targetThreadKey, rect, region: resolveDropRegion(rect, point, canSplit) };
}

export function moveSplitDrag(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
) {
  const dragged = draggedThreadKey(threads);
  const drop = dragged === null ? null : findSplitDrop(point, dragged);
  setPreview(drop === null ? null : splitDropPreviewRect(drop.rect, drop.region));
}

export function endSplitDrag() {
  setPreview(null);
}

/** Splits the pane under `point`; returns the dropped thread, which the caller shows. */
export function dropSplitDrag(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  setPreview(null);
  const dragged = draggedThreadKey(threads);
  const drop = dragged === null ? null : findSplitDrop(point, dragged);
  if (dragged === null || drop === null) return null;
  useSplitViewStore.getState().dropThread({
    targetThreadKey: drop.targetThreadKey,
    draggedThreadKey: dragged,
    region: drop.region,
  });
  return threads[0] ?? null;
}

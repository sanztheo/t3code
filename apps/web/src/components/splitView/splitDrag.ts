import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readThreadShell } from "../../state/entities";
import { isOverThreadContextDropTarget } from "../chat/threadContextDrag";
import {
  canSplitPane,
  dropThreadOnPane,
  findSplitGroup,
  resolveDropRegion,
  splitDropPreviewRect,
  type SplitDrop,
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

/** Marks a pane of a split group, which a press inside makes active. */
export const SPLIT_GROUP_PANE_ATTRIBUTE = "data-split-group-pane";

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
): { drop: SplitDrop; rect: SplitRect } | null {
  // The composer keeps its own drop: the thread joins the next message as context.
  if (isOverThreadContextDropTarget(point)) return null;
  const element = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>(`[${PANE_ATTRIBUTE}]`);
  const targetThreadKey = element?.getAttribute(PANE_ATTRIBUTE);
  if (!element || !targetThreadKey || targetThreadKey === dragged) return null;
  const rect = element.getBoundingClientRect();
  const canSplit = canSplitPane(useSplitViewStore.getState().groups, targetThreadKey, dragged);
  const region = resolveDropRegion(rect, point, canSplit);
  return { drop: { targetThreadKey, draggedThreadKey: dragged, region }, rect };
}

export function moveSplitDrag(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
) {
  const dragged = draggedThreadKey(threads);
  const found = dragged === null ? null : findSplitDrop(point, dragged);
  setPreview(
    found === null
      ? null
      : splitDropPreviewRect(useSplitViewStore.getState().groups, found.drop, found.rect),
  );
}

export function endSplitDrag() {
  setPreview(null);
}

/**
 * Splits the pane under `point` and shows the dropped thread through `show`, a navigation.
 * Returns whether the drop landed on a pane.
 */
export function dropSplitDrag(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
  show: (thread: ScopedThreadRef) => Promise<unknown>,
): boolean {
  setPreview(null);
  const [thread] = threads;
  const dragged = draggedThreadKey(threads);
  const found = dragged === null ? null : findSplitDrop(point, dragged);
  if (thread === undefined || found === null) return false;
  const store = useSplitViewStore.getState();
  if (findSplitGroup(dropThreadOnPane(store.groups, found.drop), found.drop.draggedThreadKey)) {
    store.dropThread(found.drop);
    // A replaced route pane shows its replacement until the route lands on it.
    void show(thread).finally(store.endReplacement);
  } else {
    // The drop leaves the dragged thread alone (the group's other pane dropped on its centre):
    // the route moves first, as on close, so the replaced thread never shows alone.
    void show(thread).then(() => store.dropThread(found.drop));
  }
  return true;
}

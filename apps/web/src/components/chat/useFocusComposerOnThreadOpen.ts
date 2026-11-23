import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { restoreFocusOnThreadEnter } from "../../lib/terminalFocus";
import { SPLIT_GROUP_PANE_ATTRIBUTE } from "../splitView/splitDrag";

/** Restores thread focus, landing the caret a frame after composer entry. */
export function useFocusComposerOnThreadOpen(
  threadRef: ScopedThreadRef | null,
  root: HTMLElement | null,
  enabled: boolean,
  terminalOpen: boolean,
  focusComposer: () => void,
) {
  const drawerOpenRef = useRef(terminalOpen);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores DOM focus on thread entry and after the drawer opens or closes
  useEffect(() => {
    const drawerToggled = drawerOpenRef.current !== terminalOpen;
    drawerOpenRef.current = terminalOpen;
    if (!threadRef || !enabled || !root) return;
    let frame: number | undefined;
    const leave = restoreFocusOnThreadEnter(threadRef, {
      root,
      // Pressing inside a split pane makes it active, and the press already put the focus (a
      // field, the caret in the draft) where the user wants it. A drawer toggle in the active
      // pane still restores it, since the toggle button holds the focus then.
      keepFocus:
        !drawerToggled &&
        root.closest(`[${SPLIT_GROUP_PANE_ATTRIBUTE}]`)?.contains(document.activeElement) === true,
      focusComposer: () => {
        frame = window.requestAnimationFrame(() => {
          // Double-clicking a sidebar row opens its thread and its rename field in one gesture.
          if (document.activeElement?.matches("[data-sidebar-row] input")) return;
          focusComposer();
        });
      },
    });
    return () => {
      leave();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [
    threadRef,
    root,
    enabled,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Drawer visibility changes also restore focus after explicit open/close actions.
    terminalOpen,
    focusComposer,
  ]);
}

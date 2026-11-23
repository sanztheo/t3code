import { T } from "gt-react";
import { use } from "react";

import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { SplitPaneCloseButton } from "./SplitPaneCloseButton";
import type { SplitPaneSlot } from "./SplitThreadLayout";

/** One thread of a split group, a full chat like the main screen's. */
export function SplitPaneThread({
  threadRef,
  active,
  availability,
  reserveTitleBarControlInset,
  splitPane,
}: SplitPaneSlot) {
  const routeInBackground = use(BackgroundThreadContext);
  // The command palette drives the active pane's composer; the others keep their own.
  const sharedComposerHandle = useComposerHandleContext();
  if (availability !== "ready") {
    // No chat header yet, or ever: a bare one still lets the pane close.
    return (
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 pr-3 pl-5 text-xs text-muted-foreground",
          splitPane.atWindowStart && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <p className="min-w-0 flex-1 truncate">
          {availability === "unavailable" ? <T>This thread is no longer available.</T> : null}
        </p>
        <SplitPaneCloseButton onClose={splitPane.onClose} />
      </div>
    );
  }
  // An inactive pane's window-wide shortcuts and listeners stand down, as under Settings.
  return (
    <BackgroundThreadContext value={routeInBackground || !active}>
      <ComposerHandleContext value={active ? sharedComposerHandle : null}>
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset={reserveTitleBarControlInset}
          splitPane={splitPane}
        />
      </ComposerHandleContext>
    </BackgroundThreadContext>
  );
}

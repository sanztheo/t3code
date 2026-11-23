import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { T } from "gt-react";
import { use } from "react";

import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import type { SplitPaneSlot } from "./SplitThreadLayout";

/** One thread of a split group, a full chat like the main screen's. */
export function SplitPaneThread({
  threadKey,
  active,
  availability,
  reserveTitleBarControlInset,
}: SplitPaneSlot) {
  const routeInBackground = use(BackgroundThreadContext);
  // The command palette drives the active pane's composer; the others keep their own.
  const sharedComposerHandle = useComposerHandleContext();
  const threadRef = parseScopedThreadKey(threadKey);
  if (availability === "unavailable") {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        <T>This thread is no longer available.</T>
      </p>
    );
  }
  if (availability === "loading" || threadRef === null) return null;
  // An inactive pane's window-wide shortcuts and listeners stand down, as under Settings.
  return (
    <BackgroundThreadContext value={routeInBackground || !active}>
      <ComposerHandleContext value={active ? sharedComposerHandle : null}>
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset={reserveTitleBarControlInset}
        />
      </ComposerHandleContext>
    </BackgroundThreadContext>
  );
}

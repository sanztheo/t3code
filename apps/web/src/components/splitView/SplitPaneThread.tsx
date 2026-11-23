import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T } from "gt-react";
import { use } from "react";

import { ComposerHandleContext, useComposerHandleContext } from "../../composerHandleContext";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { useShownThreadRenderState } from "../ThreadRouteView";
import type { SplitPaneSlot } from "./SplitThreadLayout";

function SplitPaneChat({
  threadRef,
  active,
  reserveTitleBarControlInset,
}: {
  threadRef: ScopedThreadRef;
  active: boolean;
  reserveTitleBarControlInset: boolean;
}) {
  const { shell, renderState } = useShownThreadRenderState(threadRef);
  const routeInBackground = use(BackgroundThreadContext);
  // The command palette drives the active pane's composer; the others keep their own.
  const sharedComposerHandle = useComposerHandleContext();
  if (renderState === "missing") {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        <T>This thread is no longer available.</T>
      </p>
    );
  }
  if (renderState === "loading" && shell === null) return null;
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

/** One thread of a split group, a full chat like the main screen's. */
export function SplitPaneThread({ threadKey, active, reserveTitleBarControlInset }: SplitPaneSlot) {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) return null;
  return (
    <SplitPaneChat
      threadRef={threadRef}
      active={active}
      reserveTitleBarControlInset={reserveTitleBarControlInset}
    />
  );
}

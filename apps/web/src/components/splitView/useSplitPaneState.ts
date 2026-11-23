import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useAnyEnvironmentHiding, useHiddenThreadKeys } from "../../state/entities";
import { useShownThreadRenderState } from "../ThreadRouteView";
import { splitPaneAvailability } from "./splitLayout.logic";

/** Whether a group member shows its chat, under the route's own visibility rules. */
export function useSplitPaneState(threadRef: ScopedThreadRef) {
  const { shell, renderState } = useShownThreadRenderState(threadRef);
  const hiddenByTag = useHiddenThreadKeys().has(threadKey(threadRef));
  const hidingAnywhere = useAnyEnvironmentHiding();
  const availability = splitPaneAvailability({
    renderState,
    listed: shell !== null,
    hiddenByTag,
    hidingAnywhere,
  });
  return { availability };
}

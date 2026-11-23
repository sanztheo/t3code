import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  readAnyEnvironmentHiding,
  readHiddenThreadKeys,
  readThreadShell,
} from "../../state/entities";
import {
  closeSplitPane,
  decodeSplitGroups,
  dropThreadOnPane,
  findSplitGroup,
  nextSplitPane,
  splitDropReplacement,
  splitPaneAvailability,
  type SplitDrop,
  type SplitGroups,
} from "./splitLayout.logic";

interface SplitViewState {
  /** Each group is the layout of threads opened together; threads are scoped thread keys. */
  readonly groups: SplitGroups;
  /**
   * The last centre drop's swap in a group. While the route is still on `from`, it shows the
   * group of `to`, which it is about to navigate to, instead of `from` alone.
   */
  readonly replacement: { readonly from: string; readonly to: string } | null;
  readonly dropThread: (drop: SplitDrop) => void;
  /** The route followed the drop, or gave up. */
  readonly endReplacement: () => void;
  readonly closePane: (threadKey: string) => void;
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set) => ({
      groups: [],
      replacement: null,
      dropThread: (drop) =>
        set((state) => ({
          groups: dropThreadOnPane(state.groups, drop),
          replacement: splitDropReplacement(state.groups, drop),
        })),
      endReplacement: () => set({ replacement: null }),
      closePane: (threadKey) =>
        set((state) => ({ groups: closeSplitPane(state.groups, threadKey) })),
    }),
    {
      name: "t3code:split-view:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ groups }) => ({ groups }),
      // Read on every load, not only on version changes, so a corrupt save never reaches the layout.
      merge: (persisted, current) => ({
        ...current,
        groups: decodeSplitGroups((persisted as { groups?: unknown } | null)?.groups),
      }),
    },
  ),
);

/**
 * Whether a group member's pane shows its chat right now, by the rule the pane itself follows.
 * A member off the shell list is not looked up here, so it counts as still loading.
 */
function splitPaneShowsNow(paneKey: string): boolean {
  const ref = parseScopedThreadKey(paneKey);
  if (ref === null) return false;
  const shell = readThreadShell(ref);
  const availability = splitPaneAvailability({
    renderState: shell === null ? "loading" : shell.deletedAt != null ? "missing" : "ready",
    listed: shell !== null,
    hiddenByTag: readHiddenThreadKeys().has(threadKey(ref)),
    hidingAnywhere: readAnyEnvironmentHiding(),
  });
  return availability === "ready";
}

/**
 * The pane that becomes active when the active thread `leavingThreadKey` closes or is deleted:
 * the nearest one in its group that shows its chat, or null outside a group or when none does.
 */
export function splitTakeoverThreadKey(leavingThreadKey: string): string | null {
  const group = findSplitGroup(useSplitViewStore.getState().groups, leavingThreadKey);
  return group === null ? null : nextSplitPane(group, leavingThreadKey, splitPaneShowsNow);
}

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  closeSplitPane,
  decodeSplitGroups,
  dropThreadOnPane,
  splitDropReplacement,
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

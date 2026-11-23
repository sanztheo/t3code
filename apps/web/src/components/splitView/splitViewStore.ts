import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import {
  closeSplitPane,
  decodeSplitGroups,
  dropThreadOnPane,
  type SplitDropRegion,
  type SplitGroups,
} from "./splitLayout.logic";

interface SplitViewState {
  /** Each group is the layout of threads opened together; threads are scoped thread keys. */
  readonly groups: SplitGroups;
  readonly dropThread: (drop: {
    readonly targetThreadKey: string;
    readonly draggedThreadKey: string;
    readonly region: SplitDropRegion;
  }) => void;
  /** Returns the pane that takes over when the closed one was active. */
  readonly closePane: (threadKey: string) => string | null;
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set, get) => ({
      groups: [],
      dropThread: (drop) => set((state) => ({ groups: dropThreadOnPane(state.groups, drop) })),
      closePane: (threadKey) => {
        const { groups, nextThreadKey } = closeSplitPane(get().groups, threadKey);
        set({ groups });
        return nextThreadKey;
      },
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

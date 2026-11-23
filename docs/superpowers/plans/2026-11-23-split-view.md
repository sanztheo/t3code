# Split View Plan

**Goal:** Like Claude Code Desktop, drag a thread from the sidebar onto the chat: where it drops decides the split (right part → new pane on the right, bottom part → below, same for left and top). Up to four panes (two, then a 2×2 grid). Each pane has a close X. Panes opened together form a group: clicking any thread of the group in the sidebar brings back the whole group with its layout.

**Architecture:** A group is a layout tree (`split` nodes with an orientation, `pane` leaves holding one scoped thread key), kept in a persisted zustand store. The route stays the single source of the shown thread: when the route's thread belongs to a group, `ThreadRouteView` renders `SplitThreadLayout` instead of the lone `ChatView`; the route's thread is the active pane. Each pane is a full `ChatView`; inactive ones run under `BackgroundThreadContext`, the existing switch that makes a thread kept under Settings stand its window-wide shortcuts and listeners down. The sidebar's existing pointer drag (dnd-kit sensor that already drags a thread out of the list onto the composer as context) also feeds the split drop.

**Source:** the drop-region rule, the split insertion and the tree normalization are ported from react-resizable-panels 4.24.1 (MIT), commit `8a73365c0e1125f1a9d26d873c5e7bbbce7b7988`: `lib/workspace/utils/getDropRegion.ts`, `lib/workspace/utils/measureDropIndicatorInsets.ts`, `lib/workspace/models/splitTabset.ts`, `lib/workspace/models/normalizeNode.ts`. Cited in `splitLayout.logic.ts`.

## Décisions

1. **No new dependency.** The rules are ported, not installed: `arbre` is rebased on upstream every 3 hours and a `pnpm-lock.yaml` change would conflict every time.
2. **Drop region:** the nearest edge when the pointer is within 25 % of the pane's width or height; tie order left, bottom, right, top (as the source). The preview shows the half the new pane will take; at the centre it covers the whole pane.
3. **Centre drop = show the dragged thread in that pane.** In a group, it replaces the pane's thread, which leaves the group. Over a lone thread, nothing splits and the dragged thread simply opens (as a click on it would).
4. **Composer keeps its drop.** Dropping on the composer still adds the thread as context to the next message, as before; anywhere else in the chat splits. A multi-selection drag only goes to the composer.
5. **Four panes at most.** A full group offers only the centre (replace). Nested splits of any shape are allowed within the four (three side by side, 2×2, one plus two stacked…).
6. **Equal sizes, no resize handle.** Each split shares its space equally. The existing `useResizeDrag` only resizes horizontally, and a vertical one would be new code nobody asked for yet.
7. **Active pane = the route's thread.** Pressing or focusing an inactive pane navigates to its thread, so the URL, the sidebar highlight and Back/Forward follow the active pane. Inactive panes stand their window-wide shortcuts, paste-to-composer, refocus-on-window-focus and desktop snapshot focus down; the command palette drives the active pane's composer only.
8. **Groups.** A thread belongs to one group at most. Dragging a thread that is in another group moves it out of that group. A group left with one pane dissolves, and that thread shows alone again. Opening a thread outside any group shows it alone; the groups stay saved.
9. **Close X** in a slim title bar above each pane (title of the thread, highlighted when active). Closing the active pane makes the pane beside it (reading order) active; the keyboard goes back to the active pane's composer.
10. **Persistence:** `localStorage` key `t3code:split-view:v1`, decoded on every load; an unreadable or oversized group is dropped instead of breaking the chat.
11. **Panes are siblings placed from the tree** (absolute positions in percent), keyed by thread, so splitting, closing or moving a pane never remounts the other panes. Going from a lone thread to a group (and back) remounts that one chat once: the lone path must stay exactly as upstream renders it so draft promotion keeps its `ChatView`.
12. **Deleted thread in a group:** its pane says « This thread is no longer available. » and keeps its close X.

## Not covered

- No resize handle between panes (Décision 6).
- Narrow windows and mobile: a group renders as on desktop; there is no stacked fallback.
- Not run in the real Electron app: pointer events over `app-region: drag` areas (the chat header) and over webviews or iframes (browser preview panel) may swallow the drag there, as they already do for the composer drop.

## Tests

- `apps/web/src/components/splitView/splitLayout.logic.test.ts`: drop regions and tie order, split insertion, 2×2 grid, centre replace, four-pane limit, moves between and within groups, close and normalization, saved-state decoding.
- `apps/web/src/components/splitView/SplitThreadLayout.browser.test.tsx`: 2×2 placement and active pane, activation on press but not on close, drag preview rectangle and drop into the store, multi-selection ignored.

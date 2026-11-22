import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { ContextMenuItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { ThreadActionMenuId } from "../threadActionMenu.logic";
import { SidebarChildToggle } from "./SidebarChildToggle";
import {
  buildSidebarChildTree,
  SIDEBAR_COLLAPSED_PARENTS_KEY,
  type SidebarChildNode,
} from "./sidebarChildTree";

const NO_COLLAPSED_PARENTS: readonly string[] = [];
const COLLAPSED_PARENTS_SCHEMA = Schema.Array(Schema.String);
const NO_CHILDREN: readonly SidebarChildNode[] = [];

// Where a parent row's content starts (px-2.5, or ps-9 inside a project folder): its
// children's lines start there, under its chevron, so they always sit deeper than it.
const PARENT_CONTENT_INSET_PX = 10;
const FOLDER_PARENT_CONTENT_INSET_PX = 36;

// A child ends with its parent, so its menu keeps only what reads or copies it:
// no pin, settle, snooze, rename, archive or delete of its own.
const CHILD_MENU_ACTIONS: ReadonlySet<ThreadActionMenuId> = new Set([
  "find",
  "new-thread-on-branch",
  "filter-by-project",
  "project-settings",
  "mark-unread",
  "share-guest",
  "copy",
  "copy-path",
  "copy-branch",
  "copy-thread",
  "copy-thread-id",
]);

export function childThreadMenuItems(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return items.filter((item) => CHILD_MENU_ACTIONS.has(item.id));
}

/**
 * The running children nested under each listed sidebar row, and whether the user
 * folded them. Drag, sweep and jump hints never see these rows: they stay off the
 * sidebar's list items.
 */
export function useSidebarChildRows(input: {
  /** Every thread shell, children included: the navigation list already drops them. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
}) {
  const tree = buildSidebarChildTree({
    threads: input.threads,
    delegatedUnderParent: input.delegatedUnderParent,
    keepVisibleKey: input.routeThreadKey,
  });
  const [collapsedParentKeys, setCollapsedParentKeys] = useLocalStorage(
    SIDEBAR_COLLAPSED_PARENTS_KEY,
    NO_COLLAPSED_PARENTS,
    COLLAPSED_PARENTS_SCHEMA,
  );
  const childThreadByKey = new Map<string, EnvironmentThreadShell>();
  for (const nodes of tree.values()) {
    for (const node of nodes) childThreadByKey.set(node.key, node.thread);
  }
  const isExpanded = (parentKey: string) => !collapsedParentKeys.includes(parentKey);
  const shownChildrenOf = (parentKey: string) =>
    isExpanded(parentKey) ? (tree.get(parentKey) ?? NO_CHILDREN) : NO_CHILDREN;

  return {
    shownChildrenOf,
    childThread: (key: string) => childThreadByKey.get(key),
    /** The open child's own row when it shows, else the listed row that stands for it. */
    activeRowKey: (routeRowKey: string | null, routeThreadKey: string | null) =>
      routeRowKey !== null &&
      shownChildrenOf(routeRowKey).some((node) => node.key === routeThreadKey)
        ? routeThreadKey
        : routeRowKey,
    connectorOffsetPx: (inFolder: boolean) =>
      inFolder ? FOLDER_PARENT_CONTENT_INSET_PX : PARENT_CONTENT_INSET_PX,
    toggleFor: (parentKey: string) => {
      const children = tree.get(parentKey);
      if (children === undefined) return undefined;
      return (
        <SidebarChildToggle
          count={children.length}
          anyWorking={children.some((node) => isThreadWorking(node.thread))}
          expanded={isExpanded(parentKey)}
          onToggle={() =>
            setCollapsedParentKeys((keys) =>
              keys.includes(parentKey)
                ? keys.filter((key) => key !== parentKey)
                : [...keys, parentKey],
            )
          }
        />
      );
    },
  };
}

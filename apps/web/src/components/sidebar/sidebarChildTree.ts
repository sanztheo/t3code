import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { isListedThreadLineage, isLiveSubagentShell } from "@t3tools/contracts";

/** The scoped keys of parents whose children the user folded away. */
export const SIDEBAR_COLLAPSED_PARENTS_KEY = "t3code:sidebar-collapsed-parents:v1";

/** Deeper children still show, at this depth, so the row keeps room for its title. */
export const SIDEBAR_CHILD_MAX_DEPTH = 3;

type SidebarChildDepth = 1 | 2 | 3;

export interface SidebarChildNode {
  readonly thread: EnvironmentThreadShell;
  /** scopedThreadKey of the child. */
  readonly key: string;
  readonly depth: SidebarChildDepth;
  /** No later sibling at its depth: the row draws └ rather than ├. */
  readonly isLast: boolean;
  /** Entry i: the ancestor at depth i + 1 has a later sibling, so its line runs through this row. */
  readonly lineContinues: readonly boolean[];
}

// A subagent or side chat hangs off a thread of its own environment; a task delegated
// here hangs off the thread in the linked environment that delegated it.
function directParentKey(thread: EnvironmentThreadShell): string | null {
  if (!isListedThreadLineage(thread.lineage)) {
    const parentId = thread.lineage.parentThreadId;
    return parentId === null
      ? null
      : scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
  }
  const from = thread.delegatedFrom;
  return from == null ? null : scopedThreadKey(scopeThreadRef(from.environmentId, from.threadId));
}

/**
 * The live children to show under each listed thread, flattened in display order.
 * Live is the lineage panel's « running »: a child between turns while it awaits its own
 * background command, or waiting on the user, still holds its parent.
 * An ended child leaves the tree, unless the route opens it or a descendant is still
 * live. A child whose chain never reaches a listed thread (archived or missing parent,
 * cycle) is left out.
 */
export function buildSidebarChildTree(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  /** The route thread's key: it stays visible after its run ends. */
  readonly keepVisibleKey: string | null;
}): ReadonlyMap<string, readonly SidebarChildNode[]> {
  const listedKeys = new Set<string>();
  const childByKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(ref);
    // isShownUnderParent reads delegatedUnderParent by its own threadKey format.
    if (isShownUnderParent(ref, thread.lineage, input.delegatedUnderParent)) {
      childByKey.set(key, thread);
    } else {
      listedKeys.add(key);
    }
  }

  const childrenByParent = new Map<
    string,
    Array<{ key: string; thread: EnvironmentThreadShell }>
  >();
  for (const [key, thread] of childByKey) {
    const parentKey = directParentKey(thread);
    if (parentKey === null) continue;
    const siblings = childrenByParent.get(parentKey);
    if (siblings === undefined) childrenByParent.set(parentKey, [{ key, thread }]);
    else siblings.push({ key, thread });
  }

  // An ended child stays while a descendant is live, so that descendant keeps its real
  // parent rather than showing under an ancestor that never started it.
  const shownByKey = new Map<string, boolean>();
  const isShown = (key: string, thread: EnvironmentThreadShell): boolean => {
    const known = shownByKey.get(key);
    if (known !== undefined) return known;
    // A cycle back to this child counts as not shown, which ends the walk.
    shownByKey.set(key, false);
    const shown =
      isLiveSubagentShell(thread.source) ||
      key === input.keepVisibleKey ||
      (childrenByParent.get(key) ?? []).some((child) => isShown(child.key, child.thread));
    shownByKey.set(key, shown);
    return shown;
  };
  for (const [parentKey, siblings] of childrenByParent) {
    childrenByParent.set(parentKey, siblings.filter((child) => isShown(child.key, child.thread)));
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(
      (left, right) =>
        left.thread.createdAt.localeCompare(right.thread.createdAt) ||
        left.key.localeCompare(right.key),
    );
  }

  const tree = new Map<string, readonly SidebarChildNode[]>();
  for (const listedKey of listedKeys) {
    // Each shown child has one parent, so a cycle never reaches a listed thread and
    // this walk ends.
    const rows: Array<{ key: string; thread: EnvironmentThreadShell; depth: SidebarChildDepth }> =
      [];
    const addChildren = (parentKey: string, level: number) => {
      for (const child of childrenByParent.get(parentKey) ?? []) {
        rows.push({
          ...child,
          depth: Math.min(level, SIDEBAR_CHILD_MAX_DEPTH) as SidebarChildDepth,
        });
        addChildren(child.key, level + 1);
      }
    };
    addChildren(listedKey, 1);
    if (rows.length === 0) continue;
    // Lines follow the depths as drawn, so capped rows read as siblings at depth 3.
    const hasLaterSibling = (index: number, depth: number) => {
      for (const row of rows.slice(index + 1)) {
        if (row.depth <= depth) return row.depth === depth;
      }
      return false;
    };
    tree.set(
      listedKey,
      rows.map((row, index) => ({
        ...row,
        isLast: !hasLaterSibling(index, row.depth),
        lineContinues: Array.from({ length: row.depth - 1 }, (_, ancestor) =>
          hasLaterSibling(index, ancestor + 1),
        ),
      })),
    );
  }
  return tree;
}

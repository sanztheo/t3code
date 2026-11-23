/**
 * Split view layout rules: where a dropped thread lands, and how a group of panes is kept tidy.
 *
 * The drop region rule, the split insertion and the normalization are ported from
 * react-resizable-panels 4.24.1 (MIT, Copyright (c) 2014 Brian Vaughn), commit
 * 8a73365c0e1125f1a9d26d873c5e7bbbce7b7988:
 * - lib/workspace/utils/getDropRegion.ts
 * - lib/workspace/utils/measureDropIndicatorInsets.ts
 * - lib/workspace/models/splitTabset.ts
 * - lib/workspace/models/normalizeNode.ts
 * Ported rather than installed so the fork's lockfile stays identical to upstream's.
 * Panes here hold one thread each (no tabs), every split shares its space equally, and the
 * trees are immutable.
 */

export type SplitDropRegion = "left" | "right" | "top" | "bottom" | "center";
type SplitEdge = Exclude<SplitDropRegion, "center">;

/** `horizontal` lays children side by side, `vertical` stacks them. */
export type SplitOrientation = "horizontal" | "vertical";

export type SplitNode =
  | { readonly type: "pane"; readonly threadKey: string }
  | {
      readonly type: "split";
      readonly orientation: SplitOrientation;
      readonly children: ReadonlyArray<SplitNode>;
    };

/** A group is the root of a tree with at least two panes; a thread belongs to one group at most. */
export type SplitGroups = ReadonlyArray<SplitNode>;

export interface SplitRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Two side by side, then a 2×2 grid: past four panes each one gets too narrow to chat in. */
export const SPLIT_MAX_PANES = 4;

/** Dropping within this fraction of an edge splits the pane; anywhere else drops on its centre. */
const EDGE_THRESHOLD = 0.25;

/** Closer edges win; on a tie the earlier one in this order wins, as in the source. */
const EDGE_ORDER: ReadonlyArray<SplitEdge> = ["left", "bottom", "right", "top"];

export function getDropRegion(rect: SplitRect, clientX: number, clientY: number): SplitDropRegion {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const distances: Record<SplitEdge, number> = { left: x, bottom: 1 - y, right: 1 - x, top: y };
  const closest = EDGE_ORDER.reduce((best, edge) =>
    distances[edge] < distances[best] ? edge : best,
  );
  return distances[closest] < EDGE_THRESHOLD ? closest : "center";
}

/** A pane that cannot split any more only takes centre drops. */
export function resolveDropRegion(
  rect: SplitRect,
  point: { readonly x: number; readonly y: number },
  canSplit: boolean,
): SplitDropRegion {
  return canSplit ? getDropRegion(rect, point.x, point.y) : "center";
}

/** The part of the pane the dropped thread will take: half of it at an edge, all of it at the centre. */
export function splitDropPreviewRect(rect: SplitRect, region: SplitDropRegion): SplitRect {
  const { left, top, width, height } = rect;
  switch (region) {
    case "left":
      return { left, top, width: width / 2, height };
    case "right":
      return { left: left + width / 2, top, width: width / 2, height };
    case "top":
      return { left, top, width, height: height / 2 };
    case "bottom":
      return { left, top: top + height / 2, width, height: height / 2 };
    case "center":
      return rect;
  }
}

export function splitThreadKeys(node: SplitNode): ReadonlyArray<string> {
  return node.type === "pane" ? [node.threadKey] : node.children.flatMap(splitThreadKeys);
}

export function findSplitGroup(groups: SplitGroups, threadKey: string): SplitNode | null {
  return groups.find((group) => splitThreadKeys(group).includes(threadKey)) ?? null;
}

/** Whether `draggedThreadKey` may land beside `targetThreadKey` without passing the pane limit. */
export function canSplitPane(
  groups: SplitGroups,
  targetThreadKey: string,
  draggedThreadKey: string,
): boolean {
  const group = findSplitGroup(groups, targetThreadKey);
  if (group === null) return true;
  const keys = splitThreadKeys(group);
  const panesAfterMove = keys.includes(draggedThreadKey) ? keys.length - 1 : keys.length;
  return panesAfterMove < SPLIT_MAX_PANES;
}

/** Every pane's place as fractions of the group's box, in reading order. */
export function splitPaneRects(
  node: SplitNode,
  box: SplitRect = { left: 0, top: 0, width: 1, height: 1 },
): ReadonlyArray<SplitRect & { readonly threadKey: string }> {
  if (node.type === "pane") return [{ threadKey: node.threadKey, ...box }];
  const share = 1 / node.children.length;
  return node.children.flatMap((child, index) =>
    splitPaneRects(
      child,
      node.orientation === "horizontal"
        ? {
            left: box.left + box.width * share * index,
            top: box.top,
            width: box.width * share,
            height: box.height,
          }
        : {
            left: box.left,
            top: box.top + box.height * share * index,
            width: box.width,
            height: box.height * share,
          },
    ),
  );
}

/**
 * Drops a removed child, replaces a split left with one child by that child, and lifts the
 * children of a split that runs the same way as its parent into the parent.
 */
function normalizeSplitNode(node: SplitNode): SplitNode | null {
  if (node.type === "pane") return node;
  const children: SplitNode[] = [];
  for (const child of node.children) {
    const normalized = normalizeSplitNode(child);
    if (normalized === null) continue;
    if (normalized.type === "split" && normalized.orientation === node.orientation) {
      children.push(...normalized.children);
    } else {
      children.push(normalized);
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

function mapPanes(node: SplitNode, map: (threadKey: string) => SplitNode | null): SplitNode | null {
  if (node.type === "pane") return map(node.threadKey);
  return normalizeSplitNode({
    ...node,
    children: node.children.flatMap((child) => {
      const mapped = mapPanes(child, map);
      return mapped === null ? [] : [mapped];
    }),
  });
}

function withoutThread(node: SplitNode, threadKey: string): SplitNode | null {
  return mapPanes(node, (key) => (key === threadKey ? null : { type: "pane", threadKey: key }));
}

/** Puts `inserted` beside `targetThreadKey`, sharing the target's space. */
function splitPane(
  node: SplitNode,
  targetThreadKey: string,
  inserted: SplitNode,
  edge: SplitEdge,
): SplitNode {
  const orientation: SplitOrientation =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const insertBefore = edge === "left" || edge === "top";
  const visit = (current: SplitNode): SplitNode => {
    if (current.type === "pane") {
      if (current.threadKey !== targetThreadKey) return current;
      // Wrap the target in a new split in the other direction.
      return {
        type: "split",
        orientation,
        children: insertBefore ? [inserted, current] : [current, inserted],
      };
    }
    const index = current.children.findIndex(
      (child) => child.type === "pane" && child.threadKey === targetThreadKey,
    );
    if (index !== -1 && current.orientation === orientation) {
      // The parent already runs this way, so the new pane joins it beside the target.
      const children = [...current.children];
      children.splice(insertBefore ? index : index + 1, 0, inserted);
      return { ...current, children };
    }
    return { ...current, children: current.children.map(visit) };
  };
  return visit(node);
}

function paneCount(node: SplitNode): number {
  return splitThreadKeys(node).length;
}

/**
 * Drops `draggedThreadKey` on the pane showing `targetThreadKey`. An edge puts it beside the
 * target; the centre puts it in the target's place, so the target thread leaves the group. The
 * dragged thread first leaves any group it was in. A group that ends with one pane dissolves.
 */
export function dropThreadOnPane(
  groups: SplitGroups,
  drop: {
    readonly targetThreadKey: string;
    readonly draggedThreadKey: string;
    readonly region: SplitDropRegion;
  },
): SplitGroups {
  const { targetThreadKey, draggedThreadKey } = drop;
  if (targetThreadKey === draggedThreadKey) return groups;
  const region = canSplitPane(groups, targetThreadKey, draggedThreadKey) ? drop.region : "center";
  const targetGroup = findSplitGroup(groups, targetThreadKey);
  if (region === "center" && targetGroup === null) return groups;

  const dragged: SplitNode = { type: "pane", threadKey: draggedThreadKey };
  const remaining = groups.flatMap((group) => {
    const next = withoutThread(group, draggedThreadKey);
    return next === null ? [] : [next];
  });
  const targetIndex = remaining.findIndex((group) =>
    splitThreadKeys(group).includes(targetThreadKey),
  );
  const targetRoot: SplitNode =
    targetIndex === -1 ? { type: "pane", threadKey: targetThreadKey } : remaining[targetIndex]!;
  const nextRoot =
    region === "center"
      ? mapPanes(targetRoot, (key) =>
          key === targetThreadKey ? dragged : { type: "pane", threadKey: key },
        )
      : normalizeSplitNode(splitPane(targetRoot, targetThreadKey, dragged, region));
  const next =
    targetIndex === -1
      ? [...remaining, nextRoot]
      : remaining.map((group, index) => (index === targetIndex ? nextRoot : group));
  return next.filter((group): group is SplitNode => group !== null && paneCount(group) > 1);
}

/**
 * Closes the pane showing `threadKey`. `nextThreadKey` is the pane beside it in reading order,
 * which takes over when the closed pane was the active one.
 */
export function closeSplitPane(
  groups: SplitGroups,
  threadKey: string,
): { readonly groups: SplitGroups; readonly nextThreadKey: string | null } {
  const group = findSplitGroup(groups, threadKey);
  if (group === null) return { groups, nextThreadKey: null };
  const keys = splitThreadKeys(group);
  const index = keys.indexOf(threadKey);
  const nextThreadKey = keys[index - 1] ?? keys[index + 1] ?? null;
  const rest = withoutThread(group, threadKey);
  return {
    groups: groups.flatMap((candidate) =>
      candidate !== group ? [candidate] : rest !== null && paneCount(rest) > 1 ? [rest] : [],
    ),
    nextThreadKey,
  };
}

function decodeSplitNode(value: unknown): SplitNode | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  if (node.type === "pane") {
    return typeof node.threadKey === "string" ? { type: "pane", threadKey: node.threadKey } : null;
  }
  if (
    node.type !== "split" ||
    (node.orientation !== "horizontal" && node.orientation !== "vertical") ||
    !Array.isArray(node.children)
  ) {
    return null;
  }
  const children = node.children.map(decodeSplitNode);
  if (children.some((child) => child === null)) return null;
  return { type: "split", orientation: node.orientation, children: children as SplitNode[] };
}

/** Reads saved groups, dropping anything unreadable, so a corrupt save cannot break the chat. */
export function decodeSplitGroups(saved: unknown): SplitGroups {
  if (!Array.isArray(saved)) return [];
  const seen = new Set<string>();
  return saved.flatMap((value) => {
    const decoded = decodeSplitNode(value);
    if (decoded === null) return [];
    const kept = new Set<string>();
    const group = mapPanes(decoded, (key) => {
      if (seen.has(key) || kept.has(key)) return null;
      kept.add(key);
      return { type: "pane", threadKey: key };
    });
    if (group === null) return [];
    const count = paneCount(group);
    if (count < 2 || count > SPLIT_MAX_PANES) return [];
    for (const key of splitThreadKeys(group)) seen.add(key);
    return [group];
  });
}

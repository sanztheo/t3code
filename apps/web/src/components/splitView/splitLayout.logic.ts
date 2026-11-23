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

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

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

/** What a drop does: a pane that cannot split any more takes the dropped thread in its place. */
export interface SplitDrop {
  readonly targetThreadKey: string;
  readonly draggedThreadKey: string;
  readonly region: SplitDropRegion;
}

function effectiveDropRegion(groups: SplitGroups, drop: SplitDrop): SplitDropRegion {
  return canSplitPane(groups, drop.targetThreadKey, drop.draggedThreadKey) ? drop.region : "center";
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
export function dropThreadOnPane(groups: SplitGroups, drop: SplitDrop): SplitGroups {
  const { targetThreadKey, draggedThreadKey } = drop;
  if (targetThreadKey === draggedThreadKey) return groups;
  const region = effectiveDropRegion(groups, drop);
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
 * Where the dropped thread will sit, in the pixels of `targetRect` (the target pane's box): its
 * place in the group the drop produces, laid over the box the target's group fills now.
 */
export function splitDropPreviewRect(
  groups: SplitGroups,
  drop: SplitDrop,
  targetRect: SplitRect,
): SplitRect {
  const whole: SplitRect = { left: 0, top: 0, width: 1, height: 1 };
  const placeOf = (group: SplitNode | null, threadKey: string) =>
    group === null ? null : splitPaneRects(group).find((rect) => rect.threadKey === threadKey);
  const target = placeOf(findSplitGroup(groups, drop.targetThreadKey), drop.targetThreadKey) ?? whole;
  const width = targetRect.width / target.width;
  const height = targetRect.height / target.height;
  const left = targetRect.left - target.left * width;
  const top = targetRect.top - target.top * height;
  const dropped = placeOf(
    findSplitGroup(dropThreadOnPane(groups, drop), drop.draggedThreadKey),
    drop.draggedThreadKey,
  );
  // A centre drop over a lone thread splits nothing: the dragged thread opens in its place.
  if (!dropped) return targetRect;
  return {
    left: left + dropped.left * width,
    top: top + dropped.top * height,
    width: dropped.width * width,
    height: dropped.height * height,
  };
}

/** The group pane a drop puts the dragged thread in place of, if any. */
export function splitDropReplacement(
  groups: SplitGroups,
  drop: SplitDrop,
): { readonly from: string; readonly to: string } | null {
  const replaces =
    drop.targetThreadKey !== drop.draggedThreadKey &&
    effectiveDropRegion(groups, drop) === "center" &&
    findSplitGroup(groups, drop.targetThreadKey) !== null;
  return replaces ? { from: drop.targetThreadKey, to: drop.draggedThreadKey } : null;
}

/** Closes the pane showing `threadKey`; a group left with one pane dissolves. */
export function closeSplitPane(groups: SplitGroups, threadKey: string): SplitGroups {
  const group = findSplitGroup(groups, threadKey);
  if (group === null) return groups;
  const rest = withoutThread(group, threadKey);
  return groups.flatMap((candidate) =>
    candidate !== group ? [candidate] : rest !== null && paneCount(rest) > 1 ? [rest] : [],
  );
}

/**
 * The pane that takes over from `threadKey`: the nearest one before it in reading order, or
 * after it for the first pane, among those `canShow` accepts.
 */
export function nextSplitPane(
  group: SplitNode,
  threadKey: string,
  canShow: (threadKey: string) => boolean = () => true,
): string | null {
  const keys = splitThreadKeys(group);
  const index = keys.indexOf(threadKey);
  const candidates = [...keys.slice(0, index).toReversed(), ...keys.slice(index + 1)];
  return candidates.find(canShow) ?? null;
}

export type SplitPaneAvailability = "ready" | "loading" | "unavailable";

/**
 * What a group member shows: only what its own route would. A thread that is gone or that the
 * tag filter hides is unavailable, and so is one off the shell list while any filter hides,
 * since the route then opens it only as a visible parent's child, which a pane never holds.
 */
export function splitPaneAvailability(input: {
  readonly renderState: "ready" | "loading" | "missing";
  /** Whether the shell lists the thread. */
  readonly listed: boolean;
  readonly hiddenByTag: boolean;
  readonly hidingAnywhere: boolean;
}): SplitPaneAvailability {
  if (input.renderState === "missing" || input.hiddenByTag) return "unavailable";
  if (input.listed) return "ready";
  if (input.renderState === "loading") return "loading";
  return input.hidingAnywhere ? "unavailable" : "ready";
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
      if (parseScopedThreadKey(key) === null || seen.has(key) || kept.has(key)) return null;
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

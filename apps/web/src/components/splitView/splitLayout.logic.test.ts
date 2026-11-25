import { describe, expect, it } from "vite-plus/test";

import {
  closeSplitPane,
  decodeSplitGroups,
  dropThreadOnPane,
  findSplitGroup,
  getDropRegion,
  nextSplitPane,
  resolveDropRegion,
  splitDropPreviewRect,
  splitDropReplacement,
  splitPaneAvailability,
  splitPaneRects,
  type SplitNode,
} from "./splitLayout.logic";

const pane = (threadKey: string): SplitNode => ({ type: "pane", threadKey });
const row = (...children: SplitNode[]): SplitNode => ({
  type: "split",
  orientation: "horizontal",
  children,
});
const column = (...children: SplitNode[]): SplitNode => ({
  type: "split",
  orientation: "vertical",
  children,
});
const rect = { left: 100, top: 50, width: 400, height: 200 };

describe("getDropRegion", () => {
  it.each([
    { x: 110, y: 150, region: "left" },
    { x: 490, y: 150, region: "right" },
    { x: 300, y: 60, region: "top" },
    { x: 300, y: 240, region: "bottom" },
    { x: 300, y: 150, region: "center" },
    // Just inside the 25 % band on the right.
    { x: 401, y: 150, region: "right" },
    // Exactly on the band edge is no longer within it.
    { x: 400, y: 150, region: "center" },
  ] as const)("returns $region at ($x, $y)", ({ x, y, region }) => {
    expect(getDropRegion(rect, x, y)).toBe(region);
  });

  it("breaks a corner tie in the order left, bottom, right, top", () => {
    // Top-left corner: left and top are equally close, left wins.
    expect(getDropRegion(rect, 100, 50)).toBe("left");
    // Bottom-right corner: bottom and right are equally close, bottom wins.
    expect(getDropRegion(rect, 500, 250)).toBe("bottom");
    // Top-right corner: right and top are equally close, right wins.
    expect(getDropRegion(rect, 500, 50)).toBe("right");
  });

  it("treats an unmeasured pane as its centre", () => {
    expect(getDropRegion({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe("center");
  });

  it("offers only the centre when the pane cannot split", () => {
    expect(resolveDropRegion(rect, { x: 110, y: 150 }, false)).toBe("center");
    expect(resolveDropRegion(rect, { x: 110, y: 150 }, true)).toBe("left");
  });
});

describe("dropThreadOnPane", () => {
  it("splits a single thread into a group on each edge", () => {
    expect(
      dropThreadOnPane([], { targetThreadKey: "A", draggedThreadKey: "B", region: "right" }),
    ).toEqual([row(pane("A"), pane("B"))]);
    expect(
      dropThreadOnPane([], { targetThreadKey: "A", draggedThreadKey: "B", region: "left" }),
    ).toEqual([row(pane("B"), pane("A"))]);
    expect(
      dropThreadOnPane([], { targetThreadKey: "A", draggedThreadKey: "B", region: "bottom" }),
    ).toEqual([column(pane("A"), pane("B"))]);
    expect(
      dropThreadOnPane([], { targetThreadKey: "A", draggedThreadKey: "B", region: "top" }),
    ).toEqual([column(pane("B"), pane("A"))]);
  });

  it("inserts beside the target when its split already runs that way", () => {
    expect(
      dropThreadOnPane([row(pane("A"), pane("B"))], {
        targetThreadKey: "A",
        draggedThreadKey: "C",
        region: "right",
      }),
    ).toEqual([row(pane("A"), pane("C"), pane("B"))]);
  });

  it("builds a 2×2 grid from two side-by-side panes", () => {
    const three = dropThreadOnPane([row(pane("A"), pane("B"))], {
      targetThreadKey: "A",
      draggedThreadKey: "C",
      region: "bottom",
    });
    expect(three).toEqual([row(column(pane("A"), pane("C")), pane("B"))]);
    expect(
      dropThreadOnPane(three, { targetThreadKey: "B", draggedThreadKey: "D", region: "bottom" }),
    ).toEqual([row(column(pane("A"), pane("C")), column(pane("B"), pane("D")))]);
  });

  it("replaces the target thread on a centre drop, and the replaced thread leaves the group", () => {
    expect(
      dropThreadOnPane([row(pane("A"), pane("B"))], {
        targetThreadKey: "B",
        draggedThreadKey: "C",
        region: "center",
      }),
    ).toEqual([row(pane("A"), pane("C"))]);
  });

  it("leaves the groups alone on a centre drop over a thread outside any group", () => {
    const groups = [row(pane("A"), pane("B"))];
    expect(
      dropThreadOnPane(groups, { targetThreadKey: "X", draggedThreadKey: "Y", region: "center" }),
    ).toBe(groups);
  });

  it("leaves the groups alone when a thread is dropped on itself", () => {
    const groups = [row(pane("A"), pane("B"))];
    expect(
      dropThreadOnPane(groups, { targetThreadKey: "A", draggedThreadKey: "A", region: "right" }),
    ).toBe(groups);
  });

  it("moves a thread out of its old group, which dissolves once one pane is left", () => {
    expect(
      dropThreadOnPane([row(pane("A"), pane("B")), row(pane("C"), pane("D"))], {
        targetThreadKey: "C",
        draggedThreadKey: "B",
        region: "top",
      }),
    ).toEqual([row(column(pane("B"), pane("C")), pane("D"))]);
  });

  it("moves a thread within its own group", () => {
    expect(
      dropThreadOnPane([row(pane("A"), pane("B"), pane("C"))], {
        targetThreadKey: "A",
        draggedThreadKey: "C",
        region: "top",
      }),
    ).toEqual([row(column(pane("C"), pane("A")), pane("B"))]);
  });

  it("re-splits the remaining pane when one of two panes moves onto the other", () => {
    expect(
      dropThreadOnPane([row(pane("A"), pane("B"))], {
        targetThreadKey: "A",
        draggedThreadKey: "B",
        region: "bottom",
      }),
    ).toEqual([column(pane("A"), pane("B"))]);
  });

  it("never splits a group past four panes", () => {
    const grid = row(column(pane("A"), pane("C")), column(pane("B"), pane("D")));
    expect(
      dropThreadOnPane([grid], { targetThreadKey: "A", draggedThreadKey: "E", region: "right" }),
    ).toEqual([row(column(pane("E"), pane("C")), column(pane("B"), pane("D")))]);
  });
});

describe("closeSplitPane", () => {
  it("dissolves a two-pane group", () => {
    expect(closeSplitPane([row(pane("A"), pane("B"))], "B")).toEqual([]);
  });

  it("replaces a split left with one child by that child", () => {
    expect(closeSplitPane([row(column(pane("A"), pane("C")), pane("B"))], "C")).toEqual([
      row(pane("A"), pane("B")),
    ]);
  });

  it("merges a split into its parent when both run the same way", () => {
    expect(
      closeSplitPane([row(pane("A"), column(pane("B"), row(pane("C"), pane("D"))))], "B"),
    ).toEqual([row(pane("A"), pane("C"), pane("D"))]);
  });

  it("does nothing for a thread outside any group", () => {
    const groups = [row(pane("A"), pane("B"))];
    expect(closeSplitPane(groups, "X")).toBe(groups);
  });
});

describe("nextSplitPane", () => {
  it("hands over to the pane before, or after for the first one, in reading order", () => {
    expect(nextSplitPane(row(pane("A"), pane("B")), "B")).toBe("A");
    expect(nextSplitPane(row(column(pane("A"), pane("C")), pane("B")), "C")).toBe("A");
    expect(nextSplitPane(row(pane("A"), pane("B"), pane("C")), "A")).toBe("B");
  });

  it("skips panes that cannot show their thread", () => {
    const group = row(pane("A"), pane("B"), pane("C"), pane("D"));
    expect(nextSplitPane(group, "C", (key) => key !== "B")).toBe("A");
    expect(nextSplitPane(group, "B", (key) => key === "D")).toBe("D");
    expect(nextSplitPane(group, "B", () => false)).toBeNull();
  });
});

describe("splitDropReplacement", () => {
  it("names the thread a centre drop puts in a group pane's place", () => {
    const groups = [row(pane("A"), pane("B"))];
    const drop = { targetThreadKey: "A", draggedThreadKey: "C" } as const;
    expect(splitDropReplacement(groups, { ...drop, region: "center" })).toEqual({
      from: "A",
      to: "C",
    });
    expect(splitDropReplacement(groups, { ...drop, region: "right" })).toBeNull();
    // Over a lone thread nothing is replaced: the dragged thread simply opens.
    expect(
      splitDropReplacement([], { targetThreadKey: "X", draggedThreadKey: "C", region: "center" }),
    ).toBeNull();
  });

  it("names none when the drop dissolves the group, which leaves no pane to swap", () => {
    expect(
      splitDropReplacement([row(pane("A"), pane("B"))], {
        targetThreadKey: "A",
        draggedThreadKey: "B",
        region: "center",
      }),
    ).toBeNull();
  });

  it("counts an edge drop on a full group as the centre drop it becomes", () => {
    const grid = row(column(pane("A"), pane("C")), column(pane("B"), pane("D")));
    expect(
      splitDropReplacement([grid], { targetThreadKey: "A", draggedThreadKey: "E", region: "left" }),
    ).toEqual({ from: "A", to: "E" });
  });
});

describe("splitPaneAvailability", () => {
  const listed = {
    renderState: "ready",
    listed: true,
    hiddenByTag: false,
    hidingAnywhere: false,
  } as const;
  it.each([
    { input: listed, expected: "ready" },
    { input: { ...listed, renderState: "loading" }, expected: "ready" },
    { input: { ...listed, listed: false, renderState: "loading" }, expected: "loading" },
    { input: { ...listed, renderState: "missing" }, expected: "unavailable" },
    { input: { ...listed, listed: false, renderState: "unreachable" }, expected: "unavailable" },
    // The route closes a thread the tag filter hides, and while hiding any thread off the list.
    { input: { ...listed, hiddenByTag: true }, expected: "unavailable" },
    { input: { ...listed, listed: false, hidingAnywhere: true }, expected: "unavailable" },
    { input: { ...listed, listed: false }, expected: "ready" },
  ] as const)("is $expected in case %#", ({ input, expected }) => {
    expect(splitPaneAvailability(input)).toBe(expected);
  });
});

describe("findSplitGroup", () => {
  it("finds the group that holds a thread", () => {
    const first = row(pane("A"), pane("B"));
    const second = column(pane("C"), pane("D"));
    expect(findSplitGroup([first, second], "D")).toBe(second);
    expect(findSplitGroup([first, second], "X")).toBeNull();
  });
});

describe("splitPaneRects", () => {
  it("shares each split equally among its children", () => {
    expect(splitPaneRects(row(column(pane("A"), pane("C")), pane("B")))).toEqual([
      { threadKey: "A", left: 0, top: 0, width: 0.5, height: 0.5 },
      { threadKey: "C", left: 0, top: 0.5, width: 0.5, height: 0.5 },
      { threadKey: "B", left: 0.5, top: 0, width: 0.5, height: 1 },
    ]);
  });
});

describe("splitDropPreviewRect", () => {
  it.each([
    { region: "left", expected: { left: 100, top: 50, width: 200, height: 200 } },
    { region: "right", expected: { left: 300, top: 50, width: 200, height: 200 } },
    { region: "top", expected: { left: 100, top: 50, width: 400, height: 100 } },
    { region: "bottom", expected: { left: 100, top: 150, width: 400, height: 100 } },
    { region: "center", expected: rect },
  ] as const)("covers the half a lone thread gives on $region", ({ region, expected }) => {
    expect(
      splitDropPreviewRect([], { targetThreadKey: "A", draggedThreadKey: "B", region }, rect),
    ).toEqual(expected);
  });

  it("covers the share the drop gives when the target's split already runs that way", () => {
    // A|B over 0–800 px: C dropped on B's right edge joins the row as its third pane.
    const preview = splitDropPreviewRect(
      [row(pane("A"), pane("B"))],
      { targetThreadKey: "B", draggedThreadKey: "C", region: "right" },
      { left: 400, top: 0, width: 400, height: 400 },
    );
    expect(preview.left).toBeCloseTo(1600 / 3);
    expect(preview.width).toBeCloseTo(800 / 3);
    expect({ top: preview.top, height: preview.height }).toEqual({ top: 0, height: 400 });
  });

  it("covers the whole group when the drop dissolves it", () => {
    // A|B over 0–800 px: B dropped on A's centre leaves B alone, at full width.
    expect(
      splitDropPreviewRect(
        [row(pane("A"), pane("B"))],
        { targetThreadKey: "A", draggedThreadKey: "B", region: "center" },
        { left: 0, top: 0, width: 400, height: 400 },
      ),
    ).toEqual({ left: 0, top: 0, width: 800, height: 400 });
  });

  it("covers the target's place on a centre drop in a group", () => {
    const target = { left: 400, top: 200, width: 400, height: 200 };
    expect(
      splitDropPreviewRect(
        [row(column(pane("A"), pane("C")), column(pane("B"), pane("D")))],
        { targetThreadKey: "D", draggedThreadKey: "E", region: "right" },
        target,
      ),
    ).toEqual(target);
  });
});

describe("decodeSplitGroups", () => {
  // Saved panes hold scoped thread keys, `environment:thread`.
  const saved = (threadId: string) => pane(`environment:${threadId}`);

  it.each([null, 3, "x", { groups: [] }, [{ type: "split" }], [{ type: "pane" }]])(
    "drops unreadable saved state %#",
    (value) => {
      expect(decodeSplitGroups(value)).toEqual([]);
    },
  );

  it("keeps valid groups and normalizes them", () => {
    expect(
      decodeSplitGroups([row(saved("A"), row(saved("B"), saved("C"))), column(saved("D"))]),
    ).toEqual([row(saved("A"), saved("B"), saved("C"))]);
  });

  it("keeps a thread in its first group only and drops groups past four panes", () => {
    expect(
      decodeSplitGroups([
        row(saved("A"), saved("B")),
        row(saved("B"), saved("C"), saved("D")),
        row(saved("E"), saved("F"), saved("G"), saved("H"), saved("I")),
      ]),
    ).toEqual([row(saved("A"), saved("B")), row(saved("C"), saved("D"))]);
  });

  it("drops panes whose key has a blank part instead of throwing", () => {
    expect(
      decodeSplitGroups([row(pane("environment: "), pane("  :thread"), saved("A"), saved("B"))]),
    ).toEqual([row(saved("A"), saved("B"))]);
  });

  it("drops panes whose key names no thread, then the groups left with one pane", () => {
    expect(
      decodeSplitGroups([
        row(pane(""), saved("A"), pane("not-a-key"), saved("B")),
        row(pane(":"), saved("C")),
      ]),
    ).toEqual([row(saved("A"), saved("B"))]);
  });
});

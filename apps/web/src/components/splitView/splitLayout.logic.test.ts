import { describe, expect, it } from "vite-plus/test";

import {
  closeSplitPane,
  decodeSplitGroups,
  dropThreadOnPane,
  findSplitGroup,
  getDropRegion,
  resolveDropRegion,
  splitDropPreviewRect,
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
  it("dissolves a two-pane group and activates the other pane", () => {
    expect(closeSplitPane([row(pane("A"), pane("B"))], "B")).toEqual({
      groups: [],
      nextThreadKey: "A",
    });
  });

  it("replaces a split left with one child by that child", () => {
    expect(closeSplitPane([row(column(pane("A"), pane("C")), pane("B"))], "C")).toEqual({
      groups: [row(pane("A"), pane("B"))],
      nextThreadKey: "A",
    });
  });

  it("merges a split into its parent when both run the same way", () => {
    expect(
      closeSplitPane([row(pane("A"), column(pane("B"), row(pane("C"), pane("D"))))], "B"),
    ).toEqual({ groups: [row(pane("A"), pane("C"), pane("D"))], nextThreadKey: "A" });
  });

  it("activates the next pane when the first one closes", () => {
    expect(closeSplitPane([row(pane("A"), pane("B"), pane("C"))], "A")).toEqual({
      groups: [row(pane("B"), pane("C"))],
      nextThreadKey: "B",
    });
  });

  it("does nothing for a thread outside any group", () => {
    const groups = [row(pane("A"), pane("B"))];
    expect(closeSplitPane(groups, "X")).toEqual({ groups, nextThreadKey: null });
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
  ] as const)("covers the half the new pane takes on $region", ({ region, expected }) => {
    expect(splitDropPreviewRect(rect, region)).toEqual(expected);
  });
});

describe("decodeSplitGroups", () => {
  it.each([null, 3, "x", { groups: [] }, [{ type: "split" }], [{ type: "pane" }]])(
    "drops unreadable saved state %#",
    (saved) => {
      expect(decodeSplitGroups(saved)).toEqual([]);
    },
  );

  it("keeps valid groups and normalizes them", () => {
    expect(
      decodeSplitGroups([row(pane("A"), row(pane("B"), pane("C"))), column(pane("D"))]),
    ).toEqual([row(pane("A"), pane("B"), pane("C"))]);
  });

  it("keeps a thread in its first group only and drops groups past four panes", () => {
    expect(
      decodeSplitGroups([
        row(pane("A"), pane("B")),
        row(pane("B"), pane("C"), pane("D")),
        row(pane("E"), pane("F"), pane("G"), pane("H"), pane("I")),
      ]),
    ).toEqual([row(pane("A"), pane("B")), row(pane("C"), pane("D"))]);
  });
});

import appCss from "../../index.css?inline";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../../state/entities"), () => ({
  readThreadShell: (() => ({ title: "Dragged" })) as never,
  readHiddenThreadKeys: (() => new Set()) as never,
  readAnyEnvironmentHiding: (() => false) as never,
}));
// Threads listed here are gone or hidden; the others show their chat.
const unavailableThreadIds = vi.hoisted(() => new Set<string>());
vi.mock(import("./useSplitPaneState"), () => ({
  useSplitPaneState: ((ref: { threadId: string }) => ({
    availability: unavailableThreadIds.has(ref.threadId) ? "unavailable" : "ready",
  })) as never,
}));

import { render } from "../../../test/render";
import { dropSplitDrag, endSplitDrag, moveSplitDrag } from "./splitDrag";
import { SplitPaneCloseButton } from "./SplitPaneCloseButton";
import type { SplitNode } from "./splitLayout.logic";
import { SplitDropPreview, SplitThreadLayout } from "./SplitThreadLayout";
import { useSplitViewStore } from "./splitViewStore";

const environmentId = EnvironmentId.make("environment");
const ref = (threadId: string) => scopeThreadRef(environmentId, ThreadId.make(threadId));
const key = (threadId: string) => scopedThreadKey(ref(threadId));
const pane = (threadId: string): SplitNode => ({ type: "pane", threadKey: key(threadId) });
const sideBySide: SplitNode = {
  type: "split",
  orientation: "horizontal",
  children: [pane("A"), pane("B")],
};
const grid: SplitNode = {
  type: "split",
  orientation: "horizontal",
  children: [
    { type: "split", orientation: "vertical", children: [pane("A"), pane("C")] },
    { type: "split", orientation: "vertical", children: [pane("B"), pane("D")] },
  ],
};

/** App styles, a viewport with room for the 800×400 layout, and no group or drag left behind. */
async function splitTestEnvironment(): Promise<Disposable> {
  await page.viewport(1000, 600);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  useSplitViewStore.setState({ groups: [] });
  return {
    [Symbol.dispose]: () => {
      endSplitDrag();
      style.remove();
      unavailableThreadIds.clear();
      useSplitViewStore.setState({ groups: [] });
    },
  };
}

function sizedContainer() {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:0;top:0;width:800px;height:400px;display:flex;flex-direction:column";
  return container;
}

function layout(
  group: SplitNode,
  handlers: { onActivate?: (threadKey: string) => void; onClose?: (threadKey: string) => void },
) {
  return (
    <>
      <SplitThreadLayout
        group={group}
        activeThreadKey={key("A")}
        onActivate={handlers.onActivate ?? (() => {})}
        onClose={handlers.onClose ?? (() => {})}
        renderPane={(slot) => (
          <>
            <p>
              {slot.active ? "active" : "inactive"} {slot.availability} {slot.threadKey}
              {slot.reserveTitleBarControlInset ? " controls" : ""}
              {slot.splitPane.atWindowStart ? " start" : ""}
            </p>
            <SplitPaneCloseButton onClose={slot.splitPane.onClose} />
          </>
        )}
      />
      <SplitDropPreview />
    </>
  );
}

it("places four panes in a 2×2 grid with the route thread active", async () => {
  using _environment = await splitTestEnvironment();
  await using screen = await render(layout(grid, {}), { container: sizedContainer() });
  const panes = screen.container.querySelectorAll<HTMLElement>("[data-split-pane]");
  expect([...panes].map((element) => element.getBoundingClientRect().toJSON())).toMatchObject([
    { left: 0, top: 0, width: 400, height: 200 },
    { left: 0, top: 200, width: 400, height: 200 },
    { left: 400, top: 0, width: 400, height: 200 },
    { left: 400, top: 200, width: 400, height: 200 },
  ]);
  // Only the top-left pane sits under the window's traffic lights, only the top-right one
  // under its panel controls.
  await expect.element(screen.getByText(`active ready ${key("A")} start`)).toBeInTheDocument();
  await expect.element(screen.getByText(`inactive ready ${key("B")} controls`)).toBeInTheDocument();
  await expect
    .element(screen.getByText(`inactive ready ${key("C")}`, { exact: true }))
    .toBeInTheDocument();
  // The pane is the chat alone: no title strip of its own above the chat's header.
  const chatA = screen.getByText(`active ready ${key("A")} start`).element();
  expect(chatA.getBoundingClientRect().top).toBe(0);
});

it("activates a pane when it is pressed, but not when its close button is", async () => {
  using _environment = await splitTestEnvironment();
  const onActivate = vi.fn();
  const onClose = vi.fn();
  await using screen = await render(layout(sideBySide, { onActivate, onClose }), {
    container: sizedContainer(),
  });
  await screen.getByText(`active ready ${key("A")} start`).click();
  expect(onActivate).not.toHaveBeenCalled();
  await screen.getByText(`inactive ready ${key("B")} controls`).click();
  expect(onActivate).toHaveBeenCalledWith(key("B"));
  onActivate.mockClear();
  await screen.getByRole("button", { name: "Close pane" }).nth(1).click();
  expect(onClose).toHaveBeenCalledWith(key("B"));
  expect(onActivate).not.toHaveBeenCalled();
});

it("never activates a pane whose thread is gone or hidden", async () => {
  using _environment = await splitTestEnvironment();
  unavailableThreadIds.add("B");
  const onActivate = vi.fn();
  await using screen = await render(layout(sideBySide, { onActivate }), {
    container: sizedContainer(),
  });
  const pane = screen.getByText(`inactive unavailable ${key("B")} controls`);
  await expect.element(pane).toBeInTheDocument();
  await pane.click();
  expect(onActivate).not.toHaveBeenCalled();
});

it("previews the half a dragged thread takes and splits the pane where it drops", async () => {
  using _environment = await splitTestEnvironment();
  useSplitViewStore.setState({ groups: [sideBySide] });
  await using screen = await render(layout(sideBySide, {}), { container: sizedContainer() });
  await expect.element(screen.getByText(`inactive ready ${key("B")} controls`)).toBeInTheDocument();

  // Near the bottom edge of pane B, which spans x 400–800 and y 0–400.
  const point = { x: 600, y: 390 };
  moveSplitDrag(point, [ref("E")]);
  const preview = page.getByTestId("split-drop-preview");
  await expect.element(preview).toBeInTheDocument();
  const { left, top, width, height } = (preview.element() as HTMLElement).style;
  expect({ left, top, width, height }).toEqual({
    left: "400px",
    top: "200px",
    width: "400px",
    height: "200px",
  });

  const show = vi.fn(() => Promise.resolve());
  expect(dropSplitDrag(point, [ref("E")], show)).toBe(true);
  expect(show).toHaveBeenCalledWith(ref("E"));
  expect(useSplitViewStore.getState().groups).toEqual([
    {
      type: "split",
      orientation: "horizontal",
      children: [
        pane("A"),
        { type: "split", orientation: "vertical", children: [pane("B"), pane("E")] },
      ],
    },
  ]);
  await expect.element(preview).not.toBeInTheDocument();
});

it("shows the dragged thread before dissolving the group its drop empties", async () => {
  using _environment = await splitTestEnvironment();
  useSplitViewStore.setState({ groups: [sideBySide] });
  await using screen = await render(layout(sideBySide, {}), { container: sizedContainer() });
  await expect.element(screen.getByText(`inactive ready ${key("B")} controls`)).toBeInTheDocument();
  let groupsWhenShown: unknown = null;
  const show = vi.fn(() => {
    groupsWhenShown = useSplitViewStore.getState().groups;
    return Promise.resolve();
  });
  // B dropped on the centre of pane A, which spans x 0–400.
  expect(dropSplitDrag({ x: 200, y: 200 }, [ref("B")], show)).toBe(true);
  expect(groupsWhenShown).toEqual([sideBySide]);
  await vi.waitFor(() => expect(useSplitViewStore.getState().groups).toEqual([]));
  expect(useSplitViewStore.getState().replacement).toBeNull();
});

it("leaves a multi-thread drag to the composer", async () => {
  using _environment = await splitTestEnvironment();
  await using screen = await render(layout(sideBySide, {}), { container: sizedContainer() });
  await expect.element(screen.getByText(`inactive ready ${key("B")} controls`)).toBeInTheDocument();
  const show = vi.fn(() => Promise.resolve());
  expect(dropSplitDrag({ x: 600, y: 390 }, [ref("E"), ref("F")], show)).toBe(false);
  expect(show).not.toHaveBeenCalled();
  expect(useSplitViewStore.getState().groups).toEqual([]);
});

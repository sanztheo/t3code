import "~/index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { WorkspaceTitlebarControls } from "./PanelLayoutControls";

function controls(placement: "window" | "pane") {
  return (
    <WorkspaceTitlebarControls
      placement={placement}
      showMaximizeControl={false}
      rightPanelOpen={false}
      animationsActive={false}
      maximized={false}
      maximizeShortcutLabel={null}
      onToggleMaximized={() => {}}
    >
      <button type="button">Close pane</button>
    </WorkspaceTitlebarControls>
  );
}

/** A pane in the window's bottom-left quarter of a 1000×600 viewport. */
function bottomLeftPane() {
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:0;top:300px;width:500px;height:300px";
  return container;
}

it("keeps a split pane's controls in that pane's own top-right corner", async () => {
  await page.viewport(1000, 600);
  await using screen = await render(controls("pane"), { container: bottomLeftPane() });
  const rect = screen.getByRole("button", { name: "Close pane" }).element().getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(300);
  expect(rect.right).toBeLessThanOrEqual(500);
  expect(rect.right).toBeGreaterThan(450);
});

it("keeps a lone chat's controls in the window's top-right corner", async () => {
  await page.viewport(1000, 600);
  await using screen = await render(controls("window"), { container: bottomLeftPane() });
  const rect = screen.getByRole("button", { name: "Close pane" }).element().getBoundingClientRect();
  expect(rect.top).toBeLessThan(300);
  expect(rect.right).toBeGreaterThan(950);
});

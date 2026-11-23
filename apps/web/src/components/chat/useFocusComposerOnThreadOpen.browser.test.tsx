import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SPLIT_GROUP_PANE_ATTRIBUTE } from "../splitView/splitDrag";
import { useFocusComposerOnThreadOpen } from "./useFocusComposerOnThreadOpen";

function ThreadEntry(props: { threadId: string; focusComposer: () => void; pressed: boolean }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [threadRef] = useState(() =>
    scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make(props.threadId)),
  );
  useFocusComposerOnThreadOpen(threadRef, root, true, false, props.focusComposer);
  return (
    <section {...{ [SPLIT_GROUP_PANE_ATTRIBUTE]: "" }}>
      <div ref={setRoot}>
        {/* Stands in for a field in the pane's right panel that the press focused. */}
        <input
          aria-label="Panel field"
          ref={(input) => {
            if (props.pressed) input?.focus();
          }}
        />
      </div>
    </section>
  );
}

/** Runs the frame the hook waits for at once, so the assertions follow the render directly. */
const immediateFrames = () =>
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(performance.now());
    return 0;
  });

it("leaves the focus where a press inside a split pane put it when that pane becomes active", async () => {
  using _frames = immediateFrames();
  const focusComposer = vi.fn();
  await using _screen = await render(
    <ThreadEntry threadId="pressed" focusComposer={focusComposer} pressed />,
  );
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Panel field");
  expect(focusComposer).not.toHaveBeenCalled();
});

it("still focuses the composer of a split pane entered from elsewhere", async () => {
  using _frames = immediateFrames();
  const focusComposer = vi.fn();
  await using _screen = await render(
    <ThreadEntry threadId="entered" focusComposer={focusComposer} pressed={false} />,
  );
  expect(focusComposer).toHaveBeenCalledOnce();
});

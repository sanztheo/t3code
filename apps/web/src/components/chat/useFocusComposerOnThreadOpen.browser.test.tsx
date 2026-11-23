import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { registerTerminalFocusTarget } from "../../lib/terminalFocus";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { SPLIT_GROUP_PANE_ATTRIBUTE } from "../splitView/splitDrag";
import { useFocusComposerOnThreadOpen } from "./useFocusComposerOnThreadOpen";

function ThreadProbe(props: { threadId: string }) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useFocusComposerOnThreadOpen(
    scopeThreadRef(EnvironmentId.make("rename"), ThreadId.make(props.threadId)),
    root,
    true,
    false,
    () => composerRef.current?.focus(),
  );
  return (
    <div ref={setRoot}>
      <div data-sidebar-row="thread:beta">
        <input aria-label="Thread title" />
      </div>
      <textarea aria-label="Message" ref={composerRef} />
    </div>
  );
}

// regression: #27195 double-clicking another thread's row lost its rename field to the composer
it("keeps the sidebar rename input when a double-click opens another thread", async () => {
  // The first render schedules the frame.
  using _frames = fakeTimers();
  await using screen = await render(<ThreadProbe threadId="alpha" />, {
    // A bare hook probe; nothing here navigates.
    router: false,
  });
  await act(() => vi.advanceTimersToNextFrame());
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();

  const renameInput = screen.getByRole("textbox", { name: "Thread title" });
  renameInput.element().focus();
  await screen.rerender(<ThreadProbe threadId="beta" />);
  await act(() => vi.advanceTimersToNextFrame());
  await expect.element(renameInput).toHaveFocus();
});

const paneThreadRef = (threadId: string) =>
  scopeThreadRef(EnvironmentId.make("split"), ThreadId.make(threadId));

/** A split pane's chat: `enabled` is whether it is the active pane. */
function SplitPaneEntry(props: {
  threadId: string;
  enabled: boolean;
  terminalOpen: boolean;
  focusComposer: () => void;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [threadRef] = useState(() => paneThreadRef(props.threadId));
  useFocusComposerOnThreadOpen(
    threadRef,
    root,
    props.enabled,
    props.terminalOpen,
    props.focusComposer,
  );
  return (
    <section {...{ [SPLIT_GROUP_PANE_ATTRIBUTE]: "" }}>
      <div ref={setRoot}>
        {/* Stands in for a field in the pane's right panel that a press focused. */}
        <input aria-label="Panel field" />
        <button type="button">Toggle terminal</button>
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
  const pane = (enabled: boolean) => (
    <SplitPaneEntry
      threadId="pressed"
      enabled={enabled}
      terminalOpen={false}
      focusComposer={focusComposer}
    />
  );
  await using screen = await render(pane(false));
  const field = screen.getByRole("textbox", { name: "Panel field" });
  field.element().focus();
  await screen.rerender(pane(true));
  await expect.element(field).toHaveFocus();
  expect(focusComposer).not.toHaveBeenCalled();
});

it("keeps the press's focus out of the terminal that pane last focused", async () => {
  using _frames = immediateFrames();
  const threadRef = paneThreadRef("terminal");
  const { ensureTerminal, removeTerminalUiState } = useTerminalUiStateStore.getState();
  ensureTerminal(threadRef, "drawer", { open: true, active: true });
  const focusTerminal = vi.fn(() => true);
  const unregister = registerTerminalFocusTarget({
    threadRef,
    terminalId: "drawer",
    focus: focusTerminal,
  });
  using _cleanup = {
    [Symbol.dispose]() {
      unregister();
      removeTerminalUiState(threadRef);
    },
  };
  const pane = (enabled: boolean) => (
    <SplitPaneEntry threadId="terminal" enabled={enabled} terminalOpen focusComposer={vi.fn()} />
  );
  await using screen = await render(pane(false));
  const field = screen.getByRole("textbox", { name: "Panel field" });
  field.element().focus();
  await screen.rerender(pane(true));
  await expect.element(field).toHaveFocus();
  expect(focusTerminal).not.toHaveBeenCalled();
});

it("still focuses the composer of a split pane entered from elsewhere", async () => {
  using _frames = immediateFrames();
  const focusComposer = vi.fn();
  const pane = (enabled: boolean) => (
    <SplitPaneEntry
      threadId="entered"
      enabled={enabled}
      terminalOpen={false}
      focusComposer={focusComposer}
    />
  );
  await using screen = await render(pane(false));
  await screen.rerender(pane(true));
  expect(focusComposer).toHaveBeenCalledOnce();
});

it("gives the composer the focus back when the active pane's drawer closes from its toggle", async () => {
  using _frames = immediateFrames();
  const focusComposer = vi.fn();
  const pane = (terminalOpen: boolean) => (
    <SplitPaneEntry
      threadId="drawer"
      enabled
      terminalOpen={terminalOpen}
      focusComposer={focusComposer}
    />
  );
  await using screen = await render(pane(true));
  focusComposer.mockClear();
  screen.getByRole("button", { name: "Toggle terminal" }).element().focus();
  await screen.rerender(pane(false));
  expect(focusComposer).toHaveBeenCalledOnce();
});

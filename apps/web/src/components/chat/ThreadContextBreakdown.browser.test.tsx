import {
  EnvironmentId,
  ThreadContextBreakdownError,
  ThreadId,
  type ThreadContextBreakdown,
} from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

const state = vi.hoisted(() => ({
  result: null as unknown,
  revisions: [] as string[],
}));

vi.mock(import("~/state/threadContext"), () => ({
  threadContextEnvironment: {
    breakdownQuery: ((target: { input: { revision: string } }) => {
      state.revisions.push(target.input.revision);
      return Atom.make(state.result as never);
    }) as never,
  },
}));

import { render } from "../../../test/render";
import { ThreadContextBreakdownList } from "./ThreadContextBreakdown";
import { ThreadDetailsContext } from "./ThreadDetailsUsage";

const fixture: ThreadContextBreakdown = {
  model: "claude-opus-5-5",
  totalTokens: 155_400,
  maxTokens: 200_000,
  categories: [
    { id: "messages", name: "Messages", tokens: 155_400, kind: "used" },
    { id: "mcp_tools", name: "MCP tools", tokens: 150, kind: "used" },
    { id: "mcp_tools_deferred", name: "MCP tools (deferred)", tokens: 89_300, kind: "deferred" },
  ],
  details: [
    { categoryId: "mcp_tools", rows: [{ label: "linear", tokens: 150, note: "2 tools" }] },
  ],
};

function usage(updatedAt: string): ContextWindowSnapshot {
  return {
    usedTokens: 155_400,
    maxTokens: 200_000,
    usedPercentage: 77.7,
    updatedAt,
  } as ContextWindowSnapshot;
}

const distinctRevisions = () => new Set(state.revisions).size;

it("lists categories with tokens and share of the window", async () => {
  await using screen = await render(<ThreadContextBreakdownList breakdown={fixture} />);
  await expect.element(screen.getByText("155k")).toBeInTheDocument();
  await expect.element(screen.getByText("77.7%")).toBeInTheDocument();
  const deferred = screen.getByText("44.7%");
  await expect.element(deferred).toBeInTheDocument();
  expect(deferred.element().closest("[data-kind]")?.getAttribute("data-kind")).toBe("deferred");
  expect(deferred.element().closest("[data-kind]")?.className).toContain("text-muted-foreground");
});

it("unfolds MCP tools into servers", async () => {
  await using screen = await render(<ThreadContextBreakdownList breakdown={fixture} />);
  expect(screen.getByText("linear").query()).toBeNull();
  await screen.getByRole("button", { name: "MCP tools", exact: true }).click();
  await expect.element(screen.getByText("linear")).toBeInTheDocument();
  await expect.element(screen.getByText("2 tools")).toBeInTheDocument();
});

it("clamps the bar when over the limit", async () => {
  await using screen = await render(
    <ThreadContextBreakdownList
      breakdown={{
        ...fixture,
        totalTokens: 210_000,
        categories: [
          { id: "messages", name: "Messages", tokens: 160_000, kind: "used" },
          { id: "system_tools", name: "System tools", tokens: 50_000, kind: "used" },
        ],
      }}
    />,
  );
  const widths = [...screen.container.querySelectorAll<HTMLElement>("[data-segment]")].map(
    (segment) => Number.parseFloat(segment.style.width),
  );
  expect(widths).toHaveLength(2);
  expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100);
});

it("asks nothing while folded and once per revision while open", async () => {
  state.revisions = [];
  state.result = AsyncResult.success(fixture);
  const target = { environmentId, threadId };
  await using screen = await render(
    <ThreadDetailsContext usage={usage("2026-11-23T00:00:00.000Z")} breakdownTarget={target} />,
  );
  expect(distinctRevisions()).toBe(0);
  await screen.getByRole("button", { name: "Context breakdown" }).click();
  await expect.element(screen.getByText("77.7%")).toBeInTheDocument();
  expect(distinctRevisions()).toBe(1);
  await screen.rerender(
    <ThreadDetailsContext usage={usage("2026-11-23T00:00:00.000Z")} breakdownTarget={target} />,
  );
  expect(distinctRevisions()).toBe(1);
  await screen.rerender(
    <ThreadDetailsContext usage={usage("2026-11-23T00:01:00.000Z")} breakdownTarget={target} />,
  );
  expect(distinctRevisions()).toBe(2);
});

it("tells to send a message when the session is gone", async () => {
  state.result = AsyncResult.failure(
    Cause.fail(new ThreadContextBreakdownError({ threadId, reason: "session-stopped" })),
  );
  await using screen = await render(
    <ThreadDetailsContext
      usage={usage("2026-11-23T00:00:00.000Z")}
      breakdownTarget={{ environmentId, threadId }}
    />,
  );
  await screen.getByRole("button", { name: "Context breakdown" }).click();
  await expect.element(screen.getByText("Send a message to see the breakdown")).toBeInTheDocument();
});

it("shows no chevron without a target", async () => {
  await using screen = await render(
    <ThreadDetailsContext usage={usage("2026-11-23T00:00:00.000Z")} />,
  );
  expect(screen.getByRole("button", { name: "Context breakdown" }).query()).toBeNull();
});

import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SortableThreadRow, type SidebarProviderEntry } from "./SidebarThreadRow";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("claudeAgent");
const projectDisplayName = "GetSolva";
const parentId = ThreadId.make("parent");
const childStartedAt = "2026-01-01T00:00:00.000Z";

const claudeEntry: SidebarProviderEntry = {
  instanceId,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  displayName: "Claude",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
  ],
};

// A running subagent, like the ones nested under a parent.
function runningSubagent(title: string) {
  const runId = RunId.make("run-child");
  const startedAt = childStartedAt;
  return makeThreadFixture({
    environmentId,
    id: ThreadId.make("child"),
    projectId: ProjectId.make("getsolva"),
    title,
    branch: "voice-urgence",
    modelSelection: { instanceId, model: "claude-opus-5-5" },
    lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "subagent" },
    latestRun: {
      runId,
      status: "running",
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: null,
    },
    runtime: {
      status: "running",
      activeRunId: runId,
      activityStartedAt: startedAt,
      providerInstanceId: instanceId,
      providerName: null,
      lastError: null,
      updatedAt: startedAt,
    },
  });
}

type RowProps = ComponentProps<typeof SortableThreadRow>;

function rowProps(overrides: Partial<RowProps>): RowProps {
  const thread = overrides.thread ?? runningSubagent("Agent voix : urgence transmise");
  return {
    sortableId: `${thread.environmentId}:${thread.id}`,
    sortableDisabled: true,
    contextDrag: false,
    thread,
    variant: "child",
    variantAction: "settle",
    settlementSupported: false,
    snoozeSupported: false,
    pinningSupported: false,
    isPinned: false,
    dropVerb: null,
    dragOverPinned: false,
    sweepAction: null,
    snoozeWakeLabelText: null,
    wokeAt: null,
    isActive: false,
    isRouteThread: false,
    readOpensPullRequestsInRightPanel: () => false,
    jumpLabel: null,
    currentEnvironmentId: environmentId,
    environmentLabel: null,
    environmentMachine: "server",
    scratchMachineLabel: null,
    project: null,
    projectDisplayName,
    providerEntryByInstanceId: new Map([[instanceId, claudeEntry]]),
    timestampFormat: "locale",
    onThreadClick: vi.fn(),
    onThreadActivate: vi.fn(),
    onStartRename: vi.fn(),
    onRenameTitleChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: vi.fn(),
    onSettle: vi.fn(),
    onActionSweepStart: vi.fn(),
    onUnsettle: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onUnpin: vi.fn(),
    onAcknowledgeWoke: vi.fn(),
    ...overrides,
  };
}

function renderRow(overrides: Partial<RowProps> = {}) {
  return render(
    <ul>
      <SortableThreadRow {...rowProps(overrides)} />
    </ul>,
  );
}

describe("sidebar child row", () => {
  it("child row shows title, status, model and provider but no project", async () => {
    using _timers = fakeTimers();
    vi.setSystemTime(Date.parse(childStartedAt) + 125_000);
    await using screen = await renderRow();

    // Assert synchronously: expect.element polls on the timers this test fakes.
    expect(screen.getByText("Agent voix : urgence transmise").element()).toBeVisible();
    expect(screen.getByText("Opus 5.5").element()).toBeVisible();
    // The status slot keeps the card's elapsed time.
    expect(screen.getByText("Working", { exact: false }).element().textContent).toBe("Working2m");
    expect(screen.getByText(projectDisplayName).query()).toBeNull();
  });

  it.each(["settle", "unsettle"] as const)(
    "child row offers no lifecycle actions on hover (%s section)",
    async (variantAction) => {
      const onStartRename = vi.fn();
      // Even an environment that supports every lifecycle gets none on a child.
      await using screen = await renderRow({
        variantAction,
        settlementSupported: true,
        snoozeSupported: true,
        pinningSupported: true,
        isPinned: true,
        onStartRename,
      });
      const title = screen.getByText("Agent voix : urgence transmise");
      await userEvent.hover(title);

      for (const name of ["Settle thread", "Snooze thread", "Un-settle thread", "Unpin thread"]) {
        expect(screen.getByRole("button", { name }).query(), name).toBeNull();
      }
      await expect.element(screen.getByText("Working", { exact: false })).toBeVisible();
      await userEvent.dblClick(title);
      expect(onStartRename).not.toHaveBeenCalled();
    },
  );

  it("card row shows the model label", async () => {
    await using screen = await renderRow({ variant: "card" });

    await expect.element(screen.getByText("Opus 5.5")).toBeVisible();
    await expect.element(screen.getByText(projectDisplayName)).toBeVisible();
  });

  it("last child draws a rounded connector", async () => {
    await using screen = await renderRow({
      childConnector: { depth: 1, isLast: true, lineContinues: [] },
    });

    const connector = screen.container.querySelector("[data-connector]");
    expect(connector?.getAttribute("data-connector")).toBe("last");
  });

  it("middle child draws a straight connector and its ancestors' lines", async () => {
    await using screen = await renderRow({
      childConnector: { depth: 3, isLast: false, lineContinues: [true, false] },
    });

    expect(screen.container.querySelector("[data-connector]")?.getAttribute("data-connector")).toBe(
      "mid",
    );
    expect(screen.container.querySelectorAll("[data-connector-ancestor]")).toHaveLength(1);
  });
});

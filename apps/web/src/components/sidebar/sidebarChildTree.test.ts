import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { buildSidebarChildTree, type SidebarChildNode } from "./sidebarChildTree";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeShell(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly parent?: string;
    readonly status?: "running" | "completed";
    readonly createdAt?: string;
    readonly archivedAt?: string;
    readonly delegatedFrom?: { readonly environmentId: EnvironmentId; readonly threadId: string };
  } = {},
): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return makeThreadFixture({
    environmentId: options.environmentId ?? environmentA,
    id: threadId,
    createdAt: options.createdAt ?? TIMESTAMP,
    ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
    lineage: {
      rootThreadId: threadId,
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      relationshipToParent: options.parent === undefined ? null : "subagent",
    },
    ...(options.delegatedFrom === undefined
      ? {}
      : {
          delegatedFrom: {
            environmentId: options.delegatedFrom.environmentId,
            threadId: ThreadId.make(options.delegatedFrom.threadId),
            title: "Parent",
          },
        }),
    ...(options.status === undefined
      ? {}
      : {
          runtime: {
            status: options.status,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: null,
            lastError: null,
            updatedAt: TIMESTAMP,
          },
        }),
  });
}

const key = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const withoutThread = (nodes: readonly SidebarChildNode[] | undefined) =>
  nodes?.map(({ thread: _thread, ...node }) => node);

function build(
  threads: readonly EnvironmentThreadShell[],
  options: {
    readonly delegatedUnderParent?: ReadonlySet<string>;
    readonly keepVisibleKey?: string | null;
  } = {},
) {
  return buildSidebarChildTree({
    threads,
    delegatedUnderParent: options.delegatedUnderParent ?? new Set(),
    keepVisibleKey: options.keepVisibleKey ?? null,
  });
}

describe("buildSidebarChildTree", () => {
  it("nests a running subagent under its listed parent", () => {
    const parent = makeShell("parent");
    const child = makeShell("child", { parent: "parent", status: "running" });

    expect(withoutThread(build([parent, child]).get(key(parent)))).toEqual([
      { key: key(child), depth: 1, isLast: true, lineContinues: [] },
    ]);
  });

  it("hides a child once it ends", () => {
    const parent = makeShell("parent");
    const child = makeShell("child", { parent: "parent", status: "completed" });

    expect(build([parent, child]).get(key(parent))).toBeUndefined();
  });

  it("keeps a child that awaits its own background command between turns", () => {
    const parent = makeShell("parent");
    const shell = makeShell("child", { parent: "parent", status: "completed" });
    // Observed: the run ended while the child waits on its bench, so no activity run.
    const child: EnvironmentThreadShell = {
      ...shell,
      source: {
        ...shell.source,
        status: "waiting",
        activityRunStatus: null,
        pendingBackgroundTasks: [{ taskId: "bench", kind: "command", awaited: true }],
      },
    };

    expect(
      build([parent, child])
        .get(key(parent))
        ?.map((node) => node.key),
    ).toEqual([key(child)]);
  });

  it("keeps the route child after it ends", () => {
    const parent = makeShell("parent");
    const child = makeShell("child", { parent: "parent", status: "completed" });

    expect(
      build([parent, child], { keepVisibleKey: key(child) })
        .get(key(parent))
        ?.map((node) => node.key),
    ).toEqual([key(child)]);
  });

  it("keeps an ended child while its own child is live", () => {
    const parent = makeShell("parent");
    const child = makeShell("child", { parent: "parent", status: "completed" });
    const grandchild = makeShell("grandchild", { parent: "child", status: "running" });

    expect(withoutThread(build([parent, child, grandchild]).get(key(parent)))).toEqual([
      { key: key(child), depth: 1, isLast: true, lineContinues: [] },
      { key: key(grandchild), depth: 2, isLast: true, lineContinues: [false] },
    ]);
  });

  it("caps display depth at 3", () => {
    const parent = makeShell("level-0");
    const chain = [1, 2, 3, 4].map((level) =>
      makeShell(`level-${level}`, { parent: `level-${level - 1}`, status: "running" }),
    );

    expect(
      build([parent, ...chain])
        .get(key(parent))
        ?.map((node) => node.depth),
    ).toEqual([1, 2, 3, 3]);
  });

  it("continues an ancestor's line through rows above its later sibling", () => {
    const parent = makeShell("parent");
    const first = makeShell("first", {
      parent: "parent",
      status: "running",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const nested = makeShell("nested", { parent: "first", status: "running" });
    const second = makeShell("second", {
      parent: "parent",
      status: "running",
      createdAt: "2026-01-01T00:02:00.000Z",
    });

    expect(withoutThread(build([parent, first, nested, second]).get(key(parent)))).toEqual([
      { key: key(first), depth: 1, isLast: false, lineContinues: [] },
      { key: key(nested), depth: 2, isLast: true, lineContinues: [true] },
      { key: key(second), depth: 1, isLast: true, lineContinues: [] },
    ]);
  });

  it("orders children by createdAt", () => {
    const parent = makeShell("parent");
    const minutes = [7, 2, 11, 0, 5, 9, 1, 10, 3, 8, 4, 6];
    const children = minutes.map((minute) =>
      makeShell(`child-${minute}`, {
        parent: "parent",
        status: "running",
        createdAt: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
      }),
    );

    const nodes = build([parent, ...children]).get(key(parent)) ?? [];

    expect(nodes.map((node) => node.key)).toEqual(
      [...minutes]
        .sort((left, right) => left - right)
        .map((minute) =>
          scopedThreadKey(scopeThreadRef(environmentA, ThreadId.make(`child-${minute}`))),
        ),
    );
    expect(nodes.map((node) => node.isLast)).toEqual(minutes.map((_, index) => index === 11));
  });

  it("nests a delegated task under its parent in another environment", () => {
    const parent = makeShell("parent", { environmentId: environmentA });
    const task = makeShell("task", {
      environmentId: environmentB,
      status: "running",
      delegatedFrom: { environmentId: environmentA, threadId: "parent" },
    });
    // delegatedUnderParent is keyed like the client-runtime atom that builds it.
    const delegatedUnderParent = new Set([
      threadKey({ environmentId: task.environmentId, threadId: task.id }),
    ]);

    expect(
      build([parent, task], { delegatedUnderParent })
        .get(key(parent))
        ?.map((node) => node.key),
    ).toEqual([key(task)]);
  });

  it("drops children whose parent is not listed", () => {
    const parent = makeShell("parent", { archivedAt: TIMESTAMP });
    const child = makeShell("child", { parent: "parent", status: "running" });

    const tree = build([parent, child]);

    expect([...tree.values()].flat().map((node) => node.key)).not.toContain(key(child));
  });

  it("survives a parent cycle", () => {
    const listed = makeShell("listed");
    const first = makeShell("first", { parent: "second", status: "running" });
    const second = makeShell("second", { parent: "first", status: "running" });

    const tree = build([listed, first, second]);

    expect([...tree.values()].flat()).toEqual([]);
  });
});

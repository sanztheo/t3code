import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import { claudeContextBreakdown } from "./ClaudeContextBreakdown.ts";

type Category = SDKControlGetContextUsageResponse["categories"][number];

function category(
  id: Category["id"],
  tokens: number,
  kind: Category["kind"] = "used",
): Category {
  return { id, name: id ?? "Unnamed", tokens, color: "promptBorder", kind };
}

function response(
  overrides: Partial<SDKControlGetContextUsageResponse> = {},
): SDKControlGetContextUsageResponse {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 0,
    gridRows: [],
    model: "claude-opus-5-5",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...overrides,
  };
}

const emptyMessages = {
  toolCallTokens: 0,
  toolResultTokens: 0,
  attachmentTokens: 0,
  assistantMessageTokens: 0,
  userMessageTokens: 0,
  redirectedContextTokens: 0,
  unattributedTokens: 0,
  toolCallsByType: [],
  attachmentsByType: [],
};

describe("claudeContextBreakdown", () => {
  it("keeps free space and drops empty categories", () => {
    const breakdown = claudeContextBreakdown(
      response({
        categories: [
          category("messages", 155_400),
          category("skills", 0),
          category("free_space", 0, "free"),
        ],
      }),
    );
    expect(breakdown.categories.map((row) => row.id)).toEqual(["messages", "free_space"]);
  });

  it("groups MCP tools by server, loaded apart from deferred", () => {
    const breakdown = claudeContextBreakdown(
      response({
        mcpTools: [
          { name: "a", serverName: "linear", tokens: 100 },
          { name: "b", serverName: "linear", tokens: 50 },
          { name: "c", serverName: "notion", tokens: 30, isLoaded: false },
        ],
      }),
    );
    const rows = (categoryId: string) =>
      breakdown.details.find((group) => group.categoryId === categoryId)?.rows;
    expect(rows("mcp_tools")).toEqual([{ label: "linear", tokens: 150, note: "2 tools" }]);
    expect(rows("mcp_tools_deferred")).toEqual([{ label: "notion", tokens: 30, note: "1 tools" }]);
  });

  it("lists message parts, largest first", () => {
    const breakdown = claudeContextBreakdown(
      response({
        messageBreakdown: { ...emptyMessages, toolResultTokens: 900, assistantMessageTokens: 300 },
      }),
    );
    const messages = breakdown.details.find((group) => group.categoryId === "messages");
    expect(messages?.rows.map((row) => row.label)).toEqual(["Tool results", "Assistant messages"]);
  });

  it("renders categories from a CLI without category ids", () => {
    const breakdown = claudeContextBreakdown(
      response({ categories: [{ name: "Messages", tokens: 10, color: "x", kind: "used" }] }),
    );
    expect(breakdown.categories).toHaveLength(1);
    expect(breakdown.categories[0]?.id).toBeUndefined();
  });

  it("omits the threshold when auto-compact is off", () => {
    const breakdown = claudeContextBreakdown(
      response({ autoCompactThreshold: 167_000, isAutoCompactEnabled: false }),
    );
    expect(breakdown.autoCompactThreshold).toBeUndefined();
  });
});

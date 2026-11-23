import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderDriverKind,
  ThreadContextBreakdown,
  ThreadContextDetailGroup,
  ThreadContextDetailRow,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

const tokenCount = (value: number) => Math.max(0, Math.round(value));

function group(
  categoryId: string,
  rows: ReadonlyArray<ThreadContextDetailRow>,
): ThreadContextDetailGroup | null {
  const kept = rows
    .map((row) => ({ ...row, tokens: tokenCount(row.tokens) }))
    .filter((row) => row.tokens > 0)
    .toSorted((left, right) => right.tokens - left.tokens);
  return kept.length === 0 ? null : { categoryId, rows: kept };
}

function toolsByServer(
  tools: SDKControlGetContextUsageResponse["mcpTools"],
): ReadonlyArray<ThreadContextDetailRow> {
  const servers = new Map<string, { tokens: number; count: number }>();
  for (const tool of tools) {
    const server = servers.get(tool.serverName) ?? { tokens: 0, count: 0 };
    servers.set(tool.serverName, { tokens: server.tokens + tool.tokens, count: server.count + 1 });
  }
  return [...servers].map(([label, server]) => ({
    label,
    tokens: server.tokens,
    note: `${server.count} tools`,
  }));
}

function messageParts(
  parts: SDKControlGetContextUsageResponse["messageBreakdown"],
): ReadonlyArray<ThreadContextDetailRow> {
  if (parts === undefined) return [];
  return [
    { label: "Tool calls", tokens: parts.toolCallTokens },
    { label: "Tool results", tokens: parts.toolResultTokens },
    { label: "Assistant messages", tokens: parts.assistantMessageTokens },
    { label: "User messages", tokens: parts.userMessageTokens },
    { label: "Attachments", tokens: parts.attachmentTokens },
    { label: "Redirected context", tokens: parts.redirectedContextTokens },
    { label: "Unattributed", tokens: parts.unattributedTokens },
  ];
}

/** Claude's /context report as T3's provider-neutral breakdown. */
export function claudeContextBreakdown(
  response: SDKControlGetContextUsageResponse,
): ThreadContextBreakdown {
  const named = (rows: ReadonlyArray<{ name: string; tokens: number }> | undefined) =>
    (rows ?? []).map((row) => ({ label: row.name, tokens: row.tokens }));
  const details = [
    group("system_prompt", named(response.systemPromptSections)),
    group("system_tools", named(response.systemTools)),
    group(
      "system_tools_deferred",
      (response.deferredBuiltinTools ?? []).map((tool) => ({
        label: tool.name,
        tokens: tool.tokens,
        ...(tool.isLoaded ? { note: "loaded" } : {}),
      })),
    ),
    group("mcp_tools", toolsByServer(response.mcpTools.filter((tool) => tool.isLoaded !== false))),
    group(
      "mcp_tools_deferred",
      toolsByServer(response.mcpTools.filter((tool) => tool.isLoaded === false)),
    ),
    group(
      "mcp_instructions",
      (response.mcpInstructions ?? []).map((row) => ({
        label: row.serverName,
        tokens: row.tokens,
      })),
    ),
    group(
      "skills",
      (response.skills?.skillFrontmatter ?? []).map((skill) => ({
        label: skill.name,
        tokens: skill.tokens,
        note: skill.pluginName ?? skill.source,
      })),
    ),
    group(
      "memory_files",
      response.memoryFiles.map((file) => ({
        label: file.path,
        tokens: file.tokens,
        note: file.type,
      })),
    ),
    group(
      "custom_agents",
      response.agents.map((agent) => ({
        label: agent.agentType,
        tokens: agent.tokens,
        note: agent.source,
      })),
    ),
    group("messages", messageParts(response.messageBreakdown)),
  ].filter((entry): entry is ThreadContextDetailGroup => entry !== null);

  return {
    model: response.model,
    totalTokens: tokenCount(response.totalTokens),
    maxTokens: tokenCount(response.maxTokens),
    ...(response.isAutoCompactEnabled && response.autoCompactThreshold !== undefined
      ? { autoCompactThreshold: tokenCount(response.autoCompactThreshold) }
      : {}),
    categories: response.categories
      .filter((category) => category.tokens > 0 || category.id === "free_space")
      .map((category) => ({
        ...(category.id === undefined ? {} : { id: category.id }),
        name: category.name,
        tokens: tokenCount(category.tokens),
        kind: category.kind,
      })),
    details,
  };
}

/** A query from a CLI without `getContextUsage` cannot report one, like a stopped session. */
export function readClaudeContextBreakdown(
  query: {
    readonly getContextUsage?: Effect.Effect<SDKControlGetContextUsageResponse, unknown>;
  },
  driver: ProviderDriverKind,
): Effect.Effect<ThreadContextBreakdown, ProviderAdapter.ProviderAdapterV2Error> {
  if (query.getContextUsage === undefined) {
    return Effect.fail(new ProviderAdapter.ProviderAdapterSessionStoppedError({ driver }));
  }
  return query.getContextUsage.pipe(
    Effect.map(claudeContextBreakdown),
    Effect.mapError(
      (cause) =>
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "Claude context usage request failed.",
          cause,
        }),
    ),
  );
}

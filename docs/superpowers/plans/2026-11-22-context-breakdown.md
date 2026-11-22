# Context Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the thread details, the « Context 18k / 1m » row unfolds into a live breakdown of the Claude context window (Messages, System tools, System prompt, Skills, MCP tools, deferred tools, autocompact buffer, free space), each row unfolding into its detail, like Claude Code Desktop.

**Architecture:** The web asks on demand, only while the row is unfolded. A new RPC `threadContext.breakdown` reaches a small server service that finds the thread's live provider session and calls a new optional session method `readContextBreakdown`. The Claude adapter answers it with the SDK's `query.getContextUsage({ detail: "summary" })`, mapped by a pure function into a provider-neutral contract. Nothing is persisted; every new usage report from the provider re-asks.

**Tech Stack:** Effect + Effect Schema (contracts, server), `@anthropic-ai/claude-agent-sdk` 0.3.321 (locked; has `getContextUsage`, `id`/`kind` on categories, `systemPromptSections`, `messageBreakdown`), React + effect/reactivity atoms (web), Vitest unit and browser tests, Vite+ (`vp fmt`, `vp lint`).

**Spec:** Sanz's request of 2026-11-22 in this thread, with three Claude Code Desktop screenshots (« Context window 161.3k / 200.0k (81%) », rows with a color swatch, tokens and %, an expandable « MCP tools 90.8k 386 » row). Summary: « Tu peux le déplier… tu vois le contexte en détail. Bien sûr, c'est en direct. Tu peux déplier et voir le message système, et tout. » The decisions below complete it.

## Décisions

1. **Source:** `getContextUsage({ detail: "summary" })` on the live Claude query. Summary answers from the last response's usage plus local estimates, with no token-count API calls, so it can follow the conversation live at no cost. If Sanz finds the per-category numbers off, switch to `"full"` on first unfold only.
2. **Live:** while unfolded, the web re-asks whenever the thread's context snapshot `updatedAt` changes (one request per provider usage report). Folded, it asks nothing.
3. **Claude only:** other providers have no breakdown API; their row stays as today, without a chevron.
4. **No live session** (idle more than 30 min, server restart, `/clear` in flight): the unfolded panel says « Send a message to see the breakdown ». Nothing is persisted or replayed.
5. **Provider-neutral contract:** the server maps the SDK response into `ThreadContextBreakdown` (categories plus detail groups), so the web never knows the SDK's shape.
6. **Labels in English,** as the SDK names its rows and as the rest of the T3 UI is written; new UI strings go through `gt()` like their neighbors.
7. **Colors** are chosen by the web, not the SDK (its `color` values are CLI theme keys): `used` rows take a blue scale in order, `deferred`, `buffer` and `free` rows are grey. Percentages are of `maxTokens`, deferred rows included, as Desktop shows them.
8. **Fork stays out of upstream files** where it can, to keep the daily rebase clean: new code goes in new files. `getContextUsage` is declared optional on `ClaudeAgentSdkQuerySession`, so the many upstream test fakes need no change. The session lookup (about 15 lines, also inlined in `ws.ts` for `provider.uploadFeedback`) is written again in the new service rather than extracted from upstream code.

## Global Constraints

- No PR, issue or message to `pingdotgg/t3code`; work lands on `sanztheo/t3code`, branch `arbre`.
- Nothing heavy on Sanz's Mac: no `pnpm install`, no local build. Tests, typecheck, lint and format run in « Arbre CI » (`gh workflow run arbre-ci.yml --ref <branch> -f tests="<paths>"`).
- Doc comments are 4 lines at most (lint rule). Run the formatter's rules mentally: long calls go multi-line.
- Never touch `~/.t3`. Never install the app for Sanz: he updates from the app's « Updates » menu.

## Review Focus

1. **Session gone after 30 min idle or a server restart:** the unfolded panel shows the « Send a message » text, never an endless spinner. Pinned in Task 2 (service test) and Task 4 (browser test).
2. **Thread on Codex, or switched from Claude to Codex:** the service uses the *active* provider thread and answers `provider-unsupported`; the web shows no chevron. Pinned in Task 2 and Task 4.
3. **A turn streaming while unfolded:** many usage reports arrive; at most one request per `updatedAt`, none while folded. Pinned in Task 4.
4. **Older CLI without `id` on categories:** categories still render; detail groups simply don't attach. Pinned in Task 1.
5. **Over the limit** (`totalTokens > maxTokens`, percentage above 100): the bar is clamped to 100 %, rows still read correctly. Pinned in Task 4.

---

### Task 1: Contract and Claude mapping

**Files:**
- Create: `packages/contracts/src/threadContext.ts`
- Modify: `packages/contracts/src/index.ts` (export it, like its neighbors)
- Create: `apps/server/src/provider/ClaudeContextBreakdown.ts`
- Test: `apps/server/src/provider/ClaudeContextBreakdown.test.ts`

**Interfaces:**
- Produces, in `threadContext.ts`:
  - `ThreadContextCategoryKind = Schema.Literals(["used", "free", "buffer", "deferred"])`
  - `ThreadContextCategory = Struct({ id: optional(String), name: String, tokens: NonNegativeInt, kind: ThreadContextCategoryKind })`
  - `ThreadContextDetailRow = Struct({ label: String, tokens: NonNegativeInt, note: optional(String) })`
  - `ThreadContextDetailGroup = Struct({ categoryId: String, rows: Array(ThreadContextDetailRow) })`
  - `ThreadContextBreakdown = Struct({ model: String, totalTokens: NonNegativeInt, maxTokens: NonNegativeInt, autoCompactThreshold: optional(NonNegativeInt), categories: Array(ThreadContextCategory), details: Array(ThreadContextDetailGroup) })`
  - `ThreadContextBreakdownInput = Struct({ threadId: ThreadId, revision: String })`. `revision` is a cache key only (the snapshot's `updatedAt`); the server ignores it.
  - `ThreadContextBreakdownError`, a `Schema.TaggedError` with `threadId`, `reason: Literals(["provider-unsupported", "session-stopped", "request-failed"])`, optional `cause: Schema.Defect()`, and a `message` getter per reason, shaped like `McpAppRequestError` in `packages/contracts/src/mcpApps.ts:69`.
- Produces, in `ClaudeContextBreakdown.ts`: `claudeContextBreakdown(response: SDKControlGetContextUsageResponse): ThreadContextBreakdown`.

Mapping rules (the part the types do not fix):
- **Categories:**
  - Keep the SDK's order.
  - Drop rows with 0 tokens, except `free_space`.
  - Copy `id`, `name`, `tokens` (rounded) and `kind`.
- **Detail groups,** one per source list that has a nonzero row. Rows are sorted by tokens, largest first; zero rows are dropped.

| `categoryId` | Source | Row label | Row note |
|---|---|---|---|
| `system_prompt` | `systemPromptSections` | name | none |
| `system_tools` | `systemTools` | name | none |
| `system_tools_deferred` | `deferredBuiltinTools` | name | `"loaded"` when `isLoaded` |
| `mcp_tools` | `mcpTools` where `isLoaded !== false`, one row per server | `serverName`, summed tokens | `"<n> tools"` |
| `mcp_tools_deferred` | `mcpTools` where `isLoaded === false`, one row per server | `serverName`, summed tokens | `"<n> tools"` |
| `mcp_instructions` | `mcpInstructions` | `serverName` | none |
| `skills` | `skills.skillFrontmatter` | name | `pluginName ?? source` |
| `memory_files` | `memoryFiles` | path | type |
| `custom_agents` | `agents` | `agentType` | source |
| `messages` | `messageBreakdown` | see below | none |

  For `messages`, one row per nonzero field: `"Tool calls"`, `"Tool results"`, `"Assistant messages"`, `"User messages"`, `"Attachments"`, `"Redirected context"`, `"Unattributed"`.
- **Totals:** `autoCompactThreshold` is copied only when `isAutoCompactEnabled`. `maxTokens` comes from the response's `maxTokens`.

- [ ] **Step 1: Write the failing tests** in `ClaudeContextBreakdown.test.ts`, each building a minimal response object:
  - `"keeps free space and drops empty categories"`: categories `messages` 155400, `skills` 0, `free_space` 0. Expect ids `["messages", "free_space"]`.
  - `"groups MCP tools by server, loaded apart from deferred"`: tools `a`/`linear` 100, `b`/`linear` 50, `c`/`notion` 30 with `isLoaded: false`. Expect `mcp_tools` rows `[{ label: "linear", tokens: 150, note: "2 tools" }]` and `mcp_tools_deferred` rows `[{ label: "notion", tokens: 30, note: "1 tools" }]`.
  - `"lists message parts, largest first"`: `toolResultTokens: 900`, `assistantMessageTokens: 300`, others 0. Expect labels `["Tool results", "Assistant messages"]`.
  - `"renders categories from a CLI without category ids"`: a category with no `id`. Expect it present, with `id` undefined.
  - `"omits the threshold when auto-compact is off"`: `autoCompactThreshold: 167000`, `isAutoCompactEnabled: false`. Expect `autoCompactThreshold` undefined.
- [ ] **Step 2: Run them on CI and see them fail.** Push the branch `context-breakdown`, then run `gh workflow run arbre-ci.yml -R sanztheo/t3code --ref context-breakdown -f tests="apps/server/src/provider/ClaudeContextBreakdown.test.ts" -f checks=false`. Expected: FAIL, module not found.
- [ ] **Step 3: Write the schemas and `claudeContextBreakdown`** per the rules above. Import the SDK type with `import type`.
- [ ] **Step 4: Run the same command.** Expected: 5 passed.
- [ ] **Step 5: Commit:** `git commit -m "context: map Claude's context usage into a breakdown contract"`.

### Task 2: Session method, Claude implementation, server service and RPC

**Files:**
- Modify: `packages/provider-core/src/server/ProviderAdapter.ts:861` (one optional member)
- Modify: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`:
  - `ClaudeAgentSdkQuerySession` interface (~`:723-760`)
  - the query wrapper next to `mcpServerStatus` (~`:1958`)
  - the session runtime object, next to `mcpApps`
- Create: `apps/server/src/threadContext/ThreadContextRequests.ts`
- Modify: `packages/contracts/src/rpc.ts`: `WS_METHODS.threadContextBreakdown = "threadContext.breakdown"`, the `WsThreadContextBreakdownRpc` definition and its registration, beside `providerUploadFeedback` (`:501`, `:1763`, `:2542`)
- Modify: `apps/server/src/ws.ts`: the handler, plus the service layer where `McpAppRequests` is provided
- Test: `apps/server/src/threadContext/ThreadContextRequests.test.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.contextBreakdown.test.ts`

**Interfaces:**
- Consumes: `ThreadContextBreakdown`, `ThreadContextBreakdownInput`, `ThreadContextBreakdownError`, `claudeContextBreakdown` (Task 1).
- Produces:
  - `ProviderAdapterV2SessionRuntime.readContextBreakdown?: (input: { readonly providerThread: OrchestrationV2ProviderThread }) => Effect.Effect<ThreadContextBreakdown, ProviderAdapterV2Error>`.
  - `ClaudeAgentSdkQuerySession.getContextUsage?: Effect.Effect<SDKControlGetContextUsageResponse, ClaudeQueryRunnerError>`. It is optional (Décision 8); the wrapper calls `queryRuntime.getContextUsage({ detail: "summary" })` with `Effect.tryPromise` and `queryRunnerError(cause, "getContextUsage")`.
  - `ThreadContextRequests` service, method `breakdown(input: ThreadContextBreakdownInput): Effect.Effect<ThreadContextBreakdown, ThreadContextBreakdownError>`.
  - RPC `threadContext.breakdown`: payload `ThreadContextBreakdownInput`, success `ThreadContextBreakdown`, error `ThreadContextBreakdownError`.

Behavior:
- **Service `breakdown`:**
  1. Reads `getThreadRecords(threadId, ["providerThreads"])`.
  2. Takes the provider thread equal to `thread.activeProviderThreadId`, else the last one, like `ws.ts:2617`.
  3. Fails `session-stopped` when that thread has no `providerSessionId` or `providerSessions.get` gives `None`.
  4. Fails `provider-unsupported` when the runtime has no `readContextBreakdown`.
  5. Maps `ProviderAdapterSessionStoppedError` to `session-stopped`, and any other failure to `request-failed`.
- **Claude `readContextBreakdown`:**
  1. Gets the query with `liveQueryForThread(providerThread)` (`:8833`).
  2. Fails `ProviderAdapterSessionStoppedError` when the live query has no `getContextUsage`.
  3. Returns `claudeContextBreakdown(response)`.

- [ ] **Step 1: Write the failing service tests,** modeled on `apps/server/src/mcpApps/McpAppRequests.test.ts`:
  - `"answers session-stopped when the thread never ran"`: no provider session id.
  - `"answers session-stopped when the session was released"`: `providerSessions.get` returns `None`.
  - `"answers provider-unsupported on the active Codex thread after a Claude one"`: two provider threads, the active one's runtime has no `readContextBreakdown`.
  - `"returns the runtime's breakdown"`: a stub returning a fixed `ThreadContextBreakdown`, deep-equal.
- [ ] **Step 2: Write the failing adapter tests** with the harness used by `runClaudeMcpAppToolTurn` (`ClaudeAdapterV2.test.ts:6759`, `ClaudeAdapterV2.testkit.ts`):
  - `"reads a summary breakdown from the live query"`: a fake session whose `getContextUsage` records its call and returns a one-category response. Expect `runtime.readContextBreakdown!` to give that category.
  - `"reports a stopped session when no query is live"`: expect `ProviderAdapterSessionStoppedError`.
- [ ] **Step 3: Run them on CI** with both test paths and `checks=false`. Expected: FAIL.
- [ ] **Step 4: Implement** the interface member, the wrapper, the Claude runtime method, the service, the RPC and the `ws.ts` handler.
- [ ] **Step 5: Run them on CI** with both paths and `checks=true` (typecheck, lint and format check). Expected: all passed.
- [ ] **Step 6: Commit:** `git commit -m "context: serve the live Claude context breakdown over RPC"`.

### Task 3: Client query atom

**Files:**
- Create: `packages/client-runtime/src/state/threadContext.ts`
- Modify: `packages/client-runtime/package.json` (export `./state/thread-context`, copied from the `./state/mcp-apps` entry at `:582`)
- Create: `apps/web/src/state/threadContext.ts`, a 5-line twin of `apps/web/src/state/mcpApps.ts` exporting `threadContextEnvironment`

**Interfaces:**
- Consumes: RPC `threadContext.breakdown` (Task 2).
- Produces: `createThreadContextEnvironmentAtoms(runtime)` returning `{ breakdownQuery }`, built with `createEnvironmentRpcQueryAtomFamily(runtime, { label: "environment-data:thread-context:breakdown", tag: WS_METHODS.threadContextBreakdown, idleTtlMs: 60_000 })`. The web exposes it like `mcpApps` does, read with `useEnvironmentQuery` as in `McpAppFrame.tsx:160`.

- [ ] **Step 1: Write it, following `packages/client-runtime/src/state/mcpApps.ts`.** No test of its own: Task 4's browser test exercises it through a mocked query, as `ThreadDetailsPanel.browser.test.tsx` does.
- [ ] **Step 2: Commit:** `git commit -m "context: add the breakdown query atom"`.

### Task 4: Unfoldable context row

**Files:**
- Create: `apps/web/src/components/chat/ThreadContextBreakdown.tsx`
- Modify: `apps/web/src/components/chat/ThreadDetailsUsage.tsx:109-173` (`ThreadDetailsContext`)
- Modify: `apps/web/src/components/chat/ThreadDetailsPanel.tsx:327` (pass the target)
- Test: `apps/web/src/components/chat/ThreadContextBreakdown.browser.test.tsx`

**Interfaces:**
- Consumes: `breakdownQuery` (Task 3), `ThreadContextBreakdown` (Task 1), `ContextWindowSnapshot`.
- Produces:
  - `ThreadContextBreakdownList({ breakdown }: { readonly breakdown: ThreadContextBreakdown })`, purely presentational.
  - `ThreadContextBreakdownPanel({ target, revision }: { readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }; readonly revision: string })`. It owns the query and its states.
  - `ThreadDetailsContext` gains an optional prop `breakdownTarget?: { environmentId: EnvironmentId; threadId: ThreadId }`. `ThreadDetailsPanel` passes it only when the active thread's provider driver is `"claudeAgent"`.

UI:
- **Context row:** with `breakdownTarget`, the row gets a chevron button (`aria-expanded`, label « Context breakdown »). The `ui/collapsible.tsx` panel under it mounts `ThreadContextBreakdownPanel` only while open, with `revision = usage.updatedAt`.
- **List:**
  - A stacked bar of the `used` categories. Total width is clamped to 100 %; it keeps the existing threshold tick.
  - One row per category: swatch, name, tokens via `formatContextWindowTokens`, and percentage of `maxTokens` with one decimal.
  - A category with a detail group gets its own chevron. Its rows show label, note (muted) and tokens.
  - Grey swatches and muted text for `deferred`, `buffer` and `free` (Décision 7).
- **States:**
  - First load: « Loading… ».
  - `session-stopped`: « Send a message to see the breakdown ».
  - `request-failed`: « Couldn't load the breakdown », keeping the previous data if any.

- [ ] **Step 1: Write the failing browser tests** with vite-plus `render`, mocking the query as `ThreadDetailsPanel.browser.test.tsx` mocks entities:
  - `"lists categories with tokens and share of the window"`: fixture with `maxTokens: 200000`, `messages` 155400 used, `mcp_tools_deferred` 89300 deferred. Expect text `155.4k` and `77.7%`, and `44.7%` on the deferred row with the muted class.
  - `"unfolds MCP tools into servers"`: click the MCP tools chevron. Expect `linear` and `2 tools`.
  - `"clamps the bar when over the limit"`: `totalTokens: 210000`, `maxTokens: 200000`. Expect summed segment widths ≤ 100 %.
  - `"asks nothing while folded and once per revision while open"`: render `ThreadDetailsContext` with a target. Expect the query mock not called. Unfold: expect 1 call. Re-render with the same `updatedAt`: still 1. With a new `updatedAt`: 2.
  - `"tells to send a message when the session is gone"`: the query fails `session-stopped`. Expect the « Send a message… » text.
  - `"shows no chevron without a target"`: Codex thread. Expect no « Context breakdown » button.
- [ ] **Step 2: Run them on CI** (`tests="apps/web/src/components/chat/ThreadContextBreakdown.browser.test.tsx"`, `checks=false`). Expected: FAIL.
- [ ] **Step 3: Implement the two components and the prop.**
- [ ] **Step 4: Run all of this plan's tests on CI with `checks=true`.** Expected: all passed, plus typecheck, lint and format.
- [ ] **Step 5: Commit:** `git commit -m "context: unfold the context row into a live breakdown"`.

### Task 5: Ship to Sanz

- [ ] **Step 1:** Rebase `context-breakdown` on `origin/arbre`, fast-forward `arbre`, and push. Expected: the « Arbre CI » push run is green.
- [ ] **Step 2:** Run `gh workflow run arbre-build.yml -R sanztheo/t3code`. Expected: a new prerelease `v0.1.12-nightly.YYYYMMDD.N`, offered in the app's « Updates » menu.
- [ ] **Step 3:** Tell Sanz what to check: in a Claude thread, unfold « Context ». The rows must appear and follow a running turn. MCP tools must unfold into servers. A thread idle for 30+ minutes must show the « Send a message » text.

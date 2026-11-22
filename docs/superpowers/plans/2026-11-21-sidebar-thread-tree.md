# Arbre des conversations (T3 Code) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the T3 Code sidebar, show each running child conversation (subagent, side chat, delegated task) nested under its parent with L-shaped connectors, and ship it as Sanz's own macOS build, rebuilt from the upstream nightly every 3 hours when it changed.

**Architecture:** A pure function builds a "listed parent → live children" tree from the thread shells the sidebar already loads. `Sidebar.tsx` renders those children right after their parent row through a new `"child"` row variant, which has no lifecycle actions. A public fork `sanztheo/t3code`, branch `arbre`, carries the patch. A daily GitHub Actions workflow rebases it on upstream `main`, runs the tests, builds a self-signed arm64 DMG on a free macOS runner and publishes it as a release. Nothing is built on Sanz's Mac (16 GB free).

**Tech Stack:** TypeScript, React, Effect `Schema`, Vite+ (`vp`), Vitest unit and browser tests (Playwright), pnpm 12, electron-builder, GitHub Actions.

**Spec:** the validated mockup and answers on the whiteboard https://claude.ai/artifact/8nC4FBkefWKpsTEQ9f9WeJ, plus « Décisions » below. Upstream code was read at `pingdotgg/t3code@a9447ce`.

## Décisions (validated by Sanz on 2026-11-21, or taken by the planner within his spec)

1. **Only live children are shown.** A child shows while `isChildRunLive(child)` is true (running, starting, preparing, waiting, or a queued follow-up). Once it ends, it disappears from the list. It stays reachable from the parent's right panel, as today.
2. **Children have no lifecycle of their own.** No Settle, Snooze, Un-settle, Unsnooze, pin, drag or rename on a child row. Only the parent is settled or snoozed. Upstream already works this way: `isListedThreadLineage` keeps subagents and side chats out of every list and every settle rule (`packages/contracts/src/orchestrationV2.ts:179`, `:2457`).
3. **Child row content.** Line 1: title, then the status slot (spinner + `Working 2m` / `Waiting` / `Input` / `Approval`), never replaced on hover. Line 2: branch, +/−, PR on the left; model name and provider icon (with account badge) on the right. No project line, because it is the parent's.
4. **Model in clear on every row**, parent included: `getTriggerDisplayModelName(...)`, already computed as `modelLabel` in `SidebarThreadRow.tsx:863`, shown on line 3 just before the provider icon.
5. **Connectors.** Each child is linked to its parent by a vertical line with a horizontal stub (├). The last child gets a rounded corner (└). It is drawn with CSS borders (`border-left` + `border-top`, `border-bottom-left-radius: 8px`), not with glyphs.
6. **Nesting.** A child nests under its direct parent: `lineage.parentThreadId` in the same environment, or `delegatedFrom` for a task delegated from another environment. A live descendant of an ended child moves up to the nearest shown ancestor. Display depth is capped at 3, and deeper nodes render at depth 3.
7. **Expand/collapse.** Expanded by default. The chevron is T3's own: `ChevronDownIcon` from `lucide-react`, `size-3 shrink-0 text-sidebar-muted-foreground transition-transform`, `-rotate-90` when collapsed, exactly as in `SidebarProjectFolderHeader.tsx:105`. Never a text glyph. Collapsed parent keys persist in localStorage under `t3code:sidebar-collapsed-parents:v1`. A collapsed parent shows a chip `N enfant(s)` with a spinner when one of them is working.
8. **Works in every section.** Pinned, active, Working, Snoozed and Settled rows (card or slim variant) all show their live children.
9. **An open child stays visible.** The child the user is viewing (route thread) stays under its parent even after it ends, until the user navigates away.
10. **Out of scope.** A top-level thread created by another session with `t3_thread_launch` is not nested: nothing proves the launcher is recorded (unknown, to check separately). Also out of scope: the iPhone app, and any PR to `pingdotgg/t3code` (their CONTRIBUTING.md auto-closes outside feature PRs).
11. **Distribution, with the in-app update button kept.** The official app updates from `pingdotgg/t3code` releases, channel `nightly` (its `app-update.yml`), signed by T3's Apple team. Our build points its updater at `sanztheo/t3code` releases instead: `owner: sanztheo`, same `channel: nightly`, `releaseType: prerelease`. Otherwise the button would try to install the official version without the tree. Squirrel.Mac only updates a signed app (Electron and electron-builder docs), so every build is signed with one self-signed certificate. It is created once, and its `.p12` plus password are stored as fork secrets `CSC_LINK` / `CSC_KEY_PASSWORD`. Each build keeps the same identity, so the update check should accept the next one. That part is unproven, and Task 4 proves or disproves it. If it fails, the fallback is `scripts/arbre-install.sh` plus telling Sanz. The documented fix is then an Apple Developer ID (paid, his call). Output: arm64 `dmg` + `zip`, because `zip` is required for Squirrel.Mac.

## Global Constraints

- Upstream base: `https://github.com/pingdotgg/t3code` branch `main`. Fork: `sanztheo/t3code` (public, so Actions minutes on macOS runners are free). Patch branch: `arbre`.
- Package manager `pnpm@12.14.0`, task runner `vp` (Vite+). Never commit `node_modules` or build output.
- Keep upstream style: `gt("…")` / `msg(…)` for every user-visible string, oxlint and `vp fmt` clean.
- The patch stays small and contained so the daily rebase rarely conflicts: new logic in new files, minimal edits in `Sidebar.tsx` and `SidebarThreadRow.tsx`.
- No change to server code, contracts, or settle/snooze behavior.
- Never run the build or `pnpm install` on Sanz's Mac (16 GB free, no Codespaces access). Code is edited in a blobless clone at `/Users/sanz/Developer/t3code-arbre/t3code` (local footprint under 1 GB, no `node_modules`). Every test, typecheck and lint command in this plan runs on GitHub Actions in `.github/workflows/arbre-ci.yml`: `ubuntu-latest`, triggered by push to `arbre` and by `workflow_dispatch` with an input `tests` (space-separated test paths). It runs `pnpm install`, `pnpm exec playwright install --with-deps chromium`, then the given `pnpm vp test run …`, then `pnpm typecheck && pnpm lint && pnpm fmt:check`. Read results with `gh run watch` / `gh run view --log-failed`. Upstream workflows use Blacksmith runners that a fork cannot use: disable them on the fork (`gh workflow disable`) so they don't queue forever. The fork is public, so standard GitHub-hosted runners cost none of Sanz's Actions minutes.

## Review Focus

1. **A child ends while it is open.** It must stay under its parent until the user leaves it (Décision 9). Test in Task 1: `keeps the route child after it ends`.
2. **A parent in another environment** (task delegated from a linked machine). Keys must be scoped `environmentId:threadId`, never a bare `threadId`. Test in Task 1: `nests a delegated task under its parent in another environment`.
3. **Twelve parallel children** (one workflow run). They all render in creation order, and the collapsed chip says `12 enfants`. Test in Task 1: `orders children by createdAt` with 12 children, plus the chip assertion in Task 3.
4. **Drag, keyboard jump hints (⌘1–9) and multi-select sweep must ignore children.** `sidebarListItems` and the reorderable keys must contain parents only. Test in Task 3: `child rows are not reorderable or jump targets`.
5. **Broken lineage** (parent archived, missing, or a cycle) must not hang the tree or show orphans. Test in Task 1: `drops children whose parent is not listed` and `survives a parent cycle`.

---

### Task 1: Live child tree (pure logic)

**Files:**
- Modify: `packages/client-runtime/src/state/threadShell.ts:50` (export the existing `isChildRunLive`, no behavior change)
- Create: `apps/web/src/components/sidebar/sidebarChildTree.ts`
- Test: `apps/web/src/components/sidebar/sidebarChildTree.test.ts`

**Interfaces:**
- Consumes: `EnvironmentThreadShell`, `isShownUnderParent`, `threadKey`, now-exported `isChildRunLive` from `@t3tools/client-runtime/state/threadShell`, `scopedThreadKey`/`scopeThreadRef` as used in `Sidebar.tsx:1965`.
- Produces:
  ```ts
  export const SIDEBAR_CHILD_MAX_DEPTH = 3;
  export interface SidebarChildNode {
    readonly thread: EnvironmentThreadShell;
    readonly key: string;          // scopedThreadKey of the child
    readonly depth: 1 | 2 | 3;
    readonly isLast: boolean;      // last sibling at its depth → └
    readonly lineContinues: readonly boolean[]; // per ancestor depth: draw the vertical line through this row
  }
  export function buildSidebarChildTree(input: {
    readonly threads: readonly EnvironmentThreadShell[];
    readonly delegatedUnderParent: ReadonlySet<string>;
    readonly keepVisibleKey: string | null; // route thread key (Décision 9)
  }): ReadonlyMap<string, readonly SidebarChildNode[]>; // listed parent key → children flattened in display order
  ```

- [ ] **Step 0: Set up the fork and its CI.** Run `gh repo fork pingdotgg/t3code --clone=false`, then `git clone --filter=blob:none https://github.com/sanztheo/t3code /Users/sanz/Developer/t3code-arbre/t3code && cd $_ && git switch -c arbre`. Copy this plan to `docs/superpowers/plans/2026-11-21-sidebar-thread-tree.md`. Add `.github/workflows/arbre-ci.yml` (see Global Constraints), enable Actions on the fork, disable the upstream workflows, push, and run `gh workflow run arbre-ci.yml -f tests="apps/web/src/components/Sidebar.logic.test.ts"`. Expected: green run (proves the CI loop on an untouched upstream test).

- [ ] **Step 1: Write the failing tests** in `sidebarChildTree.test.ts`. Build shells from `apps/web/src/test-fixtures.ts` (which sets `lineage`), with `status: "running"` for live and `"completed"` for ended:
  - `nests a running subagent under its listed parent`: P listed, C `{parentThreadId: P, relationshipToParent: "subagent"}` running → `map.get(key(P))` deep-equals `[{key: key(C), depth: 1, isLast: true, lineContinues: []}]` (compare without `thread`).
  - `hides a child once it ends`: C `completed` → `map.get(key(P))` is `undefined`.
  - `keeps the route child after it ends`: same, with `keepVisibleKey: key(C)` → C present.
  - `moves a live grandchild up when its parent ended`: P → C (ended) → G (running) → G at depth 1 under P.
  - `caps display depth at 3`: a chain of 5 running levels → depths `[1, 2, 3, 3]`.
  - `orders children by createdAt`: 12 running children with shuffled `createdAt` → keys in ascending `createdAt`, only the last has `isLast: true`.
  - `nests a delegated task under its parent in another environment`: listed T in env B with `delegatedFrom: {environmentId: A, threadId: P}` and `key(T) ∈ delegatedUnderParent` → under `key(P)`.
  - `drops children whose parent is not listed`: C's parent archived → not in any entry.
  - `survives a parent cycle`: A.parent = B, B.parent = A, both running → returns without throwing, neither appears.

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vp test run apps/web/src/components/sidebar/sidebarChildTree.test.ts`. Expected: FAIL, `buildSidebarChildTree` is not exported.

- [ ] **Step 3: Implement `buildSidebarChildTree` in `sidebarChildTree.ts`.** Index the threads by `threadKey`. The listed parents are the non-archived threads where `isShownUnderParent` is false. For every non-archived thread where it is true: resolve its direct parent (Décision 6), and keep it if `isChildRunLive(thread) || key === keepVisibleKey`. Walk up through hidden (ended) ancestors to the nearest kept or listed one, with a visited set so a cycle drops the node. Emit children depth-first, siblings sorted by `createdAt`, depth `min(level, 3)`. Export `isChildRunLive` from `threadShell.ts` (add `export`, nothing else).

- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command. Expected: 9 passed. Also run `pnpm vp test run packages/client-runtime/src/state/threadShell.test.ts`. Expected: PASS, unchanged.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/client-runtime/src/state/threadShell.ts apps/web/src/components/sidebar/sidebarChildTree.ts apps/web/src/components/sidebar/sidebarChildTree.test.ts docs/superpowers/plans
  git commit -m "sidebar: build the live child tree under listed parents"
  ```

### Task 2: `"child"` row variant and model label

**Files:**
- Modify: `apps/web/src/components/sidebar/SidebarThreadRow.tsx` (variant union at `:579`, action slot at `:1461-1520` and `:1665`, line-3 metadata around `:300-380`)
- Test: `apps/web/src/components/sidebar/SidebarThreadRow.browser.test.tsx` (create; copy the render harness from `apps/web/src/components/Sidebar.browser.test.tsx`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `variant: "card" | "slim" | "folder" | "folder-multiline" | "child"` on the row props, plus a new optional prop `childConnector?: { depth: 1 | 2 | 3; isLast: boolean; lineContinues: readonly boolean[] }`. Rows with `variant: "child"` must be rendered with `settlementSupported={false}`, `snoozeSupported={false}`, `sortableDisabled`.

- [ ] **Step 1: Write the failing browser tests:**
  - `child row shows title, status, model and provider but no project`: render a running subagent shell, `variant="child"` → `getByText(title)`, `getByText("Opus 5.5")`, `getByRole("status")` contains `Working`, `queryByText(projectDisplayName)` is null.
  - `child row offers no lifecycle actions on hover`: hover → `queryByRole("button", {name: "Settle thread"})`, `"Snooze thread"`, `"Un-settle thread"` are all null.
  - `card row shows the model label`: `variant="card"` → `getByText("Opus 5.5")` on line 3.
  - `last child draws a rounded connector`: `childConnector={{depth:1,isLast:true,lineContinues:[]}}` → the connector element has `data-connector="last"`.

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vp test run --project browser apps/web/src/components/sidebar/SidebarThreadRow.browser.test.tsx`. Expected: FAIL (`"child"` is not a valid variant, the model text is missing).

- [ ] **Step 3: Implement.** Add `"child"` to the variant union. In child rows: skip the project/favicon line, keep the status slot, never render the hover action buttons, and lay out line 2 as in Décision 3. Render `modelLabel` as `text-xs text-secondary-label` before `SidebarProviderStack` on line 3 for all variants. The connector is an absolutely positioned `span[data-connector="mid"|"last"]` in the left gutter, `16px` per depth, colored `var(--sidebar-border)`, with one `border-left` per `lineContinues[i] === true`.

- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: 4 passed. Then `pnpm vp test run --project browser apps/web/src/components/Sidebar.browser.test.tsx`. Expected: PASS, the existing rows are unchanged apart from the new model text (update snapshots only for that).

- [ ] **Step 5: Commit.** `git commit -am "sidebar: child row variant without lifecycle actions, model label on rows"`

### Task 3: Render children in the sidebar, with collapse

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx` (state near the shelf `useLocalStorage` calls `:461-476`, `renderThreadRow` `:3447`, list loop `:3583`)
- Create: `apps/web/src/components/sidebar/SidebarChildToggle.tsx` (chevron + collapsed chip)
- Test: `apps/web/src/components/Sidebar.browser.test.tsx` (add cases)

**Interfaces:**
- Consumes: `buildSidebarChildTree`, `SidebarChildNode` (Task 1); `variant: "child"`, `childConnector` (Task 2).
- Produces: `SIDEBAR_COLLAPSED_PARENTS_KEY = "t3code:sidebar-collapsed-parents:v1"` (exported from `sidebarChildTree.ts`) and `SidebarChildToggle(props: { count: number; anyWorking: boolean; expanded: boolean; onToggle: () => void })`.

- [ ] **Step 1: Write the failing browser tests** in `Sidebar.browser.test.tsx`, with fixtures: parent P (active) and running subagents C1, C2.
  - `shows live children right under their parent`: row order in the list is `P, C1, C2`.
  - `collapses and remembers`: click the chevron on P → C1 and C2 are gone, chip `2 enfants` visible. Remount → still collapsed. `localStorage["t3code:sidebar-collapsed-parents:v1"]` contains `key(P)`.
  - `collapsed chip counts twelve`: 12 running children, collapsed → `12 enfants`.
  - `clicking a child opens it`: click C1 → route thread is C1.
  - `child rows are not reorderable or jump targets`: `resolveSidebarReorderableThreadKeys(...)` and the jump-hint labels contain `key(P)` and no child key.
  - `settled parent still shows its running child`: P settled with a running C1, settled shelf expanded → C1 under P.

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vp test run --project browser apps/web/src/components/Sidebar.browser.test.tsx`. Expected: the 6 new cases FAIL.

- [ ] **Step 3: Implement.**
  - Compute `childTree = buildSidebarChildTree({ threads, delegatedUnderParent, keepVisibleKey: routeThreadKey })` with `useMemo` next to the existing `filterSidebarV2VisibleThreads` call (`:635`).
  - Add `useLocalStorage(SIDEBAR_COLLAPSED_PARENTS_KEY, [], Schema.Array(Schema.String))`.
  - In the list loop, after each pushed parent row (section and folder paths alike), push its `SidebarChildNode[]` through `renderThreadRow(child.thread, section, folderRow)`, with `variant: "child"` and the connector props, unless the parent is collapsed.
  - Pass `SidebarChildToggle` into the parent row's leading slot when `childTree.get(key)` is non-empty.
  - Leave `sidebarListItems` untouched, so drag, sweep and jump hints keep seeing parents only.

- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: all pass. Then run the whole web suite: `pnpm --filter @t3tools/web test`. Expected: PASS. Then `pnpm typecheck && pnpm lint && pnpm fmt:check`. Expected: exit 0.

- [ ] **Step 5: Commit and push.** `git commit -am "sidebar: nest live child threads under their parent" && git push -u origin arbre`

### Task 4: Daily build of Sanz's app, and the install script

**Files:**
- Create: `.github/workflows/arbre-daily.yml`
- Create: `scripts/arbre-install.sh`
- Modify: the electron-builder `publish` / updater config of `apps/desktop`, to disable the auto-updater when `T3_ARBRE_BUILD=1` (find the `autoUpdater` call with `rg -n "autoUpdater" apps/desktop`)

**Interfaces:**
- Consumes: branch `arbre` from Tasks 1-3; the upstream reusable workflow `.github/workflows/release-desktop.yml` (`workflow_call`: read its `inputs:`, it already signs ad hoc when `CSC_LINK` is missing, see `:400`).
- Produces: a GitHub release on `sanztheo/t3code` tagged `arbre-YYYYMMDD` with `T3-Code-*-arm64.dmg`, and `scripts/arbre-install.sh` that installs the latest one.

- [ ] **Step 1: Write the workflow.**
  - Triggers: `schedule: cron "0 */3 * * *"` and `workflow_dispatch`. T3 publishes several nightlies a day, so the job checks every 3 hours and stops early when upstream `main` has no new commit since the last `arbre` build (compare against the SHA recorded in the last release body).
  - Job `sync`, on `ubuntu-latest`: check out `arbre` with full history, `git fetch https://github.com/pingdotgg/t3code main`, `git rebase FETCH_HEAD`. On conflict: `gh issue create --title "arbre: rebase conflict $(date +%F)"` with the conflicting files, and fail. On success: `pnpm install`, run the three test files from Tasks 1-3, `git push --force-with-lease origin arbre`.
  - Job `build`, needs `sync`: call `./.github/workflows/release-desktop.yml` with platform mac, arch arm64, runner `macos-latest`, the fork secrets `CSC_LINK` / `CSC_KEY_PASSWORD`, env `T3_ARBRE_BUILD=1`. Unproven: whether its notarization steps skip cleanly without the `APPLE_API_*` secrets. If they don't, copy only its mac build steps into `arbre-daily.yml` instead of calling it.
  - Job `release`: `gh release create arbre-$(date +%Y%m%d) <dmg>`, keeping the last 7 releases.

- [ ] **Step 2: Point the updater at the fork when `T3_ARBRE_BUILD=1`** (Décision 11): the electron-builder `publish` config becomes `{ provider: "github", owner: "sanztheo", repo: "t3code", releaseType: "prerelease", channel: "nightly" }`, and the release job uploads the `dmg`, the `zip` and `latest-mac.yml`. Create the self-signed code-signing certificate once (`openssl` + `security`, CN `T3 Code Arbre`), then `gh secret set CSC_LINK` / `CSC_KEY_PASSWORD` on the fork. The check: unzip the built app and grep `Contents/Resources/app-update.yml` for `owner: sanztheo`. Expected: found.
- [ ] **Step 2b: Prove the in-app update.** On a macOS runner (job `update-proof`, `workflow_dispatch` only): install build N, publish build N+1 as a prerelease, launch N with `ELECTRON_ENABLE_LOGGING=1`, and wait for electron-updater's `update-downloaded` log line. Expected: `update-downloaded` for N+1. If it fails, record the error in the run summary, keep `scripts/arbre-install.sh` as the update path, and report it to Sanz.

- [ ] **Step 3: Write `scripts/arbre-install.sh`.**
  - Run `gh release download --repo sanztheo/t3code --pattern '*arm64.dmg' -D "$TMPDIR/arbre"`.
  - Quit T3 Code, mount the DMG, then `ditto` the app over `/Applications/T3 Code (Nightly).app` after moving the old one to `~/.Trash`.
  - Then `xattr -dr com.apple.quarantine` on it, and delete the DMG.
  - Never touch `~/.t3` (data).

- [ ] **Step 4: Prove it.** Run `gh workflow run arbre-daily.yml --repo sanztheo/t3code`, then `gh run watch` inside the same turn. Expected: all jobs green and a release `arbre-YYYYMMDD` with a DMG under 400 MB. Report the run URL and the release URL.

- [ ] **Step 5: Commit.** `git add .github/workflows/arbre-daily.yml scripts/arbre-install.sh apps/desktop && git commit -m "arbre: rebase on upstream, self-signed arm64 build, fork updater, install script" && git push`

**Handoff to Sanz (not done by the agent):** install with `bash scripts/arbre-install.sh`. This replaces the official nightly with the arbre build, so the « Annuler » path is to reinstall the official nightly DMG (T3 Code site or GitHub releases). The first launch may need a right-click → Ouvrir, because the app is not notarized by Apple.

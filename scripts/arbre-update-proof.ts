// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Proves an installed arbre build updates itself in place: launches it, lets its own updater find,
// download and install the newest arbre release, then checks the app on disk became that release.
// The arbre daily workflow runs it on a runner that does not trust the self-signed certificate, as
// on Sanz's Mac, so Squirrel.Mac checks the update's signature the way it will there.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

const LAUNCH_TIMEOUT_MS = 60_000;
// The app checks 15 seconds after startup; a check that finds nothing is retried until this.
const FIND_TIMEOUT_MS = 5 * 60_000;
const RECHECK_INTERVAL_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// Squirrel.Mac validates the update before the app quits, then ShipIt swaps the bundle.
const QUIT_TIMEOUT_MS = 3 * 60_000;
const SWAP_TIMEOUT_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const UPDATER_LINE = /desktop-updater|update|squirrel|shipit|signature|requirement|error/i;

// page.evaluate sends each callback's source to the renderer, so each names the bridge itself.
type BridgeGlobal = { readonly desktopBridge: DesktopBridge };

const { values } = NodeUtil.parseArgs({
  options: {
    app: { type: "string" },
    "expect-version": { type: "string" },
    "output-dir": { type: "string" },
  },
});
const appPath = values.app;
const expectedVersion = values["expect-version"];
if (!appPath || !expectedVersion) {
  throw new Error(
    "Usage: arbre-update-proof.ts --app <installed .app> --expect-version <version> [--output-dir <dir>]",
  );
}
const outputDir = NodePath.resolve(values["output-dir"] ?? "update-proof");
NodeFS.mkdirSync(outputDir, { recursive: true });

const readBundle = (key: string) =>
  NodeChildProcess.execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, NodePath.join(appPath, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
// ShipIt moves bundles around while it installs, so the plist can be briefly missing.
const installedVersion = () => {
  try {
    return readBundle("CFBundleShortVersionString");
  } catch {
    return undefined;
  }
};
const startVersion = installedVersion();
const executablePath = NodePath.join(appPath, "Contents/MacOS", readBundle("CFBundleExecutable"));
const shipItDir = NodePath.join(
  NodeOS.homedir(),
  "Library/Caches",
  `${readBundle("CFBundleIdentifier")}.ShipIt`,
);
const appLogPath = NodePath.join(outputDir, "app.log");
const appLog = NodeFS.createWriteStream(appLogPath);

const readState = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as BridgeGlobal).desktopBridge.getUpdateState());

async function waitForState(
  page: Page,
  done: (state: DesktopUpdateState) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextCheck = Date.now() + RECHECK_INTERVAL_MS;
  for (;;) {
    const state = await readState(page);
    if (done(state)) return;
    if (state.status === "error" || state.status === "disabled") {
      throw new Error(`The updater reported ${state.status}: ${state.message ?? "no message"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out; last update state: ${JSON.stringify(state)}`);
    }
    // The release may have been published after the startup check ran.
    if (state.status === "up-to-date" && Date.now() > nextCheck) {
      nextCheck = Date.now() + RECHECK_INTERVAL_MS;
      await page.evaluate(() =>
        (globalThis as unknown as BridgeGlobal).desktopBridge.checkForUpdate(),
      );
    }
    await NodeTimersPromises.setTimeout(POLL_INTERVAL_MS);
  }
}

const tail = (file: string, lines: number) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines)
    : [];

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-arbre-update-"));
let step = "launching the installed build";
let app: ElectronApplication | undefined;
// Kept from launch: once the app quits, Playwright can no longer hand back its process.
let child: NodeChildProcess.ChildProcess | undefined;
let failure: string | undefined;
try {
  app = await _electron.launch({
    executablePath,
    // HOME stays real: a fake HOME has no login keychain, which blocks the main process.
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      T3CODE_HOME: NodePath.join(home, "t3"),
      T3CODE_TELEMETRY_ENABLED: "false",
    },
    timeout: LAUNCH_TIMEOUT_MS,
  });
  child = app.process();
  child.stdout?.on("data", (chunk: Buffer) => appLog.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => appLog.write(chunk));
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  step = "waiting for the first window";
  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });

  step = `finding ${expectedVersion}`;
  await waitForState(
    page,
    (state) => state.status === "available" && state.availableVersion === expectedVersion,
    FIND_TIMEOUT_MS,
  );

  step = `downloading ${expectedVersion}`;
  await page.evaluate(() => (globalThis as unknown as BridgeGlobal).desktopBridge.downloadUpdate());
  await waitForState(
    page,
    (state) => state.status === "downloaded" && state.downloadedVersion === expectedVersion,
    DOWNLOAD_TIMEOUT_MS,
  );
  console.log(`electron-updater emitted update-downloaded for ${expectedVersion}.`);

  step = `installing ${expectedVersion}`;
  // The page closes when the app quits to install, which rejects this call.
  page
    .evaluate(
      (version) => (globalThis as unknown as BridgeGlobal).desktopBridge.installUpdate(version),
      expectedVersion,
    )
    .catch(() => {});
  // An update Squirrel.Mac rejects keeps the app running and reports the error in its state.
  const quitDeadline = Date.now() + QUIT_TIMEOUT_MS;
  while (!exited) {
    const state = await readState(page).catch(() => undefined);
    if (state && (state.status === "error" || state.errorContext === "install")) {
      throw new Error(`The install failed: ${state.message ?? JSON.stringify(state)}`);
    }
    if (Date.now() > quitDeadline) throw new Error("The app did not quit to install the update.");
    await NodeTimersPromises.setTimeout(POLL_INTERVAL_MS);
  }

  step = "waiting for ShipIt to replace the app";
  const swapDeadline = Date.now() + SWAP_TIMEOUT_MS;
  while (installedVersion() !== expectedVersion) {
    if (Date.now() > swapDeadline) {
      throw new Error(`The app on disk is still ${installedVersion() ?? "missing"}.`);
    }
    await NodeTimersPromises.setTimeout(POLL_INTERVAL_MS);
  }
} catch (error) {
  failure = `Failed while ${step}: ${error instanceof Error ? error.message : String(error)}`;
  process.exitCode = 1;
} finally {
  if (app) {
    await Promise.race([app.close().catch(() => {}), NodeTimersPromises.setTimeout(10_000)]);
  }
  child?.kill("SIGKILL");
  // ShipIt relaunches the updated app; it has nothing left to prove.
  NodeChildProcess.spawnSync("pkill", ["-f", executablePath]);
  await new Promise((resolve) => appLog.end(resolve));
  for (const name of ["ShipIt_stderr.log", "ShipIt_stdout.log"]) {
    const file = NodePath.join(shipItDir, name);
    if (NodeFS.existsSync(file)) NodeFS.copyFileSync(file, NodePath.join(outputDir, name));
  }
  NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}

const appLines = tail(appLogPath, 100_000)
  .filter((line) => UPDATER_LINE.test(line))
  .slice(-60);
const shipItLines = tail(NodePath.join(outputDir, "ShipIt_stderr.log"), 40);
const result = failure
  ? `**Failed.** ${failure}`
  : `**Passed.** ${startVersion} found, downloaded and installed ${expectedVersion}, now on disk.`;
const block = (lines: ReadonlyArray<string>) =>
  ["```", ...(lines.length > 0 ? lines : ["(none)"]), "```"].join("\n");
const report = [
  "## In-app update proof",
  "",
  result,
  "",
  "Updater lines from the app:",
  block(appLines),
  "",
  "ShipIt stderr:",
  block(shipItLines),
  "",
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

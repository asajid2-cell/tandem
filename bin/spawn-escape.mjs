// spawn-escape.mjs — spawn long-lived workers so they survive the CALLER dying.
//
// On Windows, `detached: true` maps to DETACHED_PROCESS, which does NOT remove
// the child from the parent's Job Object. When tandem is driven by a NESTED
// headless agent (a lane running `peer.mjs ask --bg` from its own shell tool),
// that shell call runs inside a harness job with KILL_ON_JOB_CLOSE and no
// breakaway — so the "detached" worker is terminated the moment the tool call
// returns and the harness closes the job handle. Top-level sessions survive
// only because their harness job sets SILENT_BREAKAWAY_OK, letting children
// escape automatically.
//
// Nested contexts are recognized by TANDEM_NESTED_AGENT=1, which tandem
// injects into every partner agent's environment (codex CLI, serve's claude
// child, interactive attach) — so any peer.mjs a partner agent invokes carries
// the marker. Only marked callers pay for the check; unmarked (top-level)
// callers plain-spawn with zero added latency, bit-for-bit the old behavior.
// The check itself measures the real situation instead of guessing: a
// PowerShell shim (itself a child of this process, so it shares the worker's
// fate) checks its own job membership. Jobless → plain detached spawn (e.g. a
// nested harness whose job sets SILENT_BREAKAWAY_OK). Jailed → the shim has
// WMI (Win32_Process.Create, which executes in the provider host OUTSIDE the
// job chain) launch a bootstrap that spawns the real worker job-free and
// reports its pid through a file. The caller always learns the real worker
// pid, so wedge detection, `reap`, and deliberate tree-kills behave exactly
// as before.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "spawn-shim.ps1");
const BOOTSTRAP = join(HERE, "worker-bootstrap.mjs");
const ESCAPE_WAIT_MS = 20_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// TEMP instrumentation: TANDEM_SPAWN_DEBUG=<file> appends every spawn decision.
export function spawnDebug(msg) {
  if (!process.env.TANDEM_SPAWN_DEBUG) return;
  try {
    appendFileSync(
      process.env.TANDEM_SPAWN_DEBUG,
      `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`,
    );
  } catch {
    /* ignore */
  }
}

function plainSpawn(argv, env, cwd) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: "ignore",
      env,
      cwd: cwd || undefined,
    });
    child.once("spawn", () => {
      child.unref();
      resolveSpawn({ pid: child.pid, mode: "direct" });
    });
    child.once("error", rejectSpawn);
  });
}

function cleanup(...files) {
  for (const file of files) {
    try {
      if (existsSync(file)) rmSync(file);
    } catch {
      /* ignore */
    }
  }
}

// Spawn `node <argv...>` as a detached background worker that survives the
// caller's teardown. Returns { pid, mode } where pid is the REAL worker pid
// (mode "direct" = plain spawn, "escape" = launched outside the job chain).
// Throws only if the worker could not be started at all.
export async function spawnDetachedWorker({ argv, env, cwd, stateDir, tag = "worker" }) {
  spawnDebug(
    `spawnDetachedWorker ENTER tag=${tag} nested=${process.env.TANDEM_NESTED_AGENT || "(unset)"} ` +
      `noEscape=${process.env.TANDEM_NO_SPAWN_ESCAPE || "(unset)"} argv0=${argv[0]}`,
  );
  if (
    process.platform !== "win32" ||
    process.env.TANDEM_NO_SPAWN_ESCAPE === "1" ||
    process.env.TANDEM_NESTED_AGENT !== "1"
  ) {
    spawnDebug(`spawnDetachedWorker tag=${tag} branch=plain (marker absent or escape disabled)`);
    return plainSpawn(argv, env, cwd);
  }
  const id = randomUUID().slice(0, 8);
  const specFile = join(stateDir, `spawn-${tag}-${id}.json`);
  const pidFile = join(stateDir, `spawn-${tag}-${id}.pid`);
  writeFileSync(
    specFile,
    JSON.stringify({
      node: process.execPath,
      bootstrap: BOOTSTRAP,
      argv,
      env,
      cwd: cwd || process.cwd(),
      pidFile,
    }),
  );
  let out = "";
  try {
    const shim = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SHIM, "-Spec", specFile],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    out = ((shim.stdout || "") + (shim.stderr || "")).trim();
  } catch (error) {
    out = `mode=error err=${error.message || error}`;
  }
  spawnDebug(`spawnDetachedWorker tag=${tag} shimOut=${out.replace(/\s+/g, " ").slice(0, 200)}`);
  if (/^mode=direct\b/m.test(out)) {
    spawnDebug(`spawnDetachedWorker tag=${tag} branch=plain (shim measured jobless)`);
    cleanup(specFile, pidFile);
    return plainSpawn(argv, env, cwd);
  }
  if (/^mode=wmi\b/m.test(out)) {
    spawnDebug(`spawnDetachedWorker tag=${tag} branch=wmi (shim measured jailed)`);
    const deadline = Date.now() + ESCAPE_WAIT_MS;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        let pid = 0;
        try {
          pid = Number(readFileSync(pidFile, "utf8").trim());
        } catch {
          /* mid-write; retry */
        }
        if (pid > 0) {
          cleanup(specFile, pidFile);
          return { pid, mode: "escape" };
        }
        if (pid === 0 && readFileSync(pidFile, "utf8").trim() === "0") {
          cleanup(specFile, pidFile);
          throw new Error("job-escape bootstrap could not start the worker");
        }
      }
      await sleep(100);
    }
    cleanup(specFile, pidFile);
    throw new Error("job-escape bootstrap did not report a worker pid in time");
  }
  // Escape unavailable (no PowerShell, WMI denied, …): degrade to the old
  // behavior, but say so — inside a kill-on-close job this worker will not
  // outlive the caller's tool call.
  console.error(
    `tandem: job-escape spawn unavailable (${out || "no shim output"}); using a plain detached spawn — a nested caller's teardown may reap this worker`,
  );
  cleanup(specFile, pidFile);
  return plainSpawn(argv, env, cwd);
}

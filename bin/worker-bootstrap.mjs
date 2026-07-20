// worker-bootstrap.mjs — tiny relay for job-escaped worker spawns (Windows).
// Launched via WMI (so it lives OUTSIDE the original caller's Job Object
// chain), it spawns the real worker as its own child — which is therefore also
// job-free — reports the worker's pid back through the spec's pid file, and
// exits. The worker is detached + unref'd, so it keeps running on its own.
//
// Spec file (JSON): { argv: [...], env: {...}, cwd, pidFile }
// argv is the full node argument list (script + args); env is the complete
// environment for the worker (WMI-created processes do not inherit the
// caller's environment, so it must travel by file).
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

let spec;
try {
  spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(1);
}
const child = spawn(process.execPath, spec.argv, {
  detached: true,
  stdio: "ignore",
  env: spec.env,
  cwd: spec.cwd || undefined,
});
child.once("spawn", () => {
  try {
    writeFileSync(spec.pidFile, String(child.pid));
  } catch {
    /* the waiter will time out and report */
  }
  child.unref();
  try {
    rmSync(process.argv[2]); // spec carries the full env — remove it promptly
  } catch {
    /* the waiter cleans up too */
  }
  process.exit(0);
});
child.once("error", () => {
  try {
    writeFileSync(spec.pidFile, "0");
  } catch {
    /* ignore */
  }
  process.exit(1);
});

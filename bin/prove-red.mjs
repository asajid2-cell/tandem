// Prove-red for fleet lanes — the anti-vacuity gate, fleet-native.
//
// A green verifier proves nothing by itself: 33% of the old engine's "verified" leaves had
// checks that passed WITHOUT the work. The fleet has what orch lacked — every lane DECLARES its
// writes[] — so vacuity is provable generically: withhold exactly the lane's written files
// (tracked files restored to their HEAD content, created files removed), run the verifier and
// demand RED; restore everything; run again and demand GREEN. red→green, or the check is
// worthless.
//
// MUST run BEFORE the lane's work is committed: once the work is in HEAD, "restore to HEAD"
// restores the work itself and the red phase is meaningless (detected and refused below).
//
// THREE LESSONS FROM THE FIRST REAL CAMPAIGN are enforced here, because exit codes alone are
// not proof:
//   1. ZERO-ASSERTION GREEN. A lane whose file is needed to COMPILE but whose tests match
//      nothing exits 0 in both phases of the reasoning and used to certify PASS-PROVEN. Green
//      output that reports zero tests run is VACUOUS, not proof. (`expectGreen` pins what the
//      green must actually say.)
//   2. CAN'T-MEASURE IS NOT RED. A red phase that timed out, could not spawn, or was killed is
//      INCONCLUSIVE — the old engine destroyed real work by conflating these.
//   3. RED FOR THE WRONG REASON. `expectRed` pins the red's CAUSE, so an unrelated failure in
//      the withheld phase cannot masquerade as proof that the lane's work is load-bearing.
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { hardKillProcessTree } from "./process-control.mjs";

// A verifier whose GREEN says this ran nothing has asserted nothing.
const ZERO_ASSERTION = [
  /\b0 passed\b/i,
  /\bran 0 tests\b/i,
  /\b0 tests?\b(?!\s*failed)/i,
  /\bno tests? (?:to run|were run|found)\b/i,
  /\bcollected 0 items\b/i,
  /\b0 examples?\b/i,
];

function git(cwd, args) {
  try {
    return { out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
  } catch (error) {
    return { out: String(error.stdout || ""), code: error.status ?? 1 };
  }
}

function inHead(cwd, relPath) {
  return git(cwd, ["cat-file", "-e", `HEAD:${relPath.replace(/\\/g, "/")}`]).code === 0;
}

// Run the verifier and classify the OUTCOME, never just the exit code.
// kind: "pass" | "fail" | "unmeasurable"
function runVerify(verify, cwd, timeoutSec) {
  const run = spawnSync(verify, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    killSignal: "SIGKILL",
  });
  const text = `${run.stdout || ""}\n${run.stderr || ""}`.trim();
  const tail = text.split(/\r?\n/).slice(-3).join(" | ");
  // A timeout/spawn failure is NOT evidence about the code. On Windows spawnSync's timeout kills
  // only the shell, so sweep the tree — an orphan holding a build lock poisons every later run
  // (measured: an orphaned wlgen.exe broke every subsequent workspace build).
  const timedOut = run.error?.code === "ETIMEDOUT" || run.signal === "SIGKILL" || run.signal === "SIGTERM";
  if (timedOut && run.pid) {
    try {
      hardKillProcessTree(run.pid);
    } catch {
      /* best effort — the verdict below is what protects correctness */
    }
  }
  if (run.error || timedOut) {
    return { kind: "unmeasurable", tail: tail || String(run.error?.message || "verifier could not be measured"), text };
  }
  return { kind: run.status === 0 ? "pass" : "fail", tail, text };
}

function refuse(detail) {
  return { ok: false, red: false, green: false, vacuous: false, inconclusive: false, detail };
}

// Returns {ok, red, green, vacuous, inconclusive, detail}. ok ⟺ a confirmed red AND a confirmed,
// non-vacuous green. Restoration is guaranteed via finally — a crashed probe never leaves the
// worktree withheld.
export function proveRedLane({ cwd, writes, verify, timeoutSec = 300, expectRed = null, expectGreen = null }) {
  if (!verify) return refuse("no verify command");
  if (!Array.isArray(writes) || !writes.length) return refuse("no writes[] declared — nothing to withhold");
  const isRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
  const stash = mkdtempSync(join(tmpdir(), "prove-red-"));
  const plan = [];
  for (const w of writes) {
    const abs = isAbsolute(w) ? resolve(w) : resolve(cwd, w);
    if (!existsSync(abs)) continue; // the lane never wrote it — nothing to withhold
    const rel = isRepo ? relative(cwd, abs) : "";
    const tracked = isRepo && !rel.startsWith("..") && inHead(cwd, rel);
    if (tracked && git(cwd, ["diff", "--quiet", "HEAD", "--", rel]).code === 0) {
      // file content EQUALS HEAD → the work is already committed (or the lane wrote nothing new);
      // withholding would restore the work itself and fake a meaningful red
      return refuse(`"${w}" matches HEAD — prove-red must run BEFORE the lane's work is committed`);
    }
    const keep = join(stash, `${plan.length}-${basename(abs)}`);
    copyFileSync(abs, keep);
    plan.push({ abs, rel, tracked, keep });
  }
  if (!plan.length) return refuse("no declared write exists on disk — lane wrote nothing?");

  let redResult;
  try {
    for (const f of plan) {
      if (f.tracked) git(cwd, ["checkout", "HEAD", "--", f.rel]);
      else unlinkSync(f.abs);
    }
    redResult = runVerify(verify, cwd, timeoutSec);
  } finally {
    for (const f of plan) {
      try {
        copyFileSync(f.keep, f.abs);
      } catch {
        /* keep restoring the rest; the stash dir survives for manual recovery */
      }
    }
  }

  // LESSON 2 — an unmeasurable red is not a red. Bail before touching the green phase so the
  // verdict can never be "proven" off an infrastructure failure.
  if (redResult.kind === "unmeasurable") {
    cleanup(stash);
    return {
      ok: false, red: false, green: false, vacuous: false, inconclusive: true,
      detail: `INCONCLUSIVE: the withheld phase could not be measured (${redResult.tail}) — this is not evidence the work is load-bearing`,
    };
  }
  const red = redResult.kind === "fail";
  // LESSON 3 — the red must fail for the stated reason.
  if (red && expectRed && !expectRed.test(redResult.text)) {
    cleanup(stash);
    return {
      ok: false, red: true, green: false, vacuous: false, inconclusive: true,
      detail: `expectRed did not match: the withheld phase failed for a different reason (${redResult.tail})`,
    };
  }

  const greenResult = runVerify(verify, cwd, timeoutSec);
  cleanup(stash);
  if (greenResult.kind === "unmeasurable") {
    return {
      ok: false, red, green: false, vacuous: false, inconclusive: true,
      detail: `INCONCLUSIVE: the restored phase could not be measured (${greenResult.tail})`,
    };
  }
  const green = greenResult.kind === "pass";
  // LESSON 1 — a green that ran no assertions proves nothing, whatever its exit code.
  const zeroAssertion = green && ZERO_ASSERTION.some((re) => re.test(greenResult.text));
  if (zeroAssertion) {
    return {
      ok: false, red, green, vacuous: true, inconclusive: false,
      detail: `VACUOUS: the restored verifier exited 0 with no assertions run (${greenResult.tail})`,
    };
  }
  if (green && expectGreen && !expectGreen.test(greenResult.text)) {
    return {
      ok: false, red, green, vacuous: true, inconclusive: false,
      detail: `expectGreen did not match: the verifier passed without proving the contract (${greenResult.tail})`,
    };
  }
  return {
    ok: red && green,
    red,
    green,
    vacuous: !red,
    inconclusive: false,
    detail: !red
      ? `VACUOUS: verifier passed with the lane's work withheld (${redResult.tail})`
      : green
        ? "red→green proven"
        : `red ok but GREEN failed after restore (${greenResult.tail})`,
  };
}

function cleanup(stash) {
  try {
    rmSync(stash, { recursive: true, force: true });
  } catch {
    /* temp sweeper's problem */
  }
}

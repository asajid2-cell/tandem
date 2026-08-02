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
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

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

function runVerify(verify, cwd, timeoutSec) {
  const run = spawnSync(verify, { cwd, shell: true, encoding: "utf8", timeout: timeoutSec * 1000 });
  return { pass: run.status === 0 && !run.error, tail: `${run.stdout || ""}\n${run.stderr || ""}`.trim().split(/\r?\n/).slice(-3).join(" | ") };
}

// Returns {ok, red, green, vacuous, detail}. ok ⟺ red && green. Restoration is guaranteed via
// finally — a crashed probe never leaves the worktree withheld.
export function proveRedLane({ cwd, writes, verify, timeoutSec = 300 }) {
  if (!verify) return { ok: false, red: false, green: false, vacuous: false, detail: "no verify command" };
  if (!Array.isArray(writes) || !writes.length) {
    return { ok: false, red: false, green: false, vacuous: false, detail: "no writes[] declared — nothing to withhold" };
  }
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
      return {
        ok: false, red: false, green: false, vacuous: false,
        detail: `"${w}" matches HEAD — prove-red must run BEFORE the lane's work is committed`,
      };
    }
    const keep = join(stash, `${plan.length}-${basename(abs)}`);
    copyFileSync(abs, keep);
    plan.push({ abs, rel, tracked, keep });
  }
  if (!plan.length) {
    return { ok: false, red: false, green: false, vacuous: false, detail: "no declared write exists on disk — lane wrote nothing?" };
  }
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
  const red = !redResult.pass;
  const greenResult = runVerify(verify, cwd, timeoutSec);
  try {
    rmSync(stash, { recursive: true, force: true });
  } catch {
    /* temp sweeper's problem */
  }
  return {
    ok: red && greenResult.pass,
    red,
    green: greenResult.pass,
    vacuous: !red,
    detail: !red
      ? `VACUOUS: verifier passed with the lane's work withheld (${redResult.tail})`
      : greenResult.pass
        ? "red→green proven"
        : `red ok but GREEN failed after restore (${greenResult.tail})`,
  };
}

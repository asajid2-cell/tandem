// Lane seeds — the files the APEX places into a lane's worktree so the lane is graded by
// assertions it does not own.
//
// This is the custody rule that made two real campaigns trustworthy ("a lane must never be graded
// by assertions it can edit"), and until now it had NO automation: the apex maintained a text file
// of hashes by hand. It also collided with the collection-time scope audit, which reads
// `git status` and therefore sees the seeds as files written outside the lane's declared scope —
// so every lane in the proven recipe would have reported SCOPE-BREACH spuriously, which is worse
// than no signal because it teaches an operator to wave breaches through.
//
// Recording seeds at dispatch fixes both: the audit knows they are the apex's, and re-hashing at
// collection proves mechanically that the lane never touched its own grader.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function abs(cwd, p) {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// Stamp the seeds as they were when the lane was dispatched.
export function hashSeeds(cwd, seedPaths = []) {
  const seeds = [];
  for (const p of seedPaths) {
    if (typeof p !== "string" || !p.trim()) continue;
    const file = abs(cwd, p);
    if (!existsSync(file)) continue; // a seed the apex never actually wrote is not a seed
    seeds.push({ path: p, sha256: digest(file) });
  }
  return { ts: Date.now(), cwd, seeds };
}

// Prove, at collection, that the lane left every grader exactly as it found it.
export function recheckSeeds(cwd, stamped) {
  const seeds = stamped?.seeds || [];
  const tampered = [];
  const missing = [];
  for (const s of seeds) {
    const file = abs(cwd, s.path);
    if (!existsSync(file)) {
      missing.push(s.path);
      continue;
    }
    if (digest(file) !== s.sha256) tampered.push(s.path);
  }
  const ok = tampered.length === 0 && missing.length === 0;
  return {
    ok,
    tampered,
    missing,
    detail: ok
      ? `all ${seeds.length} seeded file(s) unchanged — the lane did not edit its grader`
      : [
          tampered.length ? `${tampered.length} seeded file(s) were EDITED by the lane — it tampered with the assertions grading it` : "",
          missing.length ? `${missing.length} seeded file(s) are MISSING` : "",
        ]
          .filter(Boolean)
          .join("; "),
  };
}

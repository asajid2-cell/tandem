#!/usr/bin/env node
// Deterministic stand-in for `codex exec` used by the test harness. It mimics codex's
// `--json` stream + `-o` output so the REAL peer.mjs flow can be exercised with no real
// model, no API, and no cost. Behaviour is controlled by env vars:
//   FAKE_TOKENS         input-token count to report (drives the compaction/low-context path)
//   FAKE_FAIL_CONTEXT=1 simulate hitting the context wall on RESUME (fresh still succeeds)
//   FAKE_SID            force the fresh session id (otherwise a random uuid)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2); // codex args: exec [resume] --json … -o <file> [-C <cwd>] [<sid>] -
const resume = argv.includes("resume");
const oi = argv.indexOf("-o");
const outFile = oi >= 0 ? argv[oi + 1] : null;
const ci = argv.indexOf("-C");
const cwdArg = ci >= 0 ? argv[ci + 1] : "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sidArg = argv.find((a) => uuid.test(a));

let task = "";
try {
  task = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
const nonEmpty = task
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((line) => line && !line.startsWith("[tandem-coupling:"));
const firstLine = (nonEmpty[0] || "").slice(0, 100);
const lastLine = (nonEmpty[nonEmpty.length - 1] || "").slice(0, 100); // the real instruction when a handoff seed is prepended

// A full resumed session can't even summarize itself; a fresh one always works → recovery path.
if (process.env.FAKE_FAIL_CONTEXT === "1" && resume) {
  process.stderr.write("Error: maximum context length exceeded for this conversation\n");
  process.stdout.write(JSON.stringify({ error: "context length exceeded" }) + "\n");
  process.exit(1);
}

const sid = resume ? sidArg : process.env.FAKE_SID || randomUUID();
const verdict = `FAKE ok sid=${sid} mode=${resume ? "resume" : "fresh"} cwd=${cwdArg || "(resume)"} task=${firstLine} | last=${lastLine}`;
const lines = [];
if (!resume && process.env.FAKE_OMIT_SESSION_ID !== "1") lines.push(JSON.stringify({ session_id: sid })); // peer.mjs parseSessionId picks this up
lines.push(JSON.stringify({ item: { type: "agent_message", text: verdict } }));
lines.push(JSON.stringify({ usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 1000, output_tokens: 40 } }));
function emit() {
  if (!resume && process.env.FAKE_WRITE_ROLLOUT === "1" && process.env.TANDEM_CODEX_SESSIONS) {
    mkdirSync(process.env.TANDEM_CODEX_SESSIONS, { recursive: true });
    writeFileSync(
      join(process.env.TANDEM_CODEX_SESSIONS, `rollout-fake-${Date.now()}-${sid}.jsonl`),
      JSON.stringify({ type: "user_message", task }) + "\n",
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  if (outFile) {
    try {
      writeFileSync(outFile, verdict);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
const delay = Number(process.env.FAKE_DELAY) || 0; // let concurrent turns genuinely overlap in tests
if (delay) setTimeout(emit, delay);
else emit();

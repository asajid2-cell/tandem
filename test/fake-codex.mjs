#!/usr/bin/env node
// Deterministic stand-in for `codex exec` used by the test harness. It mimics codex's
// `--json` stream + `-o` output so the REAL peer.mjs flow can be exercised with no real
// model, no API, and no cost. Behaviour is controlled by env vars:
//   FAKE_TOKENS         input-token count to report (drives the compaction/low-context path)
//   FAKE_FAIL_CONTEXT=1 simulate hitting the context wall on RESUME (fresh still succeeds)
//   FAKE_SID            force the fresh session id (otherwise a random uuid)
//   FAKE_STREAM_INTERVAL_MS / FAKE_STREAM_COUNT emit periodic tool activity before the verdict
//   FAKE_HANG_AFTER_SESSION=1 emit the session id, then stay silent until tandem stops the process
//   FAKE_SIGNAL_FILE     record a graceful signal observed by the fake
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
const sessionLines = [];
if (!resume && process.env.FAKE_DECOY_ID) {
  sessionLines.push(JSON.stringify({ type: "item.started", id: process.env.FAKE_DECOY_ID }));
}
if (!resume && process.env.FAKE_OMIT_SESSION_ID !== "1") sessionLines.push(JSON.stringify({ session_id: sid })); // peer.mjs parseSessionId picks this up
const finalLines = [
  JSON.stringify({ item: { type: "agent_message", text: verdict } }),
  JSON.stringify({ usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 1000, output_tokens: 40 } }),
];

function writeLines(lines) {
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

function finish() {
  if (!resume && process.env.FAKE_WRITE_ROLLOUT === "1" && process.env.TANDEM_CODEX_SESSIONS) {
    mkdirSync(process.env.TANDEM_CODEX_SESSIONS, { recursive: true });
    writeFileSync(
      join(process.env.TANDEM_CODEX_SESSIONS, `rollout-fake-${Date.now()}-${sid}.jsonl`),
      JSON.stringify({ type: "user_message", task }) + "\n",
    );
  }
  writeLines(finalLines);
  if (outFile) {
    try {
      writeFileSync(outFile, verdict);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (process.env.FAKE_SIGNAL_FILE) {
      try {
        writeFileSync(process.env.FAKE_SIGNAL_FILE, signal);
      } catch {
        /* ignore */
      }
    }
    if (process.env.FAKE_IGNORE_TERM !== "1") process.exit(143);
  });
}

const streamIntervalMs = Number(process.env.FAKE_STREAM_INTERVAL_MS) || 0;
const streamCount = Math.max(0, Number(process.env.FAKE_STREAM_COUNT) || 0);
const delay = Number(process.env.FAKE_DELAY) || 0; // let concurrent turns genuinely overlap in tests

if (process.env.FAKE_HANG_AFTER_SESSION === "1") {
  writeLines(sessionLines);
  setInterval(() => {}, 1000);
} else if (streamIntervalMs > 0 && streamCount > 0) {
  writeLines(sessionLines);
  let emitted = 0;
  const timer = setInterval(() => {
    emitted += 1;
    writeLines([
      JSON.stringify({
        item: {
          type: "command_execution",
          command: `fake-stream-activity-${emitted}`,
        },
      }),
    ]);
    if (emitted >= streamCount) {
      clearInterval(timer);
      finish();
    }
  }, streamIntervalMs);
} else {
  const emit = () => {
    writeLines(sessionLines);
    finish();
  };
  if (delay) setTimeout(emit, delay);
  else emit();
}

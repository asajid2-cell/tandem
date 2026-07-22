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
//   FAKE_LIMIT=1         the agent_message AND the -o file become the REAL codex usage-limit string
//                        (with a reset datetime ~25h in the future, so parseResetTime lands ahead)
//   FAKE_LIMIT_EXIT      "0" (default) = banner as an exit-0 verdict; "1" = write the banner to
//                        stderr and exit 1 WITHOUT an agent_message (the nonzero-exit limit shape)
//   FAKE_STREAM_LIMIT_NOISE=1  emit the limit string inside a command_execution STREAM item while
//                        the real verdict stays clean (false-positive guard: stream ≠ verdict)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// The exact string the codex CLI prints when the ChatGPT/Codex subscription is capped, with a
// reset datetime generated ~25h ahead at RUNTIME so parseResetTime always resolves into the future
// (a hard-coded date would eventually fall into the past and flip the test).
function codexLimitString() {
  const d = new Date(Date.now() + 25 * 3600 * 1000);
  const mon = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getMonth()];
  const n = d.getDate();
  const ord = (v) => v + (["th", "st", "nd", "rd"][(v % 100 - 20) % 10] || ["th", "st", "nd", "rd"][v % 100] || "th");
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${mon} ${ord(n)}, ${d.getFullYear()} ${h}:${min} ${ap}.`;
}
const LIMIT_STRING = codexLimitString();

let testProcessRecord = "";
if (process.env.TANDEM_TEST_PROCESS_DIR) {
  try {
    mkdirSync(process.env.TANDEM_TEST_PROCESS_DIR, { recursive: true });
    testProcessRecord = join(process.env.TANDEM_TEST_PROCESS_DIR, `${process.pid}.json`);
    writeFileSync(
      testProcessRecord,
      JSON.stringify({ pid: process.pid, ppid: process.ppid }),
    );
  } catch {
    /* test cleanup still has the peer/job pid records */
  }
}
process.once("exit", () => {
  if (!testProcessRecord) return;
  try {
    rmSync(testProcessRecord, { force: true });
  } catch {
    /* test root cleanup removes stale records after a forced kill */
  }
});

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

const limitMode = process.env.FAKE_LIMIT === "1";
// Nonzero-exit limit shape: the banner goes to STDERR and the process exits 1 with no verdict.
if (limitMode && process.env.FAKE_LIMIT_EXIT === "1") {
  process.stderr.write(LIMIT_STRING + "\n");
  process.exit(1);
}

const sid = resume ? sidArg : process.env.FAKE_SID || randomUUID();
// Banner-as-verdict (exit 0): the "final message" IS the limit string — the silent-failure case.
const verdict = limitMode
  ? LIMIT_STRING
  : `FAKE ok sid=${sid} mode=${resume ? "resume" : "fresh"} cwd=${cwdArg || "(resume)"} task=${firstLine} | last=${lastLine}`;
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
  // False-positive guard fixture: the limit string appears in a TOOL-OUTPUT stream item, but the
  // verdict stays clean. peer.mjs classifies only verdict+stderr (never the raw stream), so this
  // must NOT trip a park.
  if (process.env.FAKE_STREAM_LIMIT_NOISE === "1") {
    writeLines([JSON.stringify({ item: { type: "command_execution", command: `echo ${LIMIT_STRING}` } })]);
  }
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

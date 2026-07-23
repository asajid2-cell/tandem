#!/usr/bin/env node
// Deterministic stand-in for `codex exec` used by the test harness. It mimics codex's
// `--json` stream + `-o` output so the REAL peer.mjs flow can be exercised with no real
// model, no API, and no cost. Behaviour is controlled by env vars:
//   FAKE_TOKENS         input-token count to report (drives the compaction/low-context path)
//   FAKE_FAIL_CONTEXT=1 simulate hitting the context wall on RESUME (fresh still succeeds)
//   FAKE_SID            force the fresh session id (otherwise a random uuid)
//   FAKE_STREAM_INTERVAL_MS / FAKE_STREAM_COUNT emit periodic tool activity before the verdict
//   FAKE_HANG_AFTER_SESSION=1 emit the session id, then stay silent until tandem stops the process
//   FAKE_HANG_MATCH      (with FAKE_HANG_AFTER_SESSION) hang ONLY when the task text includes this
//                        string — pins the hang to one turn so a follow-up (e.g. the T5 progress-
//                        capture prompt) on the same session is answered normally. Unset = the
//                        current unconditional hang, so every existing test keeps its behavior.
//   FAKE_SIGNAL_FILE     record a graceful signal observed by the fake
//   FAKE_LIMIT=1         the agent_message AND the -o file become the REAL codex usage-limit string
//                        (with a reset datetime ~25h in the future, so parseResetTime lands ahead)
//   FAKE_LIMIT_EXIT      "0" (default) = banner as an exit-0 verdict; "1" = write the banner to
//                        stderr and exit 1 WITHOUT an agent_message (the nonzero-exit limit shape)
//   FAKE_STREAM_LIMIT_NOISE=1  emit the limit string inside a command_execution STREAM item while
//                        the real verdict stays clean (false-positive guard: stream ≠ verdict)
//   FAKE_VERDICT         override the final agent_message/-o text verbatim (may be multi-line) —
//                        lets tests prove an ANSWER that merely discusses limit banners never parks
//   FAKE_STDERR_NOISE=1  write a transient 429 retry notice to stderr but SUCCEED (exit 0) — the
//                        shape both real CLIs produce when a rate-limited request retries and lands
//   FAKE_TOOL_OPEN_MS=<ms> after the session lines, emit an item.started for a command_execution
//                        (id "item_0"), stay SILENT for <ms>, then emit the matching item.completed —
//                        the real "a single tool call emits nothing while it runs" shape. Then the
//                        normal final lines (verdict etc.), unless FAKE_HANG_AFTER_TOOL is set.
//   FAKE_HANG_AFTER_TOOL=1 (only with FAKE_TOOL_OPEN_MS) after item.completed, hang forever instead
//                        of finishing — proves the stall clock RESUMES once the open tool closes
//   FAKE_REPEAT_STREAM_MS=<ms> / FAKE_REPEAT_COUNT=<n> re-emit the SAME command_execution item text
//                        every <ms>, <n> times, then finish. NO novel command, NO file change, the
//                        output just repeats — a busy-but-STUCK partner that streams bytes forever
//                        (so the raw stall clock never fires) but makes no progress. The exact shape
//                        W3's progress-idle detector exists to catch. (Contrast: FAKE_STREAM_INTERVAL_MS
//                        emits a DISTINCT command each cycle — novel work that must NOT trip it.)
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
// A successful turn that was transiently rate-limited: retry notice on stderr, clean exit 0.
if (process.env.FAKE_STDERR_NOISE === "1") {
  process.stderr.write("Rate limited; retrying in 4s... (429 Too Many Requests)\n");
}
// Banner-as-verdict (exit 0): the "final message" IS the limit string — the silent-failure case.
const verdict = limitMode
  ? LIMIT_STRING
  : process.env.FAKE_VERDICT ||
    `FAKE ok sid=${sid} mode=${resume ? "resume" : "fresh"} cwd=${cwdArg || "(resume)"} task=${firstLine} | last=${lastLine}`;
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
  if (process.env.FAKE_WRITE_ROLLOUT === "1" && process.env.TANDEM_CODEX_SESSIONS) {
    mkdirSync(process.env.TANDEM_CODEX_SESSIONS, { recursive: true });
    // Keep the user_message FIRST (the coupling machinery greps the task marker in the file prefix),
    // then the turn_context line — the real shape peer.mjs reads model/effort provenance from. Fire
    // on RESUME turns too, writing to the file named with the resumed sid.
    const rollout =
      JSON.stringify({ type: "user_message", task }) + "\n" +
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "turn_context",
        payload: { model: process.env.FAKE_ACTUAL_MODEL || "gpt-5.6-sol", effort: process.env.FAKE_ACTUAL_EFFORT || "high" },
      }) + "\n";
    writeFileSync(join(process.env.TANDEM_CODEX_SESSIONS, `rollout-fake-${Date.now()}-${sid}.jsonl`), rollout);
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
const toolOpenMs = Number(process.env.FAKE_TOOL_OPEN_MS) || 0; // a silent open tool call → stall-suspension tests
const repeatMs = Number(process.env.FAKE_REPEAT_STREAM_MS) || 0; // re-emit the SAME item → no-progress tests
const repeatCount = Math.max(0, Number(process.env.FAKE_REPEAT_COUNT) || 0);

const hangMatch = process.env.FAKE_HANG_MATCH || "";
const shouldHang = process.env.FAKE_HANG_AFTER_SESSION === "1" && (!hangMatch || task.includes(hangMatch));
if (shouldHang) {
  writeLines(sessionLines);
  setInterval(() => {}, 1000);
} else if (toolOpenMs > 0) {
  // One codex tool call that emits NOTHING while it runs: item.started, SILENCE for toolOpenMs, then
  // item.completed. The event shapes mirror real `codex exec --json` command executions so peer.mjs's
  // stall-clock suspension is exercised with no real tool, no model, no cost.
  writeLines(sessionLines);
  writeLines([
    JSON.stringify({
      type: "item.started",
      item: { id: "item_0", type: "command_execution", command: "long-running-tool", aggregated_output: "", exit_code: null },
    }),
  ]);
  setTimeout(() => {
    writeLines([
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "command_execution", command: "long-running-tool", exit_code: 0 },
      }),
    ]);
    // The open tool has closed. FAKE_HANG_AFTER_TOOL proves the stall clock RESUMES: hang forever now
    // and the ordinary stall guard must trip. Otherwise finish the turn normally.
    if (process.env.FAKE_HANG_AFTER_TOOL === "1") setInterval(() => {}, 1000);
    else finish();
  }, toolOpenMs);
} else if (repeatMs > 0 && repeatCount > 0) {
  // A busy-but-STUCK partner: it streams bytes forever (so the raw stall clock never fires) but
  // re-emits the SAME command_execution item — the SAME command string, byte-identical each time.
  // No NOVEL command, no file change, the output just repeats: exactly what W3's progress-idle
  // detector exists to catch. item.completed (never a lingering item.started) keeps openItems empty
  // so the T6 tool-open SUSPENSION never masks it. After repeatCount emissions we finish() so the
  // detector-OFF case still completes with a clean exit-0 verdict.
  writeLines(sessionLines);
  let emitted = 0;
  const timer = setInterval(() => {
    emitted += 1;
    writeLines([
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "command_execution", command: "npm test  # the same failing command, re-run", exit_code: 1 },
      }),
    ]);
    if (emitted >= repeatCount) {
      clearInterval(timer);
      finish();
    }
  }, repeatMs);
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

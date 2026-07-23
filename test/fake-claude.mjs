#!/usr/bin/env node
// Persistent stand-in for the `claude -p --input-format stream-json …` partner the serve daemon
// drives. Reads one user message per stdin line, replies with a stream-json `result` (+ a
// session_id on the first turn), and stays alive — no real model, no API. Env: FAKE_SID, FAKE_TOKENS.
//   FAKE_LIMIT=1      the exit-0 `result` payload IS the claude session-limit banner (the silent-
//                     failure shape): "You've hit your session limit · resets 3am (America/Edmonton)"
//   FAKE_LIMIT_429=1  the `result` is instead the anthropic 429 rate_limit_error JSON body
//   FAKE_LIMIT_MATCH  optional substring gate (like FAKE_HANG_MATCH) — only turns containing it hit
//                     the limit; others reply normally
//   FAKE_VERDICT      override the result text verbatim (may be multi-line) — lets tests prove an
//                     ANSWER that merely discusses limit banners never parks
//   FAKE_RATE_LIMIT_STATUS  emit a rate_limit_event with this status (e.g. "rejected"/"allowed"/
//                     "allowed_warning") BEFORE the reply every turn — the daemon's PRIMARY structural
//                     signal; FAKE_RATE_LIMIT_RESETS_AT (epoch sec) + FAKE_RATE_LIMIT_TYPE tune it
//   FAKE_TOOL_USE=1   the assistant event carries a tool_use item → the turn "did work" (a capped
//                     turn cannot run tools), gating the did-work branch of the classifier

// The exact strings the claude CLI surfaces on a capped subscription (see limit-policy.mjs header).
const CLAUDE_SESSION_LIMIT = "You've hit your session limit · resets 3am (America/Edmonton)";
const CLAUDE_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(SELF);

// FAKE_ENV_FILE: record the environment this partner was spawned with, so tests
// can assert the serve daemon scrubbed the lane's identity out of it.
if (process.env.FAKE_ENV_FILE) {
  try {
    writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify(process.env));
  } catch {
    /* the asserting test will fail loudly on the missing file */
  }
}

// FAKE_NESTED_ASK=1: when a turn contains SPAWN-SUB-LANE, behave like a real
// partner agent using its shell tool — run `peer.mjs ask --bg` for a claude
// sub-lane INSIDE a fresh kill-on-close job (jobsim = the tool-call harness),
// wait for the tool call to return (job handle closes = tool teardown), and
// answer the turn with the tool call's output. The nested ask inherits THIS
// process's env exactly like a real tool call would, plus the vars the real
// claude CLI stamps into tool calls (session id, CLAUDE_PID, CLAUDECODE).
function runNestedAsk() {
  const peer = resolve(TEST_DIR, "..", "bin", "peer.mjs");
  const jobsim = join(TEST_DIR, "jobsim.ps1");
  const env = {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    CLAUDE_CODE_SESSION_ID: process.env.FAKE_SUB_SID || "subPartner001",
    CLAUDE_PID: String(process.pid),
    TANDEM_PARTNER: "claude",
    TANDEM_CLAUDE_BIN: SELF,
    FAKE_SID: "",
    FAKE_DELAY: process.env.FAKE_SUB_DELAY || "3000",
    FAKE_DELAY_MATCH: "SUB-LANE-TASK",
  };
  if (process.env.FAKE_SUB_LABEL) env.TANDEM_LABEL = process.env.FAKE_SUB_LABEL;
  delete env.FAKE_ENV_FILE;
  delete env.FAKE_NESTED_ASK;
  delete env.FAKE_HANG_AFTER_SESSION;
  delete env.FAKE_HANG_MATCH;
  const commandLine = [`"${process.execPath}"`, `"${peer}"`, `"ask"`, `"--bg"`, `"SUB-LANE-TASK do the sub work"`].join(" ");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", jobsim, "-Flags", "0x2000", "-Cwd", process.cwd(), "-CommandLine", commandLine, "-TimeoutMs", "60000"],
    { encoding: "utf8", windowsHide: true, timeout: 75_000, env },
  );
  return `NESTED-ASK ${((r.stdout || "") + (r.stderr || "")).replace(/\s+/g, " ").trim()}`;
}

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
    /* test cleanup still has the daemon/job pid records */
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

const args = process.argv.slice(2);
const ri = args.indexOf("--resume");
const sid = (ri >= 0 ? args[ri + 1] : null) || process.env.FAKE_SID || randomUUID();
let firstTurn = true;
// A turn is "open" from the moment it's received until it is answered (or interrupted). A hang keeps
// it open indefinitely; a delayed reply keeps it open until pendingReplyTimer fires. An interrupt
// control_request while a turn is open ends it with an error_during_execution result (see below).
let turnOpen = false;
let pendingReplyTimer = null;

function emitSession() {
  if (!firstTurn) return;
  process.stdout.write(JSON.stringify({ session_id: sid }) + "\n");
  firstTurn = false;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  // Interrupt control_request over the SAME stdin pipe user turns arrive on (T4 protocol grace).
  // Handle it BEFORE the user-turn logic. Real behavior (probed 2026-07-21): ack immediately with a
  // control_response success, flush the in-flight turn as a result event (subtype
  // error_during_execution, is_error true), and STAY ALIVE — the session answers the next turn warm.
  // FAKE_IGNORE_INTERRUPT=1 swallows it silently, exercising the daemon's hard-kill fallback.
  let control = null;
  try {
    control = JSON.parse(line);
  } catch {
    /* not JSON — fall through to the normal task path */
  }
  if (control && control.type === "control_request" && control.request && control.request.subtype === "interrupt") {
    if (process.env.FAKE_IGNORE_INTERRUPT === "1") return;
    process.stdout.write(
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: control.request_id } }) + "\n",
    );
    if (turnOpen) {
      if (pendingReplyTimer) {
        clearTimeout(pendingReplyTimer);
        pendingReplyTimer = null;
      }
      turnOpen = false;
      process.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "[Request interrupted by user]",
          usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 800, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }) + "\n",
      );
    }
    return;
  }
  let task = "";
  try {
    const o = JSON.parse(line);
    const c = o.message?.content;
    task = Array.isArray(c) ? c.find((x) => x.type === "text")?.text || "" : typeof c === "string" ? c : "";
  } catch {
    task = line;
  }
  const ne = task.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = (ne[0] || "").slice(0, 100);
  const last = (ne[ne.length - 1] || "").slice(0, 100);
  const shouldHang =
    process.env.FAKE_HANG_AFTER_SESSION === "1" &&
    (!process.env.FAKE_HANG_MATCH || task.includes(process.env.FAKE_HANG_MATCH));
  if (shouldHang) {
    turnOpen = true; // the hang leaves the turn OPEN — an interrupt during it yields error_during_execution
    emitSession();
    return;
  }
  const limitGate = !process.env.FAKE_LIMIT_MATCH || task.includes(process.env.FAKE_LIMIT_MATCH);
  const limitMode = process.env.FAKE_LIMIT === "1" && limitGate;
  const limit429 = process.env.FAKE_LIMIT_429 === "1" && limitGate;
  const reply = () => {
    emitSession(); // daemon captures + records the pair
    // FAKE_RATE_LIMIT_STATUS: the real claude stream carries a machine-readable rate_limit_event every
    // turn. Emit one BEFORE the reply so the daemon's structural classifier sees it before the result.
    if (process.env.FAKE_RATE_LIMIT_STATUS) {
      process.stdout.write(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: {
            status: process.env.FAKE_RATE_LIMIT_STATUS,
            resetsAt: Number(process.env.FAKE_RATE_LIMIT_RESETS_AT) || Math.floor(Date.now() / 1000) + 7200,
            rateLimitType: process.env.FAKE_RATE_LIMIT_TYPE || "five_hour",
            overageStatus: "rejected",
            isUsingOverage: false,
          },
        }) + "\n",
      );
    }
    const nested =
      process.env.FAKE_NESTED_ASK === "1" && task.includes("SPAWN-SUB-LANE") ? ` ${runNestedAsk()}` : "";
    // A capped subscription returns the banner (or the 429 JSON) as an ORDINARY exit-0 result —
    // the silent-failure shape the daemon must classify instead of storing it as a verdict.
    const verdict = limit429
      ? CLAUDE_429
      : limitMode
        ? CLAUDE_SESSION_LIMIT
        : process.env.FAKE_VERDICT || `FAKE-CLAUDE ok sid=${sid} cwd=${process.cwd()} first=${first} last=${last}${nested}`;
    // Provenance: the real claude stream stamps the model id on every assistant event. Emit one so
    // the daemon can prove modelActual (env FAKE_MODEL overrides). The daemon ignores unknown types,
    // so this is harmless for every existing case. FAKE_TOOL_USE=1 folds a tool_use item into the
    // SAME assistant event (model + tool_use) — the structural "this turn ran real work" witness.
    const content = process.env.FAKE_TOOL_USE === "1" ? [{ type: "tool_use", name: "Bash", input: {} }] : [];
    process.stdout.write(
      JSON.stringify({ type: "assistant", message: { model: process.env.FAKE_MODEL || "claude-opus-4-8", content } }) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        type: "result",
        result: verdict,
        usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 800, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) + "\n",
    );
    turnOpen = false; // the turn has been answered
    pendingReplyTimer = null;
  };
  const delayMatches =
    !process.env.FAKE_DELAY_MATCH || task.includes(process.env.FAKE_DELAY_MATCH);
  const delay = delayMatches ? Number(process.env.FAKE_DELAY) || 0 : 0;
  turnOpen = true; // a received turn is OPEN until reply() answers it (or an interrupt ends it)
  if (delay > 0) pendingReplyTimer = setTimeout(reply, delay);
  else reply();
});
rl.on("close", () => process.exit(0)); // stdin EOF = daemon closed
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (process.env.FAKE_SIGNAL_FILE) {
      try {
        writeFileSync(process.env.FAKE_SIGNAL_FILE, sig);
      } catch {
        /* ignore */
      }
    }
    if (process.env.FAKE_IGNORE_TERM !== "1") process.exit(0);
  });
}

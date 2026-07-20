#!/usr/bin/env node
// Persistent stand-in for the `claude -p --input-format stream-json …` partner the serve daemon
// drives. Reads one user message per stdin line, replies with a stream-json `result` (+ a
// session_id on the first turn), and stays alive — no real model, no API. Env: FAKE_SID, FAKE_TOKENS.
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

function emitSession() {
  if (!firstTurn) return;
  process.stdout.write(JSON.stringify({ session_id: sid }) + "\n");
  firstTurn = false;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
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
    emitSession();
    return;
  }
  const reply = () => {
    emitSession(); // daemon captures + records the pair
    const nested =
      process.env.FAKE_NESTED_ASK === "1" && task.includes("SPAWN-SUB-LANE") ? ` ${runNestedAsk()}` : "";
    const verdict = `FAKE-CLAUDE ok sid=${sid} cwd=${process.cwd()} first=${first} last=${last}${nested}`;
    process.stdout.write(
      JSON.stringify({
        type: "result",
        result: verdict,
        usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 800, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) + "\n",
    );
  };
  const delayMatches =
    !process.env.FAKE_DELAY_MATCH || task.includes(process.env.FAKE_DELAY_MATCH);
  const delay = delayMatches ? Number(process.env.FAKE_DELAY) || 0 : 0;
  if (delay > 0) setTimeout(reply, delay);
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

#!/usr/bin/env node
// Persistent stand-in for the `claude -p --input-format stream-json …` partner the serve daemon
// drives. Reads one user message per stdin line, replies with a stream-json `result` (+ a
// session_id on the first turn), and stays alive — no real model, no API. Env: FAKE_SID, FAKE_TOKENS.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    const verdict = `FAKE-CLAUDE ok sid=${sid} cwd=${process.cwd()} first=${first} last=${last}`;
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

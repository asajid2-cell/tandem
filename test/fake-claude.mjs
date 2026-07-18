#!/usr/bin/env node
// Persistent stand-in for the `claude -p --input-format stream-json …` partner the serve daemon
// drives. Reads one user message per stdin line, replies with a stream-json `result` (+ a
// session_id on the first turn), and stays alive — no real model, no API. Env: FAKE_SID, FAKE_TOKENS.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const ri = args.indexOf("--resume");
const sid = (ri >= 0 ? args[ri + 1] : null) || process.env.FAKE_SID || randomUUID();
let firstTurn = true;

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
  const reply = () => {
    if (firstTurn) {
      process.stdout.write(JSON.stringify({ session_id: sid }) + "\n"); // daemon captures + records the pair
      firstTurn = false;
    }
    const verdict = `FAKE-CLAUDE ok sid=${sid} first=${first} last=${last}`;
    process.stdout.write(
      JSON.stringify({
        type: "result",
        result: verdict,
        usage: { input_tokens: Number(process.env.FAKE_TOKENS) || 800, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) + "\n",
    );
  };
  const delay = Number(process.env.FAKE_DELAY) || 0;
  if (delay > 0) setTimeout(reply, delay);
  else reply();
});
rl.on("close", () => process.exit(0)); // stdin EOF = daemon closed
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));

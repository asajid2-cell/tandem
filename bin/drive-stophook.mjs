#!/usr/bin/env node
// Claude Code Stop hook for tandem drive mode.
//
// Contract: print {"decision":"block","reason":"..."} to stdout to prevent
// Claude from stopping and feed the reason back as the next turn. Print nothing
// to stdout to allow the stop. This hook is deliberately fail-open.

import {
  capReached,
  consumeNextDirective,
  incrementCounter,
  isDriveEnabled,
  readCounter,
  setDriveEnabled,
} from "./driveQueue.mjs";

const EMPTY_REASON =
  'no directive queued; run `node Z:/328/CMPUT328-A2/codexworks/301/tandem/bin/peer.mjs ask "Ask Codex for the next directive, then queue it with peer.mjs drive"` to get the next step from Codex, then continue';

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

try {
  if (!isDriveEnabled()) process.exit(0);

  if (capReached()) {
    const c = readCounter();
    console.error(`tandem drive: drive cap reached (${c.count}/${c.cap}); allowing Claude to stop`);
    setDriveEnabled(false);
    process.exit(0);
  }

  const entry = consumeNextDirective();
  const reason = entry?.directive || EMPTY_REASON;
  incrementCounter();
  block(reason);
} catch (e) {
  console.error(`tandem drive: stop hook failed open: ${e?.message || e}`);
  process.exit(0);
}

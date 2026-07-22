#!/usr/bin/env node
// sync-shared.mjs — vendor the canonical provider-policy package into tandem.
//
// The provider-policy package (limit detection + reset parsing, subscription-billing env scrub,
// the park/reserve/resolve engine, the headless posture) is authored ONCE in the orchestrate
// repo's shared/ tree and consumed by BOTH orch and tandem. tandem carries its own committed COPY
// under bin/shared/provider-policy so a standalone `git clone` of tandem needs no sibling repo to
// run — but a copy silently drifting from its source is a correctness hazard (a limit string the
// canonical package learned to catch would be missed here). So this script re-copies the source
// wholesale and writes a manifest of normalized content hashes; test/shared-drift.test.mjs then
// FAILS if a vendored file is tampered with, if the canonical source has moved ahead of the copy,
// or if the copy's POLICY_VERSION disagrees with the manifest.
//
// Line endings are normalized to LF before hashing so git's autocrlf can never flip the drift
// test on a Windows checkout (the bytes on disk may be CRLF; the recorded hash is CRLF-agnostic).
//
// <src> defaults to the sibling orchestrate repo but is overridable with TANDEM_SHARED_SRC. If the
// source is absent (a standalone install), this is a NO-OP that exits 0: the committed vendored
// copy is authoritative and install.ps1 calls this best-effort.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = process.env.TANDEM_SHARED_SRC || resolve(ROOT, "..", "orchestrate");
const SRC_PKG = join(SRC, "shared", "provider-policy");
const DEST = join(HERE, "shared", "provider-policy");

// Normalize CRLF→LF before hashing so autocrlf checkouts can't change the digest.
const normHash = (buf) =>
  createHash("sha256").update(Buffer.from(buf).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

// Depth-first list of package-relative POSIX paths (so the manifest keys are stable cross-platform).
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

async function main() {
  if (!existsSync(SRC_PKG)) {
    console.warn(
      `sync-shared: canonical source ${SRC_PKG} not found — keeping the committed vendored copy ` +
        `(standalone install; set TANDEM_SHARED_SRC to re-vendor).`,
    );
    return;
  }

  // Wipe the vendored dir first so a file DELETED from the source is also removed here (a stale
  // vendored .mjs would otherwise fail the "not in manifest" drift check — that's the point).
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });

  const rel = walk(SRC_PKG);
  const files = {};
  for (const r of rel) {
    const content = readFileSync(join(SRC_PKG, r));
    const destFile = join(DEST, r);
    mkdirSync(dirname(destFile), { recursive: true });
    writeFileSync(destFile, content); // byte-for-byte copy (LF-normalization is for HASHING only)
    files[r] = normHash(content);
  }

  // policyVersion: import the freshly-copied provider-state.mjs (single source of truth), with a
  // regex fallback so a syntactically-broken copy still yields a manifest the drift test can flag.
  let policyVersion = null;
  try {
    const mod = await import(pathToFileURL(join(DEST, "provider-state.mjs")).href);
    if (Number.isFinite(mod.POLICY_VERSION)) policyVersion = mod.POLICY_VERSION;
  } catch {
    /* fall back to the source regex below */
  }
  if (policyVersion == null) {
    const m = readFileSync(join(DEST, "provider-state.mjs"), "utf8").match(/POLICY_VERSION\s*=\s*(\d+)/);
    policyVersion = m ? Number(m[1]) : 0;
  }

  writeFileSync(join(DEST, "manifest.json"), JSON.stringify({ policyVersion, files }, null, 2) + "\n");
  console.log(`sync-shared: vendored ${rel.length} files (policyVersion ${policyVersion}) from ${SRC_PKG}`);
}

main().catch((e) => {
  console.error(`sync-shared: ${e.message || e}`);
  process.exit(1);
});

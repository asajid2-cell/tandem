// shared-drift.test.mjs — the vendored provider-policy copy must stay a FAITHFUL copy.
//
// tandem carries a committed copy of the shared provider-policy package under
// bin/shared/provider-policy (so a standalone clone runs with no sibling repo). A copy that
// silently drifts from its source is a correctness hazard: a limit/auth string the canonical
// package learned to catch would be missed here, and a lane would treat a provider cap as a task
// failure. bin/sync-shared.mjs records a manifest of normalized content hashes; these tests fail if
//   (a) a vendored file is missing or tampered with (hash mismatch),
//   (b) a vendored .mjs exists that the manifest doesn't list (an un-synced stray),
//   (c) the copy's POLICY_VERSION disagrees with the manifest, or
//   (d) the canonical source on THIS machine has moved ahead of the vendored copy.
// Dependency-free: only node:crypto + node:fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PKG = join(ROOT, "bin", "shared", "provider-policy");
const MANIFEST = join(PKG, "manifest.json");

// CRLF→LF before hashing so an autocrlf checkout can't flip the result (matches sync-shared.mjs).
const normHash = (buf) =>
  createHash("sha256").update(Buffer.from(buf).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

function walkRel(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRel(p, base, out);
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

test("every manifest file exists and its normalized hash matches (tamper → fail)", () => {
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const file = join(PKG, rel);
    assert.ok(existsSync(file), `vendored file missing: ${rel}`);
    assert.equal(normHash(readFileSync(file)), hash, `vendored ${rel} hash drifted from the manifest`);
  }
});

test("a tampered vendored file WOULD fail the hash check (assert the detector, no file left behind)", () => {
  const [rel, hash] = Object.entries(manifest.files)[0];
  const original = readFileSync(join(PKG, rel));
  // Mutate in memory only — never write a tampered file to disk.
  const tampered = Buffer.from(original.toString("utf8") + "\n// drift\n");
  assert.notEqual(normHash(tampered), hash, "hash of tampered content must differ from the manifest");
  assert.equal(normHash(original), hash, "the ACTUAL vendored file is intact");
});

test("no vendored .mjs exists that the manifest does not list", () => {
  const onDisk = walkRel(PKG).filter((r) => r.endsWith(".mjs"));
  for (const rel of onDisk) {
    assert.ok(manifest.files[rel] !== undefined, `vendored ${rel} is not in the manifest — run bin/sync-shared.mjs`);
  }
});

test("POLICY_VERSION of the vendored package equals the manifest", async () => {
  const mod = await import(pathToFileURL(join(PKG, "provider-state.mjs")).href);
  assert.equal(mod.POLICY_VERSION, manifest.policyVersion, "vendored POLICY_VERSION disagrees with the manifest");
});

test("IF the canonical source exists on this machine, it matches the vendored manifest", () => {
  const SRC = process.env.TANDEM_SHARED_SRC || resolve(ROOT, "..", "orchestrate");
  const SRC_PKG = join(SRC, "shared", "provider-policy");
  if (!existsSync(SRC_PKG)) {
    // Standalone machine (no sibling repo) — nothing to compare against; the copy is authoritative.
    return;
  }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const srcFile = join(SRC_PKG, rel);
    assert.ok(existsSync(srcFile), `canonical source missing ${rel} — the vendored copy is stale, re-run sync-shared`);
    assert.equal(
      normHash(readFileSync(srcFile)),
      hash,
      `canonical ${rel} has moved ahead of the vendored copy — re-run bin/sync-shared.mjs`,
    );
  }
});

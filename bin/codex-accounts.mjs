// Multi-account codex capacity.
//
// `codex` reads credentials, config and session history from $CODEX_HOME, so an ACCOUNT IS A
// DIRECTORY and switching accounts is choosing one. The consequence that matters here: two
// accounts can run AT THE SAME TIME, which turns a second subscription into concurrent capacity
// rather than a fallback. The pool that actually ran out (codex primary, 90% used with 6.5 days
// to reset) is per-account, so a lane naming its account is naming which pool it spends.
//
// Registration is owned by the operator's `codex-acct` tool (301/orchestrate/bin/codex-acct.mjs);
// this module only READS what that tool set up, and never touches credentials.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultAccountsRoot() {
  return process.env.TANDEM_CODEX_ACCOUNTS || join(homedir(), ".codex-accounts");
}

// A directory is an account only if it is actually signed in — `auth.json` is what `codex` reads,
// so its absence means the directory would silently behave as "not logged in".
export function listCodexAccounts(root = defaultAccountsRoot()) {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ label: e.name, home: join(root, e.name), sessionsDir: join(root, e.name, "sessions") }))
      .filter((a) => existsSync(join(a.home, "auth.json")));
  } catch {
    return [];
  }
}

// Resolve a label to its CODEX_HOME. Refuses anything that escapes the accounts root — a lane
// manifest is authored by a mind, and "../../somewhere" must not become a credential path.
export function accountHome(label, root = defaultAccountsRoot()) {
  if (typeof label !== "string" || !label.trim()) return "";
  const home = resolve(root, label);
  if (basename(home) !== label || resolve(root, basename(home)) !== home) return "";
  return home;
}

// Every account this box can spend, including the ambient/default home, with the sessions dir a
// quota read needs. Labels are stable; credential material is never read or printed.
export function allSpendableAccounts(root = defaultAccountsRoot()) {
  const ambient = process.env.CODEX_HOME || join(homedir(), ".codex");
  const out = [{ label: "(default)", home: ambient, sessionsDir: join(ambient, "sessions") }];
  for (const a of listCodexAccounts(root)) out.push(a);
  return out;
}

// ACCOUNT POLICY. A second subscription bought as CHEAP BUILDER CAPACITY must not quietly become
// a place to run expensive tiers — that is how a spare pool evaporates. Owner ruling 2026-08-02:
// the `review` account is luna-only. Enforced at dispatch rather than written in a doc, because
// this system's own history is a list of advisory rules that got bypassed under pressure.
export function checkAccountPolicy({ account = "", model = "", profile = "", policy = {} } = {}) {
  const label = String(account || "").trim();
  if (!label) return { ok: true, detail: "no account named — ambient default" };
  const allow = policy?.[label]?.allow;
  if (!Array.isArray(allow) || allow.length === 0) return { ok: true, detail: `no policy for account "${label}"` };
  const chosen = String(profile || model || "").trim();
  if (!chosen) return { ok: false, detail: `account "${label}" is restricted to ${allow.join(", ")} but the lane names no model` };
  const ok = allow.some((a) => chosen === a || chosen.includes(a));
  return {
    ok,
    detail: ok
      ? `"${chosen}" is permitted on account "${label}"`
      : `account "${label}" is restricted to ${allow.join(", ")} — it is cheap builder capacity, and "${chosen}" is not that`,
  };
}

// Config-driven defaults, read from the user-owned tandem.config.json. These exist so the right
// pool and the ceiling are not things an operator has to REMEMBER on every campaign — the
// engine's whole history is a list of correct rules that were bypassed because they lived in a
// human's head instead of in the dispatch path.
export function laneAccountDefault(configPath) {
  try {
    const file = configPath || join(process.env.TANDEM_ROOT || resolveRoot(), "tandem.config.json");
    if (!existsSync(file)) return "";
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return typeof cfg.codexLaneAccount === "string" ? cfg.codexLaneAccount.trim() : "";
  } catch {
    return "";
  }
}

function resolveRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

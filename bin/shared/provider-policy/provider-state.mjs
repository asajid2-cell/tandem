// provider-state.mjs — provider limit awareness + provider/tier-agnostic assignment,
// extracted from the conductor so it can be shared/vendored (e.g. into tandem) with ZERO
// behavior change. This is a COPY of the conductor's park/reserve/resolve logic behind a
// createProviderPolicy() factory: same on-disk state files (provider-state.json /
// reserve-hold.json under stateDir), same JSON shapes, same fail-safe try/catch discipline,
// and the SAME log strings (a downstream guard test asserts on these exact lines).
//
// The engine is provider-AGNOSTIC: a role has a PREFERRED family, but when that provider is
// rate-limited (usage cap), work flows to the OTHER provider at the same tier, then DOWN a
// tier on both (bounded reasoning on a lesser model beats stalling — fallbacks are logged so
// regressions stay visible/re-reviewable). When EVERY provider is capped, the caller pauses.
//
// Reset parsing + limit/auth classification live in limit-policy.mjs (unit-tested against the
// REAL strings both CLIs emit — see that file's header); they are re-exported here so a
// consumer needs only this one policy object.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyExternalFailure,
  extractExternalFailure,
  parseResetTime,
} from './limit-policy.mjs';

export const POLICY_VERSION = 1;

const TIER_LADDER = ['deep', 'default', 'efficient', 'floor'];
const altFamily = f => (f === 'claude' ? 'codex' : 'claude');

export function createProviderPolicy({
  stateDir,                 // where provider-state.json + reserve-hold.json live
  tiers = {},               // { claude: {deep,default,efficient:{model,effort}}, codex: {...} }
  families = {},            // role -> preferred family; resolve() also accepts a family name directly
  reserve = { fable: 3 },   // model -> reserve threshold % (the escalation channel — see conductor.mjs)
  reserveHold = [],
  reserveBypass = false,
  usageProbe = {},          // model -> shell cmd string OR async function returning number | {remaining, asof}
  disabledProviders = [],
  deepNoDegrade = false,
  deepFableOnly = false,    // deep runs on the PREFERRED family's deep model (fable) only — no cross-family reroute, no step-down
  // Families drawing on the SCARCE subscription pool — see offPoolRoles.
  // ★ `claude-cheap` (the test-only haiku builder lane) BELONGS HERE. This list does not mean "expensive",
  // it means "spends subscription quota", and haiku spends exactly the resource that ran out — it is ~5x
  // cheaper per token than opus, not free. Omitting it would classify it as an off-pool family, and the
  // ladder below would then let an ordinary deepseek build DEGRADE onto it whenever the bridge hiccuped:
  // the same accident that put 51% of builds on the premium lane, wearing a cheaper hat. Listing it here
  // makes it unreachable by degradation while leaving explicit opt-in intact, because the PRIMARY is always
  // kept regardless of premium status.
  premiumFamilies = ['claude', 'claude-cheap'],
  offPoolRoles = ['build', 'sweep'],  // roles that may NEVER touch a premium family (set [] to restore the old ladder)
  now = Date.now,
  log = () => {},
} = {}) {
  const PROVIDER_FILE = join(stateDir, 'provider-state.json');
  const RESERVE_FILE = join(stateDir, 'reserve-hold.json');

  // tierSpec: this family's spec for `tier`, falling back to its `default` tier (or {}).
  function tierSpec(family, tier) {
    const fam = tiers[family] || {};
    return fam[tier] || fam.default || {};
  }

  function state() { try { return JSON.parse(readFileSync(PROVIDER_FILE, 'utf8')); } catch { return {}; } }
  function saveState(s) { try { writeFileSync(PROVIDER_FILE, JSON.stringify(s)); } catch {} }

  function available(family) { const p = state()[family]; return !p || !p.until || p.until <= now(); }

  // A PARK IS ONLY ACTIONABLE IF YOU CAN SEE HOW LONG IT IS.
  //
  // These lines used to print `new Date(until).toLocaleTimeString()` — the TIME with no date. Measured
  // 2026-07-29: codex returned "You've hit your usage limit ... try again at Aug 4th, 2026 10:25 PM",
  // parsed correctly to a timestamp 147 HOURS away, and logged as "parked until ~10:25:00 p.m." That
  // reads as three hours from now. The stored state was right and the only wrong thing was the sentence
  // a human (or an agent triaging the log) actually reads.
  //
  // The duration is what carries the severity, so lead with it: a six-day outage and a six-minute one
  // are different events and must not render identically.
  function formatUntil(until) {
    const ms = until - now();
    const h = ms / 3_600_000;
    const rel = ms <= 0 ? 'now'
      : h < 1 ? `${Math.round(ms / 60_000)}m`
      : h < 48 ? `${h.toFixed(1)}h`
      : `${(h / 24).toFixed(1)} DAYS`;
    return `${new Date(until).toISOString().replace('T', ' ').slice(0, 16)}Z (in ${rel})`;
  }

  // Park a family: parse WHEN it comes back, classify limit-vs-auth (default 'limit'), record
  // the reason, and log exactly (a probe must never un-park an auth park).
  function markDown(family, providerMsg) {
    const until = parseResetTime(providerMsg, now());
    const kind = classifyExternalFailure(providerMsg)?.kind || 'limit';
    const s = state();
    s[family] = { until, kind, reason: String(providerMsg).slice(0, 200), since: now() };
    saveState(s);
    log(`PROVIDER ${family} ${kind === 'auth' ? 'auth-failed' : 'rate-limited'} → parked until ${formatUntil(until)} (routing to fallback)`);
    return { kind, until };
  }

  function earliestReset() {
    const times = Object.values(state()).map(p => p && p.until).filter(t => t && t > now());
    return times.length ? Math.min(...times) : now() + 3600_000;
  }

  // Usage RESERVE: keep the last N% of a model (default fable 10%) for the user. A held model
  // is skipped in the ladder. Holds come from config (reserveHold) + a runtime file
  // (reserve-hold.json). reserveBypass ignores it all.
  const reserveThreshold = model => (reserve && reserve[model] != null) ? reserve[model] : 3;

  function heldModels() {
    if (reserveBypass) return new Set();
    const held = new Set(reserveHold || []);
    try { const a = JSON.parse(readFileSync(RESERVE_FILE, 'utf8')); if (Array.isArray(a)) a.forEach(m => held.add(m)); } catch {}
    return held;
  }

  // Refresh reserve holds from the configured probes, then apply probe-driven early un-park.
  // NOTE: async because a probe may be a function (the conductor only uses shell-string probes,
  // which run synchronously via execFileSync). String-probe behavior is synchronous-equivalent.
  async function refreshHolds() {
    const probes = usageProbe || {};
    if (!Object.keys(probes).length) return;
    let arr = []; try { const a = JSON.parse(readFileSync(RESERVE_FILE, 'utf8')); if (Array.isArray(a)) arr = a; } catch {}
    const held = new Set(arr);
    const probed = {};   // model -> { remaining, asof } from THIS refresh only (never stale holds)
    for (const [model, probe] of Object.entries(probes)) {
      let remaining = null, asof = null;
      try {
        if (typeof probe === 'function') {
          const r = await probe();
          if (typeof r === 'number') { remaining = r; }
          else if (r && typeof r === 'object') { remaining = Number(r.remaining); asof = (r.asof != null ? Number(r.asof) : null); }
          if (remaining != null && !Number.isFinite(remaining)) remaining = null;
        } else {
          const out = process.platform === 'win32'
            // 8s, not 15. A probe is a METER READING: if it cannot answer quickly the honest move is to
            // keep the previous hold and read again next cycle, not to hold the caller open. The
            // conductor runs these synchronously inside its heartbeat window, so a slow probe is
            // indistinguishable from a wedged conductor to the guard watching that beat — and on
            // 2026-07-29 a rate-limited usage endpoint (429, then 401/403) burned 15s x 2 models x
            // several passes and got a healthy conductor killed twice.
            ? execFileSync('cmd', ['/c', probe], { encoding: 'utf8', timeout: 8_000, windowsHide: true })
            : execFileSync('sh', ['-c', probe], { encoding: 'utf8', timeout: 8_000, windowsHide: true });
          const m = String(out).match(/-?\d+(?:\.\d+)?/);
          if (m) remaining = parseFloat(m[0]);
          const a = String(out).match(/asof=(\d+)/);   // optional freshness stamp (ms epoch) for file-derived probes
          if (a) asof = Number(a[1]);
        }
      } catch { continue; }   // probe failed → leave the current hold state untouched
      if (remaining == null) continue;
      probed[model] = { remaining, asof };
      const threshold = reserveThreshold(model);
      if (remaining <= threshold) { if (!held.has(model)) log(`RESERVE: ${model} at ${remaining}% ≤ ${threshold}% — holding it (routing deep reasoning to the alternate provider)`); held.add(model); }
      else held.delete(model);
    }
    try { writeFileSync(RESERVE_FILE, JSON.stringify([...held])); } catch {}
    // Probe-driven EARLY UN-PARK: a reactive park (worker saw a limit message) can outlive the
    // real limit (conservative parse, tz skew, or the account was switched). When a live probe
    // proves a parked family has usage headroom again, un-park it now instead of waiting out the
    // stated reset. Guards: never for auth parks (headroom ≠ credentials), and never on data
    // older than the park itself (a stale codex rollout predating the limit must not free it).
    const st = state();
    let changed = false;
    for (const [fam, p] of Object.entries(st)) {
      if (!p || !p.until || p.until <= now()) continue;
      if (p.kind === 'auth') continue;
      const models = [...new Set(TIER_LADDER.map(t => tierSpec(fam, t).model).filter(Boolean))];
      const usable = models.some(mdl => {
        const pr = probed[mdl];
        if (!pr || pr.remaining <= reserveThreshold(mdl)) return false;
        return pr.asof == null || pr.asof > (p.since || 0);   // no stamp = live probe = fresh
      });
      if (usable) {
        delete st[fam];
        changed = true;
        log(`PROVIDER ${fam} un-parked early — usage probe shows headroom above reserve (park was: ${String(p.reason || '').slice(0, 100)})`);
      }
    }
    if (changed) saveState(st);
  }

  // Resolve which (family, tier) actually runs a node NOW: preferred family/tier, then the other
  // provider at that tier, then step DOWN a tier on both — skipping rate-limited providers.
  // Returns {family, tier, model, effort, degraded} or null when everything is capped (→ pause).
  // roleOrFamily may be a role (mapped via families) OR a family name passed directly.
  function resolve(roleOrFamily, wantTier, { noDegrade } = {}) {
    // A role maps through `families`; a FAMILY may also be passed directly, and "directly" means any
    // family this campaign actually configured tiers for — not just the two hardcoded names. Reading
    // it as `claude|codex ? it : 'claude'` silently rewrote resolve('deepseek') into a premium
    // assignment, which is the same defect this function's off-pool rule exists to prevent.
    const primary = families[roleOrFamily]
      || (tiers[roleOrFamily] ? roleOrFamily
        : (roleOrFamily === 'claude' || roleOrFamily === 'codex' ? roleOrFamily : 'claude'));
    const disabled = new Set(disabledProviders || []);   // a signed-out/disabled provider must NEVER be routed to (else every spawn fails)
    const start = Math.max(0, TIER_LADDER.indexOf(wantTier || 'default'));
    // Deep roles must NOT silently degrade to a lesser model: deep planning/judgment/governance on
    // a lesser model, trusted as the deep result, is a correctness failure. When noDegrade holds
    // (default: deepNoDegrade && the wanted tier is deep) do NOT step down the ladder — if no
    // deep-capable model is available, return null (→ the caller pauses; retries at reset).
    // deepFableOnly pins a DEEP assignment to the preferred family's deep model (fable) and nothing
    // else: the cross-family codex-deep reroute is skipped AND the tier never steps down, so an
    // unavailable fable resolves to null — the caller PAUSES the deep node rather than accepting a
    // lesser mind. Off by default, so every other campaign keeps the full redundancy ladder.
    const fableOnly = deepFableOnly && (wantTier || 'default') === 'deep';
    const nd = fableOnly
      ? true
      : ((noDegrade !== undefined) ? noDegrade : (deepNoDegrade && (wantTier || 'default') === 'deep'));
    const end = nd ? start : TIER_LADDER.length - 1;
    // OFF-POOL RULE. A builder may never draw on the scarce subscription pool. The old ladder was
    // [primary, altFamily(primary)], and altFamily() maps anything-not-codex to 'claude' — so every
    // DeepSeek hiccup (rate limit, dropped stream, 402 empty balance) silently promoted a BUILD to
    // premium. Measured over the MAX campaign that was 238 of 422 builds, 51%, on the expensive lane,
    // taking Claude's weekly from 58% to 7% on a campaign where it was only supposed to coordinate —
    // and those premium builds folded LESS (73%/31% proven vs DeepSeek's 81%/67%).
    //
    // So for an off-pool role the FALLBACK set is every other non-premium family this campaign
    // configured, and nothing else. When they are all down, resolve() returns null exactly as it does
    // when everything is capped, and the caller PAUSES: no builder is a blocker to raise with a human,
    // not a routing problem to solve by spending the one resource that makes raising it possible.
    //
    // The PRIMARY is always kept, premium or not. This rule governs where work DEGRADES to, never
    // where a campaign deliberately sent it: `families.build = 'claude'` is an explicit instruction and
    // silently rerouting it would be the same class of bug in the other direction. The guarantee "Claude
    // never builds" is therefore held by config (families.build must name an off-pool family, which is
    // now the default) and enforced here against every path that was reaching premium by ACCIDENT.
    // (Set offPoolRoles: [] to restore the old cross-pool ladder.)
    const premium = new Set(premiumFamilies || []);
    const offPool = (offPoolRoles || []).includes(roleOrFamily) || (offPoolRoles || []).includes(primary);
    let ladder;
    if (fableOnly) ladder = [primary];
    else if (offPool) {
      ladder = [primary, ...Object.keys(tiers).filter(f => f !== primary && !premium.has(f))];
    } else ladder = [primary, altFamily(primary)];
    const held = heldModels();
    for (let i = start; i <= end; i++) {
      const tier = TIER_LADDER[i];
      for (const family of ladder) {
        if (disabled.has(family)) continue;         // never route to a disabled/signed-out provider
        const spec = tierSpec(family, tier);
        const model = spec.model;
        if (!model || held.has(model)) continue;   // no model, or reserved-out (e.g. fable's last 10% kept for the user)
        if (!available(family)) continue;
        return { family, tier, model, effort: spec.effort, degraded: (family !== primary || tier !== wantTier) };
      }
    }
    return null;
  }

  return {
    // limit-policy re-exports (classification + reset parsing)
    classify: classifyExternalFailure,
    extractFailure: extractExternalFailure,
    parseResetTime,
    // provider state
    state,
    available,
    markDown,
    earliestReset,
    formatUntil,          // so every "paused until ..." line in the conductor reads the same way
    // reserve holds
    heldModels,
    refreshHolds,
    // assignment
    tierSpec,
    resolve,
  };
}

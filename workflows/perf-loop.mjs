// ============================================================================
// perf-loop — the dynamic-workflow + tandem orchestration layer.
//
// One self-verifying perf loop, run as a deterministic Workflow:
//   Diagnose  (parallel Claude, READ-ONLY) -> adversarial synthesis -> ONE lever
//   Implement (Codex via the tandem bridge, blocking) -> commit or report
//   Verify    (one agent runs the gates; parallel Claude adversarially judge) -> verdict
//
// Roles: Claude Workflow agents own everything parallel-analyzable (diagnosis,
// verification, viability, review). Codex stays the serialized engineering lead
// because VENPOD builds/profiles cannot run in parallel ("Do NOT run two heavy
// builds at once"). The bridge (tandem/bin/peer.mjs) is how a Workflow agent
// drives Codex.
//
// Invoke:  Workflow({ scriptPath: ".../perf-loop.mjs", args: { goal, leverHint } })
//   args.goal     : the loop objective (1-3 sentences)
//   args.leverHint: optional steer for the diagnosis (else it picks from the profile)
//   args.skipDiagnose / args.skipImplement / args.skipVerify : run sub-phases only
// ============================================================================

export const meta = {
  name: 'perf-loop',
  description: 'One self-verifying VENPOD perf loop: parallel Claude diagnosis -> Codex tandem implementation -> parallel adversarial Claude verification -> commit-or-revert verdict. The dynamic-workflow + tandem orchestration layer.',
  phases: [
    { title: 'Diagnose', detail: 'parallel read-only analysis of the current bottleneck -> ONE precise lever' },
    { title: 'Implement', detail: 'delegate the serialized build to Codex via the tandem bridge' },
    { title: 'Verify', detail: 'run the gates once, parallel adversarial judges -> real-win-or-revert' },
  ],
}

const REPO = 'z:/328/CMPUT328-A2/codexworks/301/3d/VENPOD'
const TANDEM = 'z:/328/CMPUT328-A2/codexworks/301/tandem'
const LEDGER = `${REPO}/perf/LOOPS.md`

const goal = (args && args.goal) || 'Advance the VENPOD editing-dip GPU mid-mesh promotion per perf/LOOPS.md.'
const leverHint = (args && args.leverHint) || ''

// Shared rules every agent gets.
const READONLY = `STRICT READ-ONLY. Do NOT build, run VENPOD/playrun/profilers, or edit files. Only Read/Grep/Glob ${REPO} and reason. Cite file:line. A Codex build may be running; never conflict.`
const TRUSTED = `Trusted method (from ${LEDGER}): the sampling profiler DEADLOCKS the flythrough (use FRAMETIME_LOG there); PERF_SPARSE_STEPS buckets are inflated; the pixel-SHA visual gate is INVALID (engine is nondeterministic ~1-2%/frame) -> compare change-vs-baseline against baseline RUN-TO-RUN noise, never demand pixel-identity; gate dips on a MULTI-RUN (>=3) FRAMETIME A/B + deterministic brick-counts; NEVER ship a hole (visibleMissing=0 every frame).`

// ---------------------------------------------------------------------------
// PHASE 1 — DIAGNOSE (parallel, read-only) -> synthesize ONE lever
// ---------------------------------------------------------------------------
const LEVER_SCHEMA = {
  type: 'object',
  required: ['lever', 'rationale', 'gatePlan', 'risk', 'confidence'],
  properties: {
    lever: { type: 'string', description: 'the ONE concrete change to make this loop, with target file:line' },
    rationale: { type: 'string', description: 'why this is the highest-leverage safe next step, with measured evidence' },
    gatePlan: { type: 'string', description: 'exactly how to verify it: which replay(s), metric(s), the within-noise visual oracle, the no-hole check' },
    risk: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    abandonIf: { type: 'string', description: 'the condition under which to abandon rather than commit' },
  },
}

async function diagnose() {
  phase('Diagnose')
  const angles = [
    { key: 'profile', p: `${READONLY}\n${TRUSTED}\nGoal: ${goal}\nRead the bottom of ${LEDGER} (recent loops + their measured numbers). From the CURRENT committed state, what is the single dominant remaining cost / blocker, and what is the most recent measured evidence for it? ${leverHint ? 'Steer: ' + leverHint : ''}` },
    { key: 'code', p: `${READONLY}\nGoal: ${goal}\nRead the code paths the recent ledger loops name (e.g. the GPU mid-mesh producer/draw in src/Graphics/MidMeshGpuExtractResources.*, src/Simulation/SparseClipmap.cpp BuildMidHeightSurfaceSnapshot, the main_launcher render/dispatch). Identify the precise function+line where the dominant cost lives and the minimal change that would reduce it without breaking the no-hole / bit-equal invariants.` },
    { key: 'history', p: `${READONLY}\nRead ${LEDGER} fully. Across loops, where has the cost RELOCATED, and what has REPEATEDLY failed (relocate-not-reduce, perturbs-streaming, etc.)? What class of fix has NOT yet been tried, and what trap must the next loop avoid (cite the failed loops)?` },
    { key: 'risk', p: `${READONLY}\n${TRUSTED}\nGoal: ${goal}\nWhat is the no-hole / quality / regression risk of the obvious next change, and what is the cheapest VALID gate to catch it (within-noise visual vs baseline run-to-run, multi-run FRAMETIME, visibleMissing, bit-equal)? Name the specific failure modes to test.` },
  ]
  const reads = (await parallel(angles.map(a => () =>
    agent(a.p, { label: `diagnose:${a.key}`, phase: 'Diagnose' }).then(t => ({ key: a.key, t }))
  ))).filter(Boolean)

  const lever = await agent(`${READONLY}\n${TRUSTED}\nGoal: ${goal}\nFour independent read-only diagnoses follow. Synthesize them into ONE concrete, highest-leverage, SAFE lever for this loop, with a precise gate plan and an abandon condition. Be skeptical of optimism; prefer a bounded change with a clear measurable win + a hard no-hole gate.\n\n${reads.map(r => `### ${r.key}\n${r.t}`).join('\n\n')}`,
    { label: 'diagnose:synthesize', phase: 'Diagnose', schema: LEVER_SCHEMA })
  return lever
}

// ---------------------------------------------------------------------------
// PHASE 2 — IMPLEMENT (Codex via the tandem bridge, blocking)
// ---------------------------------------------------------------------------
async function implement(lever) {
  phase('Implement')
  const spec = `Loop (orchestration-layer driven), ENGINEERING LEAD. Read perf/LOOPS.md FULLY bottom-up (${LEDGER}). ${TRUSTED}\n\nGOAL: ${goal}\n\nDIAGNOSED LEVER (do this, push back only with evidence):\n- ${lever.lever}\nRATIONALE: ${lever.rationale}\nGATE PLAN: ${lever.gatePlan}\nRISK: ${lever.risk}\nABANDON IF: ${lever.abandonIf || 'no clear measured win or any hole'}\n\nImplement it flag-gated, verify the gate plan + the hard invariants (visibleMissing=0 every frame, bit-equal where applicable, within-noise visual vs baseline run-to-run NOT pixel-identity, multi-run >=3 FRAMETIME), commit ONLY your files (no AI attribution) if it passes, else revert + report exactly which gate failed. Append a '## Loop N (Codex, hash/abandoned)' entry to perf/LOOPS.md. Use the Claude helper (node tandem/bin/peer.mjs ask) to cross-check any no-hole/parity contract. Return your one-paragraph result + commit hash (or abandoned) + the residual.`

  // One agent drives Codex via the bridge. A single Bash call caps at ~10min but Codex
  // turns run 30-40min, so it MUST launch with --bg then poll-via-wait, never a blocking ask.
  const codexResult = await agent(`You are the tandem driver. Delegate ONE engineering turn to Codex and return its full result. cwd ${TANDEM} for bridge cmds; ${REPO} for git.\nPROCEDURE (do exactly this):\n1. Health: 'bash bin/ops.sh cleanup' (no-op if a codex turn is active), 'bash bin/ops.sh watch'. Record the baseline 'cd ${REPO} && git rev-parse --short HEAD'.\n2. Write the TASK below to a temp file and launch it backgrounded: 'cat > /tmp/codex_task.txt <<\\'EOF\\' ... EOF' then 'cd ${TANDEM} && node bin/peer.mjs new && node bin/peer.mjs ask --bg "$(cat /tmp/codex_task.txt)"'. (--bg returns immediately.)\n3. POLL until done — a single Bash call caps at 10min, so loop: run 'cd ${TANDEM} && timeout 560 node bin/peer.mjs wait' (blocks up to ~9min for the bg turn). After each, check 'cd ${REPO} && git rev-parse --short HEAD' (changed = committed) and 'grep -c "Loop .* (Codex" perf/LOOPS.md'. Repeat the wait up to ~6 times (≈55min) until HEAD changes OR a new Loop ledger entry appears OR codex procs drop to <2 (turn ended). Do NOT give up after one wait.\n4. Read Codex's result: 'cd ${TANDEM} && node bin/peer.mjs tail 6' (its final message) and the new 'git log --oneline -1' + the new '## Loop' entry tail from ${LEDGER}.\nReturn: Codex's verdict verbatim, the commit hash (or 'no commit / abandoned'), and whether Codex claims the gates passed.\n\n--- TASK FOR CODEX ---\n${spec}`,
    { label: 'implement:codex-tandem', phase: 'Implement' })
  return codexResult
}

// ---------------------------------------------------------------------------
// PHASE 3 — VERIFY (run gates once; parallel adversarial judges)
// ---------------------------------------------------------------------------
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['realWin', 'noHole', 'withinNoise', 'recommendation', 'evidence'],
  properties: {
    realWin: { type: 'boolean', description: 'did the targeted metric improve beyond run-to-run noise in a multi-run A/B?' },
    noHole: { type: 'boolean', description: 'visibleMissing=0 on every frame?' },
    withinNoise: { type: 'boolean', description: 'is the change-vs-baseline visual diff <= baseline run-to-run noise?' },
    bitEqual: { type: 'string', description: 'bit-equal status where applicable, or N/A' },
    recommendation: { type: 'string', enum: ['accept', 'revert', 'needs-more-measurement'] },
    evidence: { type: 'string', description: 'the concrete numbers backing the verdict' },
  },
}

async function verify(lever, codexResult) {
  phase('Verify')
  // One agent runs the gate measurements (serialized: build, multi-run FRAMETIME, captures, visibleMissing).
  const measured = await agent(`You are the VERIFICATION runner. A Codex turn just attempted: "${lever.lever}". Its report: ${String(codexResult).slice(0, 1500)}\nIndependently RUN the gates (Bash, cwd ${REPO}) — do NOT trust Codex's numbers (we have caught measurement artifacts before). Build if needed (_agent_build.bat). For the relevant replay(s): VENPOD_FRAMETIME_LOG=1 multi-run (>=3) A/B (flag OFF vs ON via the loop's flag) -> medians of p99/sub60/spike-body; check visibleMissing (must be all 0); if it touches the mid-mesh/surface, capture 3-4 spike frames flag-off-runA, flag-off-runB, flag-on, and report the pixel-diff%; if terrain math, VENPOD_TERRAIN_CHECKSUM. Save logs under build/bin. Report the RAW numbers (do not interpret): per-run p99/sub60, baseline A/B noise %, change-vs-baseline %, visibleMissing values, bit-equal lines. If the flag/feature was not committed (Codex abandoned), say so and report HEAD.`,
    { label: 'verify:run-gates', phase: 'Verify' })

  // Parallel adversarial judges on the raw measurements (read-only).
  const judges = ['no-hole', 'within-noise-visual', 'real-frametime-win', 'measurement-validity']
  const verdicts = (await parallel(judges.map(j => () =>
    agent(`${READONLY}\nYou are an adversarial judge for the lens: "${j}". Here are the RAW gate measurements:\n${measured}\nJudge ONLY your lens, skeptically. no-hole: are ALL visibleMissing values 0? within-noise-visual: is change-vs-baseline diff <= the baseline-A-vs-baseline-B noise? real-frametime-win: did the targeted metric drop beyond run-to-run variance across the >=3 runs (not a single lucky run / truncated log)? measurement-validity: are the logs complete (full frame count, >=2000 samples if profiled, NtWaitForSingleObject not dominating, not truncated)? Return PASS/FAIL for your lens + the numbers.`,
      { label: `verify:${j}`, phase: 'Verify' }).then(t => ({ j, t }))
  ))).filter(Boolean)

  const verdict = await agent(`${READONLY}\nSynthesize the adversarial verdict for the change "${lever.lever}". Raw measurements:\n${measured}\n\nJudge findings:\n${verdicts.map(v => `### ${v.j}\n${v.t}`).join('\n\n')}\n\nDecide accept/revert. Accept ONLY if: no holes (all visibleMissing=0) AND within-noise visual AND a real multi-run FRAMETIME win (or, for a foundation/no-op-by-design loop, no regression) AND valid (non-truncated) measurements. Default to revert/needs-more-measurement if any lens fails or the data is thin.`,
    { label: 'verify:verdict', phase: 'Verify', schema: VERDICT_SCHEMA })
  return { measured, verdict }
}

// ---------------------------------------------------------------------------
// DRIVER
// ---------------------------------------------------------------------------
const out = {}
if (!(args && args.skipDiagnose)) out.lever = await diagnose()
const lever = out.lever || { lever: leverHint || goal, rationale: '(supplied)', gatePlan: 'standard gates', risk: 'unknown', confidence: 'low' }
if (!(args && args.skipImplement)) out.codexResult = await implement(lever)
if (!(args && args.skipVerify)) out.verify = await verify(lever, out.codexResult || '(no implement phase)')
return out

# Dynamic-workflow + tandem orchestration layer

Two engines, one deterministic loop:

- **Claude Workflow agents** own everything *parallel-analyzable* — diagnosis, viability
  analysis, adversarial verification, code/correctness review. Fan-out + adversarial
  judging catch the blind spots a single turn misses (and have caught real measurement
  artifacts in this project — Loop 11's truncated-log "win", the invalid pixel-SHA gate).
- **Codex (tandem lead)** owns the *serialized* engineering. VENPOD builds/profiles cannot
  run in parallel ("Do NOT run two heavy builds at once"), so the heavy implement+build step
  is one Codex turn at a time, driven through the bridge.

```
            args.goal
                |
   Workflow ── Diagnose ──(parallel Claude, read-only)──> adversarial synthesis ─> ONE lever
                |
                Implement ──(one agent drives Codex via tandem/bin/peer.mjs ask, blocking)──> commit/report
                |
                Verify ──(one agent RUNS the gates; parallel Claude adversarially judge)──> accept | revert
```

## Run a loop

```
Workflow({ scriptPath: "z:/328/CMPUT328-A2/codexworks/301/tandem/workflows/perf-loop.mjs",
           args: { goal: "<the loop objective>", leverHint: "<optional steer>" } })
```

Sub-phase flags: `skipDiagnose`, `skipImplement`, `skipVerify` (e.g. diagnose-only viability runs).
Resume after editing the script: `Workflow({ scriptPath, resumeFromRunId })` — completed agents are cached.

## Non-negotiable gate discipline (baked into the agents)

- The **pixel-SHA visual gate is INVALID** — the engine is nondeterministic ~1-2%/frame. Compare
  change-vs-baseline against **baseline run-to-run noise**, never demand pixel-identity.
- Gate dips on a **multi-run (>=3) FRAMETIME A/B** + deterministic brick-counts, never a single run.
- The sampling profiler **deadlocks the flythrough** — use `VENPOD_FRAMETIME_LOG` there; profiler is
  safe on `mtns_edit`. `PERF_SPARSE_STEPS` buckets are inflated.
- **Never ship a hole**: `visibleMissing=0` every frame, CPU fallback for anything not GPU-ready.
- The watcher (top-level Claude) independently re-runs the decisive gate before trusting any commit.

## Ops helper

`tandem/bin/ops.sh` — `cleanup` (kill leaked node procs that caused fork-failures after ~25 loops,
relaunch watch), `reset` (fresh bridge session), `status` (git HEAD + proc counts). Run `cleanup`
between loops to keep the machine healthy.

## Ledger

All state is externalized to `3d/VENPOD/perf/LOOPS.md` — roles, trusted method, per-loop gates, and
the full loop log. The system survives context resets and reboots by reading it bottom-up.

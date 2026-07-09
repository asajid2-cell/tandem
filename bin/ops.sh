#!/usr/bin/env bash
# Orchestration-layer ops: keep the tandem + workflow machine healthy across long loop runs.
# Usage:  bash ops.sh {cleanup|reset|status|watch}
set -uo pipefail
TANDEM="z:/328/CMPUT328-A2/codexworks/301/tandem"
REPO="z:/328/CMPUT328-A2/codexworks/301/3d/VENPOD"
PS() { powershell.exe -NoProfile -Command "$1" 2>/dev/null | tr -d '\r'; }

procs() {
  PS "'node='+(Get-Process node -EA SilentlyContinue).Count+' codex='+(Get-Process codex -EA SilentlyContinue).Count+' VENPOD='+(Get-Process VENPOD -EA SilentlyContinue).Count+' ninja='+(Get-Process ninja -EA SilentlyContinue).Count"
}

watch_up() { PS "if(Get-NetTCPConnection -LocalPort 8799 -State Listen -EA SilentlyContinue){'up'}else{'down'}"; }

start_watch() {
  if [ "$(watch_up)" != "up" ]; then
    PS "Start-Process node -ArgumentList '$TANDEM/bin/watch.mjs' -WindowStyle Hidden; Start-Sleep 2; 'watch started'"
  else
    echo "watch already up (http://localhost:8799)"
  fi
}

case "${1:-status}" in
  cleanup)
    # Kill leaked node procs ONLY when there is no active Codex turn (codex<2 = idle daemon level).
    NC=$(PS "(Get-Process codex -EA SilentlyContinue).Count")
    if [ "${NC:-0}" -lt 2 ]; then
      PS "Get-Process node -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue; Start-Sleep 1; 'killed leaked node'"
      start_watch
    else
      echo "codex turn active (codex=$NC) — NOT killing node; rerun cleanup when idle"
    fi
    echo "procs: $(procs)"
    ;;
  reset)
    ( cd "$TANDEM" && node bin/peer.mjs new 2>&1 | tail -1 )
    ;;
  watch)
    start_watch ;;
  status)
    echo "HEAD: $(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null)  $(cd "$REPO" && git log --oneline -1 2>/dev/null | cut -c1-70)"
    echo "tree: $(cd "$REPO" && git status --short 2>/dev/null | grep -vE 'perf/(GPU_SURFACE|NEXT_LEVERS)' | wc -l) changed (excl notes)"
    echo "procs: $(procs)"
    echo "watch: $(watch_up)  (http://localhost:8799)"
    ;;
  *)
    echo "usage: bash ops.sh {cleanup|reset|status|watch}" ;;
esac

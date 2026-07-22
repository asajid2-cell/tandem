# Install the tandem skill so /tandem is available in any Claude Code session.
#   powershell -ExecutionPolicy Bypass -File install.ps1
# Copies SKILL.md into ~/.claude/skills/tandem/. The bridge + config stay in this
# repo (single source of truth); SKILL.md references them by absolute path.
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

# Best-effort re-vendor of the shared provider-policy package from the sibling orchestrate repo,
# so an install picks up the canonical limit-detection logic. Non-fatal: a standalone install (no
# sibling repo) runs from the committed vendored copy, and sync-shared.mjs no-ops when the source
# is absent. Never let a failed sync block installing the skill.
try {
  node (Join-Path $repo "bin\sync-shared.mjs")
} catch {
  Write-Host "tandem: shared-package sync skipped ($($_.Exception.Message)); using the committed vendored copy." -ForegroundColor DarkYellow
}

$dest = Join-Path $env:USERPROFILE ".claude\skills\tandem"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $repo "SKILL.md") (Join-Path $dest "SKILL.md") -Force
Write-Host "Installed tandem skill -> $dest" -ForegroundColor Green
Write-Host "Bridge: $repo\bin\peer.mjs"
Write-Host ""
Write-Host "Before using: ensure the partner never asks for permission." -ForegroundColor Yellow
Write-Host "  Codex:  ~/.codex/config.toml set to never-ask  (or posture 'yolo' in tandem.config.json)"
Write-Host "  Claude: run the partner with --dangerously-skip-permissions"
Write-Host ""
Write-Host "Smoke test:  node `"$repo\bin\peer.mjs`" ask `"Respond with exactly: PONG`""

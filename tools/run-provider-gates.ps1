param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[A-Za-z0-9._-]+$")]
    [string]$Tag
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stateRoot = Join-Path $root ".provider-neutral"
$artifactRoot = Join-Path $stateRoot "gates\$Tag"
$current = Join-Path $stateRoot "CURRENT.md"
$failed = Join-Path $stateRoot "CURRENT_FAILED.md"
New-Item -ItemType Directory -Force $artifactRoot | Out-Null

$gates = @(
    @{
        name = "apex-live"
        command = @("node", "--test", "--test-concurrency=1", "test/apex-gate-live.test.mjs")
    },
    @{
        name = "provider-custody"
        command = @("node", "--test", "--test-concurrency=1", "test/provider-custody.test.mjs")
    },
    @{
        name = "apex-regression"
        command = @(
            "node",
            "--test",
            "--test-concurrency=1",
            "test/apex-gate.test.mjs",
            "test/apex-refresh.test.mjs",
            "test/apex-memory.test.mjs"
        )
    }
)

$results = @()
$allPassed = $true
foreach ($gate in $gates) {
    $log = Join-Path $artifactRoot "$($gate.name).log"
    Push-Location $root
    try {
        $exe = $gate.command[0]
        $argv = @($gate.command | Select-Object -Skip 1)
        $output = @(& $exe @argv 2>&1)
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    [IO.File]::WriteAllLines($log, @($output), [Text.UTF8Encoding]::new($false))
    $passed = $exit -eq 0
    if (-not $passed) { $allPassed = $false }
    $results += [ordered]@{
        name = $gate.name
        passed = $passed
        exit_code = $exit
        log = $log
    }
}

$head = (& git -C $root rev-parse HEAD).Trim()
$status = @(
    & git -C $root status --porcelain=v1 --untracked-files=all -- . ":(exclude).provider-neutral"
)
$timestamp = [DateTimeOffset]::UtcNow.ToString("o")
$lines = @(
    "# Provider-Neutral Campaign State",
    "",
    '> MACHINE-OWNED. Written only by `tools/run-provider-gates.ps1`.',
    "",
    "tag: $Tag",
    "timestamp_utc: $timestamp",
    "head: $head",
    "tree_clean: $($status.Count -eq 0)",
    "",
    "## Gates"
)
foreach ($result in $results) {
    $lines += "- $($result.name): $(if ($result.passed) { 'PASS' } else { 'FAIL' }) (exit $($result.exit_code)); $($result.log)"
}
$lines += @("", "## Working Tree", "")
$lines += if ($status.Count) { $status | ForEach-Object { "- $_" } } else { "- clean" }
$lines += ""

$target = if ($allPassed) { $current } else { $failed }
New-Item -ItemType Directory -Force $stateRoot | Out-Null
[IO.File]::WriteAllLines($target, $lines, [Text.UTF8Encoding]::new($false))
if ($allPassed) {
    if (Test-Path $failed) { Remove-Item -LiteralPath $failed }
    Write-Host "PASS $Tag"
    exit 0
}
Write-Host "FAIL $Tag"
exit 1

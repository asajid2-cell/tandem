# spawn-shim.ps1 — decide whether a detached worker spawned by the CALLING
# process would be reaped with the caller's Windows Job Object, and if so,
# launch it outside the job chain.
#
# This shim is itself a child of the caller, so its own job membership IS the
# measurement: if this process sits in any job, so would a plainly spawned
# worker (DETACHED_PROCESS does not leave a job), and a kill-on-close job would
# take the worker down when the caller's tool call ends. Flag introspection is
# not trustworthy here — with nested jobs, QueryInformationJobObject(NULL) only
# describes one job in the chain, and CREATE_BREAKAWAY_FROM_JOB "succeeds"
# while silently leaving the child inside any job that forbids breakaway. The
# only reliable escape is to have a process OUTSIDE the chain do the spawning:
# Win32_Process.Create runs in the WMI provider host, which is not in the
# caller's jobs, so the process it creates is free of them.
#
# Prints exactly one line:
#   mode=direct              caller is jobless — a plain detached spawn is safe
#   mode=wmi pid=<n>         bootstrap launched outside the job chain (pid = bootstrap)
#   mode=error err=<detail>  escape unavailable — caller should degrade loudly
param(
  [Parameter(Mandatory = $true)][string]$Spec
)
$ErrorActionPreference = "Stop"
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobCheck {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  public static bool InAnyJob() {
    bool inJob;
    if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob)) return true; // fail closed: assume jailed
    return inJob;
  }
}
'@
  if (-not [JobCheck]::InAnyJob()) {
    "mode=direct"
    exit 0
  }
  # NB: a different variable name than the $Spec parameter — PowerShell
  # variables are case-insensitive, so `$spec = ...` would overwrite it
  $parsed = Get-Content -LiteralPath $Spec -Raw | ConvertFrom-Json
  # the legacy WMI accessor: PowerShell 5.1's Invoke-CimMethod rejects an
  # embedded Win32_ProcessStartup (rv=21 invalid parameter); [wmiclass] passes
  # it correctly, and ShowWindow=0 keeps the bootstrap console hidden
  $startupClass = [wmiclass]"Win32_ProcessStartup"
  $startup = $startupClass.CreateInstance()
  $startup.ShowWindow = 0
  $commandLine = "`"$($parsed.node)`" `"$($parsed.bootstrap)`" `"$Spec`""
  $processClass = [wmiclass]"Win32_Process"
  $result = $processClass.Create($commandLine, $parsed.cwd, $startup)
  if ($result.ReturnValue -eq 0) {
    "mode=wmi pid=$($result.ProcessId)"
  } else {
    "mode=error err=wmi-returned-$($result.ReturnValue)"
  }
} catch {
  "mode=error err=$($_.Exception.Message -replace '\s+', ' ')"
}

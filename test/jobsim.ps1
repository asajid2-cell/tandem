# jobsim.ps1 — run a command INSIDE a Windows Job Object with the given limit
# flags, wait for it to exit, then close the job handle. With
# JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) and no breakaway flags this
# recreates the environment a nested agent harness imposes on its tool calls:
# every process still in the job when the handle closes is terminated.
#
# Usage:
#   powershell -File jobsim.ps1 -Flags 0x2000 -Cwd C:\dir -CommandLine "node x.mjs"
#
# Prints "childExit=<code>" on success. Exit code 0 unless setup failed.
param(
  [Parameter(Mandatory = $true)][string]$CommandLine,
  [string]$Cwd = (Get-Location).Path,
  [string]$Flags = "0x2000",
  [int]$TimeoutMs = 120000,
  [int]$LingerMs = 0   # keep the job handle open this long AFTER the child exits
)
$ErrorActionPreference = "Stop"
$limitFlags = [Convert]::ToUInt32($Flags, 16)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JobSim {
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
    public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmdline, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr hThread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);

  const uint CREATE_SUSPENDED = 0x4;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;

  // Run cmdline suspended, assign it to a fresh job with limitFlags, resume,
  // wait for exit, optionally linger, then close the job handle. Returns the
  // child's exit code, or throws on setup failure. -1 => wait timed out
  // (child killed with the job on close anyway).
  public static int Run(string cmdline, string cwd, uint limitFlags, int timeoutMs, int lingerMs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.Basic.LimitFlags = limitFlags;
    if (!SetInformationJobObject(job, 9 /*ExtendedLimitInformation*/, ref info, Marshal.SizeOf(info)))
      throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi;
    // BREAKAWAY here detaches the direct child from jobsim's OWN inherited job
    // (the test runner's harness job) so the fresh job below is its only job —
    // otherwise the child sits in [harness job + fresh job] and the harness
    // job's silent-breakaway flag would leak into what we mean to simulate.
    // If the harness job forbids breakaway, retry without the flag (the fresh
    // job then nests under it, which still enforces our restrictive flags).
    if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, cwd, ref si, out pi)) {
      if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
          CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    }
    if (!AssignProcessToJobObject(job, pi.hProcess))
      throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    ResumeThread(pi.hThread);
    uint waited = WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
    uint code = 0;
    GetExitCodeProcess(pi.hProcess, out code);
    if (lingerMs > 0) System.Threading.Thread.Sleep(lingerMs);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    CloseHandle(job); // KILL_ON_JOB_CLOSE reaps every process still in the job
    return waited == 0 ? (int)code : -1;
  }
}
'@

$code = [JobSim]::Run($CommandLine, $Cwd, $limitFlags, $TimeoutMs, $LingerMs)
"childExit=$code"

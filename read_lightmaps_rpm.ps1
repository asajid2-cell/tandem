param(
    [int]$TargetPid = 151988
)

$ErrorActionPreference = "Stop"

$src = @"
using System;
using System.Runtime.InteropServices;

public static class Native {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 pid);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buffer, UInt32 size, out UIntPtr read);

    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, UIntPtr len);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public UInt32 AllocationProtect;
        public UIntPtr RegionSize;
        public UInt32 State;
        public UInt32 Protect;
        public UInt32 Type;
    }
}
"@
Add-Type -TypeDefinition $src

$PROCESS_QUERY_INFORMATION = 0x0400
$PROCESS_VM_READ = 0x0010
$MEM_COMMIT = 0x1000
$PAGE_GUARD = 0x100
$PAGE_NOACCESS = 0x01
$PAGE_READABLE_MASK = 0x02 -bor 0x04 -bor 0x08 -bor 0x20 -bor 0x40 -bor 0x80

$h = [Native]::OpenProcess($PROCESS_QUERY_INFORMATION -bor $PROCESS_VM_READ, $false, [uint32]$TargetPid)
if ($h -eq [IntPtr]::Zero) {
    throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

function Is-ReadableProtect([uint32]$protect) {
    if (($protect -band $PAGE_GUARD) -ne 0) { return $false }
    if (($protect -band $PAGE_NOACCESS) -ne 0) { return $false }
    return (($protect -band $PAGE_READABLE_MASK) -ne 0)
}

function Read-Bytes([uint32]$addr, [int]$size) {
    if ($addr -eq 0 -or $size -le 0) { return $null }
    $buf = New-Object byte[] $size
    $read = [UIntPtr]::Zero
    $ok = [Native]::ReadProcessMemory($h, [IntPtr]([int64]$addr), $buf, [uint32]$size, [ref]$read)
    if (-not $ok -or $read.ToUInt64() -eq 0) { return $null }
    if ($read.ToUInt64() -lt [uint64]$size) {
        $short = New-Object byte[] ([int]$read.ToUInt64())
        [Array]::Copy($buf, $short, $short.Length)
        return $short
    }
    return $buf
}

function Read-U32([uint32]$addr) {
    $b = Read-Bytes $addr 4
    if ($null -eq $b -or $b.Length -lt 4) { return $null }
    return [BitConverter]::ToUInt32($b, 0)
}

function Read-CString([uint32]$addr, [int]$max = 256) {
    $b = Read-Bytes $addr $max
    if ($null -eq $b) { return $null }
    $n = [Array]::IndexOf($b, [byte]0)
    if ($n -lt 0) { $n = $b.Length }
    if ($n -eq 0) { return "" }
    return [Text.Encoding]::ASCII.GetString($b, 0, $n)
}

function Enum-Regions {
    $addr = [uint64]0x10000
    $limit = [uint64]0x7fff0000
    while ($addr -lt $limit) {
        $mbi = New-Object Native+MEMORY_BASIC_INFORMATION
        $mbiSize = [UIntPtr]::new([uint64][Runtime.InteropServices.Marshal]::SizeOf([type][Native+MEMORY_BASIC_INFORMATION]))
        $res = [Native]::VirtualQueryEx($h, [IntPtr]([int64]$addr), [ref]$mbi, $mbiSize)
        if ($res.ToUInt64() -eq 0) {
            $addr += 0x10000
            continue
        }
        $base = [uint64]$mbi.BaseAddress.ToInt64()
        $size = [uint64]$mbi.RegionSize.ToUInt64()
        if ($mbi.State -eq $MEM_COMMIT -and (Is-ReadableProtect $mbi.Protect)) {
            [pscustomobject]@{ Base = $base; Size = $size; Protect = $mbi.Protect }
        }
        $next = $base + $size
        if ($next -le $addr) { $addr += 0x10000 } else { $addr = $next }
    }
}

function Find-PatternInRegions([byte[]]$needle) {
    $hits = New-Object System.Collections.Generic.List[uint32]
    $chunkSize = 4MB
    foreach ($r in Enum-Regions) {
        $offset = [uint64]0
        $overlap = [Math]::Max(0, $needle.Length - 1)
        $prevTail = New-Object byte[] 0
        while ($offset -lt $r.Size) {
            $take = [int][Math]::Min([uint64]$chunkSize, $r.Size - $offset)
            $buf = Read-Bytes ([uint32]($r.Base + $offset)) $take
            if ($null -eq $buf) {
                $offset += [uint64]$take
                $prevTail = New-Object byte[] 0
                continue
            }
            if ($prevTail.Length -gt 0) {
                $combo = New-Object byte[] ($prevTail.Length + $buf.Length)
                [Array]::Copy($prevTail, 0, $combo, 0, $prevTail.Length)
                [Array]::Copy($buf, 0, $combo, $prevTail.Length, $buf.Length)
                $scan = $combo
                $scanBase = [int64]($r.Base + $offset - [uint64]$prevTail.Length)
            } else {
                $scan = $buf
                $scanBase = [int64]($r.Base + $offset)
            }
            for ($i = 0; $i -le $scan.Length - $needle.Length; $i++) {
                $match = $true
                for ($j = 0; $j -lt $needle.Length; $j++) {
                    if ($scan[$i + $j] -ne $needle[$j]) { $match = $false; break }
                }
                if ($match) { $hits.Add([uint32]($scanBase + $i)) }
            }
            $tailLen = [Math]::Min($overlap, $buf.Length)
            $prevTail = New-Object byte[] $tailLen
            if ($tailLen -gt 0) { [Array]::Copy($buf, $buf.Length - $tailLen, $prevTail, 0, $tailLen) }
            $offset += [uint64]$take
        }
    }
    return $hits
}

function Find-AlignedDwordRefs([uint32[]]$values) {
    $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($v in $values) { [void]$set.Add($v) }
    $refs = New-Object System.Collections.Generic.List[object]
    $chunkSize = 4MB
    foreach ($r in Enum-Regions) {
        $offset = [uint64]0
        while ($offset -lt $r.Size) {
            $take = [int][Math]::Min([uint64]$chunkSize, $r.Size - $offset)
            $addr = [uint32]($r.Base + $offset)
            $buf = Read-Bytes $addr $take
            if ($null -eq $buf) {
                $offset += [uint64]$take
                continue
            }
            for ($i = 0; $i -le $buf.Length - 4; $i += 4) {
                $v = [BitConverter]::ToUInt32($buf, $i)
                if ($set.Contains($v)) {
                    $refs.Add([pscustomobject]@{ Ref = [uint32]($addr + $i); Value = $v })
                }
            }
            $offset += [uint64]$take
        }
    }
    return $refs
}

try {
    $targets = @(
        "maps/mp/zm_cosmodrome.d3dbsp",
        "maps/mp/zm_cosmodrome",
        "zm_cosmodrome.d3dbsp",
        "zm_cosmodrome",
        "cosmodrome"
    )
    Write-Host "PID=$TargetPid scanning for cosmodrome name variants"
    $strings = New-Object System.Collections.Generic.List[uint32]
    foreach ($target in $targets) {
        $needle = [Text.Encoding]::ASCII.GetBytes($target)
        $hitsForTarget = @(Find-PatternInRegions $needle)
        Write-Host ("String hits for '{0}': {1}" -f $target, (($hitsForTarget | ForEach-Object { "0x{0:x8}" -f $_ }) -join ", "))
        foreach ($hit in $hitsForTarget) { $strings.Add($hit) }
    }
    $strings = @($strings | Sort-Object -Unique)
    if ($strings.Count -eq 0) { throw "BSP name string not found" }

    Write-Host "Scanning aligned DWORD references to string hit(s)"
    $refs = @(Find-AlignedDwordRefs ([uint32[]]$strings))
    Write-Host "Pointer refs found: $($refs.Count)"

    $valid = New-Object System.Collections.Generic.List[object]
    foreach ($ref in $refs) {
        $cand = [uint32]$ref.Ref
        $namePtr = Read-U32 $cand
        $count = Read-U32 ([uint32]($cand + 0x198))
        if ($null -eq $count -or $count -lt 1 -or $count -gt 16) { continue }
        $lm = Read-U32 ([uint32]($cand + 0x19c))
        $rtP = Read-U32 ([uint32]($cand + 0x1a0))
        $rtS = Read-U32 ([uint32]($cand + 0x1a4))
        if ($null -eq $lm -or $lm -eq 0 -or $null -eq $rtS -or $rtS -eq 0) { continue }
        $secondary0 = Read-U32 ([uint32]($lm + 4))
        if ($null -eq $secondary0 -or $secondary0 -eq 0) { continue }
        $secNamePtr = Read-U32 ([uint32]($secondary0 + 0x48))
        $secName = if ($secNamePtr) { Read-CString $secNamePtr 128 } else { $null }
        if ($secName -and $secName.Contains("lightmap")) {
            $valid.Add([pscustomobject]@{
                GfxWorld = $cand
                NamePtr = $namePtr
                Count = $count
                Lightmaps = $lm
                RtPrimary = $rtP
                RtSecondary = $rtS
                Secondary0Name = $secName
            })
        }
    }

    if ($valid.Count -eq 0) {
        Write-Host "No fully validated candidate. Raw refs near possible candidates:"
        $refs | Select-Object -First 32 | ForEach-Object {
            $cand = [uint32]$_.Ref
            $count = Read-U32 ([uint32]($cand + 0x198))
            "{0:x8}: namePtr={1:x8} count@+198={2}" -f $cand, $_.Value, $count
        } | Write-Host
        throw "Could not validate GfxWorld"
    }

    foreach ($gw in $valid) {
        Write-Host ("`nVALID_GFXWORLD=0x{0:x8} namePtr=0x{1:x8} count={2} lightmaps=0x{3:x8} rtPrimary=0x{4:x8} rtSecondary=0x{5:x8}" -f $gw.GfxWorld, $gw.NamePtr, $gw.Count, $gw.Lightmaps, $gw.RtPrimary, $gw.RtSecondary)
        for ($i = 0; $i -lt $gw.Count; $i++) {
            $primary = Read-U32 ([uint32]($gw.Lightmaps + $i * 8))
            $secondary = Read-U32 ([uint32]($gw.Lightmaps + $i * 8 + 4))
            $sSrv = if ($secondary) { Read-U32 $secondary } else { $null }
            $rtSecVal = Read-U32 ([uint32]($gw.RtSecondary + $i * 4))
            $namePtr = if ($secondary) { Read-U32 ([uint32]($secondary + 0x48)) } else { $null }
            $name = if ($namePtr) { Read-CString $namePtr 160 } else { "" }
            $pSrv = if ($primary) { Read-U32 $primary } else { $null }
            $rtPrimVal = if ($gw.RtPrimary) { Read-U32 ([uint32]($gw.RtPrimary + $i * 4)) } else { $null }
            Write-Host ("LM[{0}] sImg=0x{1:x8} sImgSRV=0x{2:x8} rtSec=0x{3:x8} pImg=0x{4:x8} pImgSRV=0x{5:x8} rtPrim=0x{6:x8} name='{7}'" -f $i, $secondary, $sSrv, $rtSecVal, $primary, $pSrv, $rtPrimVal, $name)
        }
    }
}
finally {
    if ($h -ne [IntPtr]::Zero) { [void][Native]::CloseHandle($h) }
}

# imgstats.ps1 — verifier substrate for the graphics loops.
# Region stats (mean luma, mean RGB, RMS contrast) and optional A/B mean-abs delta.
# Region is "x,y,w,h" in FRACTIONS of width/height (0..1). Omit for whole image.
#   pwsh imgstats.ps1 -A render.png
#   pwsh imgstats.ps1 -A render.png -Region "0.55,0.2,0.3,0.5"
#   pwsh imgstats.ps1 -A on.png -B off.png -Region "0.55,0.2,0.3,0.5"   # differential
param(
  [Parameter(Mandatory=$true)][string]$A,
  [string]$B = "",
  [string]$Region = "",
  [switch]$Json
)
Add-Type -AssemblyName System.Drawing

function Get-Pixels([string]$path) {
  $img = [System.Drawing.Image]::FromFile($path)
  $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose(); $img.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $w = $bmp.Width; $h = $bmp.Height; $stride = $data.Stride; $bmp.Dispose()
  return @{ bytes=$bytes; w=$w; h=$h; stride=$stride }
}

function Region-Rect($w, $h, $region) {
  if ([string]::IsNullOrWhiteSpace($region)) { return @(0,0,$w,$h) }
  $p = $region.Split(','); $fx=[double]$p[0]; $fy=[double]$p[1]; $fw=[double]$p[2]; $fh=[double]$p[3]
  $x=[int]($fx*$w); $y=[int]($fy*$h); $rw=[int]($fw*$w); $rh=[int]($fh*$h)
  if ($x -lt 0){$x=0}; if ($y -lt 0){$y=0}
  if ($x+$rw -gt $w){$rw=$w-$x}; if ($y+$rh -gt $h){$rh=$h-$y}
  return @($x,$y,$rw,$rh)
}

function Stats($px, $region) {
  $r = Region-Rect $px.w $px.h $region
  $x0=$r[0]; $y0=$r[1]; $rw=$r[2]; $rh=$r[3]
  $b=$px.bytes; $stride=$px.stride
  $n=0; $sR=0.0; $sG=0.0; $sB=0.0; $sL=0.0; $sL2=0.0
  for ($y=$y0; $y -lt ($y0+$rh); $y++) {
    $row = $y*$stride
    for ($x=$x0; $x -lt ($x0+$rw); $x++) {
      $i = $row + $x*4
      $bl=$b[$i]; $gr=$b[$i+1]; $rd=$b[$i+2]
      $lum = 0.2126*$rd + 0.7152*$gr + 0.0722*$bl
      $sR+=$rd; $sG+=$gr; $sB+=$bl; $sL+=$lum; $sL2+=($lum*$lum); $n++
    }
  }
  if ($n -eq 0){ return @{n=0} }
  $mL=$sL/$n; $var=($sL2/$n)-($mL*$mL); if ($var -lt 0){$var=0}
  return @{ n=$n; meanR=[math]::Round($sR/$n,2); meanG=[math]::Round($sG/$n,2); meanB=[math]::Round($sB/$n,2);
            meanLuma=[math]::Round($mL,2); rmsContrast=[math]::Round([math]::Sqrt($var),2); region=($region) }
}

function Delta($pa, $pb, $region) {
  $r = Region-Rect $pa.w $pa.h $region
  $x0=$r[0]; $y0=$r[1]; $rw=$r[2]; $rh=$r[3]
  $a=$pa.bytes; $bb=$pb.bytes; $sa=$pa.stride; $sb=$pb.stride
  $n=0; $sumAbs=0.0; $sumLumaAbs=0.0; $maxAbs=0
  for ($y=$y0; $y -lt ($y0+$rh); $y++) {
    $ra=$y*$sa; $rbb=$y*$sb
    for ($x=$x0; $x -lt ($x0+$rw); $x++) {
      $ia=$ra+$x*4; $ib=$rbb+$x*4
      $dB=[math]::Abs([int]$a[$ia]-[int]$bb[$ib]); $dG=[math]::Abs([int]$a[$ia+1]-[int]$bb[$ib+1]); $dR=[math]::Abs([int]$a[$ia+2]-[int]$bb[$ib+2])
      $dAvg=($dR+$dG+$dB)/3.0
      $la=0.2126*$a[$ia+2]+0.7152*$a[$ia+1]+0.0722*$a[$ia]; $lb=0.2126*$bb[$ib+2]+0.7152*$bb[$ib+1]+0.0722*$bb[$ib]
      $sumAbs+=$dAvg; $sumLumaAbs+=[math]::Abs($la-$lb); $n++
      if ($dR -gt $maxAbs){$maxAbs=$dR}; if ($dG -gt $maxAbs){$maxAbs=$dG}; if ($dB -gt $maxAbs){$maxAbs=$dB}
    }
  }
  if ($n -eq 0){ return @{n=0} }
  return @{ n=$n; meanAbsDelta=[math]::Round($sumAbs/$n,3); meanLumaDelta=[math]::Round($sumLumaAbs/$n,3); maxChannelDelta=$maxAbs; region=($region) }
}

$pa = Get-Pixels $A
$out = @{ A=$A; w=$pa.w; h=$pa.h; statsA=(Stats $pa $Region) }
if ($B -ne "") {
  $pb = Get-Pixels $B
  $out.B = $B; $out.statsB = (Stats $pb $Region); $out.delta = (Delta $pa $pb $Region)
}
if ($Json) { $out | ConvertTo-Json -Depth 5 -Compress }
else {
  "A: $A  ${($pa.w)}x$($pa.h)"
  $sA=$out.statsA; "  statsA[$($sA.region)]  luma=$($sA.meanLuma)  rms=$($sA.rmsContrast)  rgb=($($sA.meanR),$($sA.meanG),$($sA.meanB))  n=$($sA.n)"
  if ($B -ne "") {
    $sB2=$out.statsB; "  statsB[$($sB2.region)]  luma=$($sB2.meanLuma)  rms=$($sB2.rmsContrast)  rgb=($($sB2.meanR),$($sB2.meanG),$($sB2.meanB))"
    $d=$out.delta; "  DELTA  meanAbs=$($d.meanAbsDelta)  meanLuma=$($d.meanLumaDelta)  maxChan=$($d.maxChannelDelta)  n=$($d.n)"
  }
}

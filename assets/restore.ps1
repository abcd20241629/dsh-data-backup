# =====================================================================
#  DSH data backup - restore script
#  This file lives next to the backup folders. It is self-contained:
#  it reads _manifests\<id>.json and copies files back where they came
#  from. You do NOT need DSH installed to run it.
#
#  Written in pure ASCII on purpose, so it runs in any PowerShell
#  regardless of console code page.
#
#  USAGE (recommended: close DSH first):
#    powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -List
#    powershell -ExecutionPolicy Bypass -File .\_restore.ps1
#    powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -Snapshot 2026-11-21_030000
#    powershell -ExecutionPolicy Bypass -File .\_restore.ps1 -DryRun
#
#  What it does, in this order:
#    1. copies everything it is about to overwrite into
#       _before-restore\<id>_<timestamp>\   (the undo button)
#    2. copies the snapshot content back over the live paths
#       (merge style: same-name files replaced, extra live files kept)
#    3. tells you which items worked and which did not
#
#  Merge style is deliberate: worst case is "not fully restored",
#  never "new files silently deleted".
# =====================================================================

[CmdletBinding()]
param(
  [string]$Snapshot = '',
  [switch]$DryRun,
  [switch]$List
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestDir = Join-Path $Root '_manifests'

function Write-Head([string]$Text) {
  Write-Host ''
  Write-Host ('=' * 68) -ForegroundColor DarkCyan
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ('=' * 68) -ForegroundColor DarkCyan
}

function Stamp() {
  return (Get-Date).ToString('yyyyMMdd-HHmmss')
}

function Get-Snapshots {
  if (-not (Test-Path $ManifestDir)) { return @() }
  $out = @()
  Get-ChildItem -Path $ManifestDir -Filter '*.json' -File | Sort-Object Name -Descending | ForEach-Object {
    $out += [pscustomobject]@{
      Id   = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
      File = $_.FullName
    }
  }
  return $out
}

# ---------------- list ----------------

if ($List) {
  $snaps = Get-Snapshots
  Write-Head 'Available snapshots'
  if ($snaps.Count -eq 0) {
    Write-Host '  (none found in _manifests)' -ForegroundColor Yellow
    exit 0
  }
  foreach ($s in $snaps) {
    $status = '?'
    $files = '?'
    $bytes = '?'
    try {
      $m = Get-Content -Path $s.File -Raw -Encoding UTF8 | ConvertFrom-Json
      $status = [string]$m.status
      if ($m.totals) {
        $files = [string]$m.totals.files
        $bytes = [string]$m.totals.bytes
      }
    } catch { }
    $mb = ''
    if ($bytes -ne '?' -and [double]$bytes -gt 0) {
      $mb = ('{0:N1} MB' -f ([double]$bytes / 1MB))
    }
    Write-Host ("  {0}   status={1,-9} files={2,-7} {3}" -f $s.Id, $status, $files, $mb)
  }
  Write-Host ''
  Write-Host '  restore the newest one:  .\_restore.ps1' -ForegroundColor Gray
  Write-Host '  restore a specific one:  .\_restore.ps1 -Snapshot <id>' -ForegroundColor Gray
  exit 0
}

# ---------------- pick snapshot ----------------

$snaps = Get-Snapshots
if ($snaps.Count -eq 0) {
  Write-Head 'Nothing to restore'
  Write-Host '  No manifests found under _manifests.' -ForegroundColor Yellow
  exit 1
}

if ([string]::IsNullOrWhiteSpace($Snapshot)) {
  $Snapshot = $snaps[0].Id
  Write-Host "No -Snapshot given, using the newest one: $Snapshot" -ForegroundColor Yellow
}

$mFile = Join-Path $ManifestDir ($Snapshot + '.json')
if (-not (Test-Path $mFile)) {
  Write-Head 'Snapshot not found'
  Write-Host "  Missing manifest: $mFile" -ForegroundColor Red
  Write-Host '  Run with -List to see what is available.' -ForegroundColor Gray
  exit 1
}

$m = Get-Content -Path $mFile -Raw -Encoding UTF8 | ConvertFrom-Json
$targets = @($m.targets)
if ($targets.Count -eq 0) {
  Write-Head 'Cannot restore'
  Write-Host '  This manifest has no targets (old format or a failed backup).' -ForegroundColor Red
  exit 1
}

# ---------------- confirm ----------------

Write-Head "Restore snapshot $Snapshot"
Write-Host "  manifest : $mFile"
Write-Host "  created  : $($m.finishedAt)"
Write-Host "  status   : $($m.status)"
Write-Host "  items    : $($targets.Count)"
if ($DryRun) { Write-Host '  MODE     : DRY RUN (nothing will be written)' -ForegroundColor Yellow }
Write-Host ''
foreach ($t in $targets) {
  Write-Host ("   {0,-24} -> {1}" -f $t.snapRel, $t.dest) -ForegroundColor Gray
}
Write-Host ''
if (-not $DryRun) {
  Write-Host '  Close DSH before restoring, otherwise running sessions may fight the copy.' -ForegroundColor Yellow
  $ans = Read-Host '  Type YES to continue'
  if ($ans -ne 'YES') { Write-Host '  cancelled.' -ForegroundColor Yellow; exit 0 }
}

# ---------------- 1) safety copy ----------------

$SafetyDir = Join-Path (Join-Path $Root '_before-restore') ($Snapshot + '_' + (Stamp()))
$safetyOk = 0
$safetyFail = 0

if (-not $DryRun) {
  New-Item -ItemType Directory -Path $SafetyDir -Force | Out-Null
  Write-Host ''
  Write-Host '  [1/2] safety copy of what is about to be replaced ...' -ForegroundColor Cyan
  foreach ($t in $targets) {
    $dest = [string]$t.dest
    if ([string]::IsNullOrWhiteSpace($dest) -or $t.kind -eq 'generated') { continue }
    if (-not (Test-Path $dest)) { continue }
    $safeName = ($dest -replace '[\\/:]', '_')
    $sub = Join-Path $SafetyDir $safeName
    try {
      New-Item -ItemType Directory -Path $sub -Force | Out-Null
      $item = Get-Item -Path $dest
      if ($item.PSIsContainer) {
        Copy-Item -Path (Join-Path $dest '*') -Destination $sub -Recurse -Force -ErrorAction Stop
      } else {
        Copy-Item -Path $dest -Destination $sub -Force -ErrorAction Stop
      }
      $safetyOk += 1
      Write-Host "        ok   $dest" -ForegroundColor DarkGray
    } catch {
      $safetyFail += 1
      Write-Host "        FAIL $dest  -- $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  Write-Host ("        safety copy: {0} ok, {1} failed" -f $safetyOk, $safetyFail)
  if ($safetyOk -eq 0 -and $safetyFail -gt 0) {
    Write-Host '  Safety copy failed for everything. Refusing to overwrite live data.' -ForegroundColor Red
    Write-Host '  Check file permissions, then retry.' -ForegroundColor Yellow
    exit 1
  }
}

# ---------------- 2) copy back ----------------

Write-Host ''
Write-Host '  [2/2] copying snapshot back ...' -ForegroundColor Cyan

$totalFiles = 0
$okItems = 0
$badItems = 0
$report = @()

foreach ($t in $targets) {
  $rel = [string]$t.snapRel
  $parts = $rel -split '/'
  $snapDir = Join-Path $Root ($parts -join '\')
  $dest = [string]$t.dest

  if ($t.kind -eq 'generated') {
    Write-Host "        SKIP $rel  (generated list, view only)" -ForegroundColor DarkGray
    $report += [pscustomobject]@{ Target = $rel; Status = 'skipped-generated'; Files = 0 }
    continue
  }

  if (-not (Test-Path $snapDir)) {
    Write-Host "        SKIP $rel  (not in snapshot)" -ForegroundColor DarkYellow
    $badItems += 1
    $report += [pscustomobject]@{ Target = $dest; Status = 'missing-in-snapshot'; Files = 0 }
    continue
  }

  if ($DryRun) {
    $n = (Get-ChildItem -Path $snapDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    $totalFiles += $n
    Write-Host "        WOULD restore $n file(s) -> $dest" -ForegroundColor Gray
    $report += [pscustomobject]@{ Target = $dest; Status = 'dry-run'; Files = $n }
    continue
  }

  try {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $files = Get-ChildItem -Path $snapDir -Recurse -File -ErrorAction SilentlyContinue
    $n = 0
    foreach ($f in $files) {
      $relInside = $f.FullName.Substring($snapDir.Length).TrimStart('\')
      $target = Join-Path $dest $relInside
      $targetParent = Split-Path -Parent $target
      if (-not (Test-Path $targetParent)) {
        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
      }
      Copy-Item -Path $f.FullName -Destination $target -Force -ErrorAction Stop
      $n += 1
    }
    $totalFiles += $n
    $okItems += 1
    Write-Host ("        ok   {0,5} file(s) -> {1}" -f $n, $dest) -ForegroundColor DarkGray
    $report += [pscustomobject]@{ Target = $dest; Status = 'ok'; Files = $n }
  } catch {
    $badItems += 1
    Write-Host "        FAIL $dest  -- $($_.Exception.Message)" -ForegroundColor Red
    $report += [pscustomobject]@{ Target = $dest; Status = 'failed'; Files = 0; Error = $_.Exception.Message }
  }
}

# ---------------- summary ----------------

Write-Head 'Result'
Write-Host ("  files copied : {0}" -f $totalFiles)
Write-Host ("  items ok     : {0}" -f $okItems)
if ($badItems -gt 0) {
  Write-Host ("  items failed : {0}" -f $badItems) -ForegroundColor Yellow
}
if (-not $DryRun) {
  Write-Host ("  undo dir     : {0}" -f $SafetyDir) -ForegroundColor Gray
  $reportPath = Join-Path (Join-Path $Root '_state') ('restore-' + (Stamp()) + '.json')
  New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
  $report | ConvertTo-Json -Depth 4 | Set-Content -Path $reportPath -Encoding UTF8
  Write-Host ("  report       : {0}" -f $reportPath) -ForegroundColor Gray
  Write-Host ''
  Write-Host '  Done. Now start DSH again.' -ForegroundColor Green
  Write-Host '  If something looks wrong, copy files back from the undo dir above.' -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host '  Dry run only. Nothing was written.' -ForegroundColor Green
}

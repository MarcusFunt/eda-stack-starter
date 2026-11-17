[CmdletBinding()]
param(
  [string]$OutputRoot = (Join-Path $PSScriptRoot ('runs\repro-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [string[]]$Scenarios = @('base', 'translated', 'swapped', 'crowded', 'fixed_j1')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$workerRoot = Join-Path $repoRoot 'packages\tscircuit-worker'
$fixtureRoot = Join-Path $repoRoot 'benchmarks\fixtures\voltage-divider'
$helper = Join-Path $PSScriptRoot 'kicad_helper.py'
$outputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (-not $outputRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must be inside the repository so Docker can access the evidence files.'
}
if (Test-Path -LiteralPath $outputRoot) {
  throw "OutputRoot already exists; choose a fresh path to preserve prior evidence: $outputRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'build\topola-target\release\topola'))) {
  throw 'Topola binary is missing. Follow README.md to check out the pinned source and build it first.'
}

$kicadImage = 'kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34'
$rustImage = 'rust@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f'
$containerHelper = '/workspace/benchmarks/topola-routing/2026-11-09/kicad_helper.py'
$repoMount = "type=bind,source=$repoRoot,target=/workspace"
$sourceSha = (git -C $repoRoot rev-parse HEAD).Trim()
$topolaSha = (git -C (Join-Path $repoRoot 'build\topola-source') rev-parse HEAD).Trim()
if ($topolaSha -ne '666e06cfd7ba1f1e5daf700288acb9e0a4f84ceb') {
  throw "Unexpected Topola source revision: $topolaSha"
}
$topolaLock = Join-Path $repoRoot 'build\topola-source\Cargo.lock'
$topolaBinary = Join-Path $repoRoot 'build\topola-target\release\topola'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $topolaLock).Hash.ToLowerInvariant() -ne '2a63b6c4a5eb7a8905de219b2ef59e4fb04e7b69a7fe8bf5b32ada42d0a49167') {
  throw 'Topola dependency lockfile does not match the benchmark pin.'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $topolaBinary).Hash.ToLowerInvariant() -ne '7337f7d22e26c1e30737cce1faf47e6e5a05a7833422e15de6948cad4d3d3215') {
  throw 'Topola binary does not match the benchmark pin.'
}

$mutations = @{
  base = @{ j1 = @('-7', '0'); r1 = @('0', '3'); r2 = @('0', '-3'); description = 'Unmodified fixture placement' }
  translated = @{ j1 = @('-5', '2'); r1 = @('2', '5'); r2 = @('2', '-1'); description = 'Translate all components by (+2,+2) mm' }
  swapped = @{ j1 = @('-7', '0'); r1 = @('0', '-3'); r2 = @('0', '3'); description = 'Swap R1 and R2 placements' }
  crowded = @{ j1 = @('-7', '0'); r1 = @('-1', '0.4'); r2 = @('1.2', '0.4'); description = 'Bring R1/R2 into a tight 2.2 mm horizontal pair' }
  fixed_j1 = @{ j1 = @('-7', '0'); r1 = @('1.5', '2'); r2 = @('1.5', '-2'); description = 'Keep J1 fixed; use the recorded R1/R2 placements' }
}
foreach ($scenario in $Scenarios) {
  if (-not $mutations.ContainsKey($scenario)) { throw "Unknown scenario: $scenario" }
}

New-Item -ItemType Directory -Path $outputRoot | Out-Null
$allMetrics = [Collections.Generic.List[object]]::new()

function Invoke-KiCadContainer([string]$Command, [string]$LogPath) {
  $output = & docker run --rm --mount $repoMount --workdir /workspace --entrypoint /bin/sh $kicadImage -c $Command 2>&1
  $exitCode = $LASTEXITCODE
  $output | Set-Content -Encoding utf8 -LiteralPath $LogPath
  if ($exitCode -ne 0) { throw "KiCad container command failed ($exitCode): $Command" }
}

foreach ($scenario in $Scenarios) {
  $config = $mutations[$scenario]
  $caseRoot = Join-Path $outputRoot $scenario
  New-Item -ItemType Directory -Path $caseRoot | Out-Null
  $sourceUnrouted = Join-Path $caseRoot 'source-unrouted'
  $sourceTscircuit = Join-Path $caseRoot 'source-tscircuit'
  Copy-Item -LiteralPath $fixtureRoot -Destination $sourceUnrouted -Recurse
  Copy-Item -LiteralPath $fixtureRoot -Destination $sourceTscircuit -Recurse

  foreach ($sourcePath in @($sourceUnrouted, $sourceTscircuit)) {
    $tsxPath = Join-Path $sourcePath 'src\board.tsx'
    $tsx = Get-Content -LiteralPath $tsxPath -Raw
    foreach ($pair in @(
      @{ old = 'pcbX={-7}'; new = "pcbX={$($config.j1[0])}" },
      @{ old = 'pcbY={0}'; new = "pcbY={$($config.j1[1])}" },
      @{ old = 'pcbX={0} pcbY={3}'; new = "pcbX={$($config.r1[0])} pcbY={$($config.r1[1])}" },
      @{ old = 'pcbX={0} pcbY={-3}'; new = "pcbX={$($config.r2[0])} pcbY={$($config.r2[1])}" }
    )) {
      if (-not $tsx.Contains($pair.old)) { throw "Expected source placement not found in ${tsxPath}: $($pair.old)" }
      $tsx = $tsx.Replace($pair.old, $pair.new)
    }
    if ($sourcePath -eq $sourceTscircuit) { $tsx = $tsx.Replace(' routingDisabled', '') }
    Set-Content -LiteralPath $tsxPath -Value $tsx -Encoding utf8
  }

  $buildUnrouted = Join-Path $caseRoot 'build-unrouted'
  $buildTscircuit = Join-Path $caseRoot 'build-tscircuit'
  Push-Location $workerRoot
  try {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & npm run build:project -- --project-root $sourceUnrouted --output-dir $buildUnrouted *> (Join-Path $caseRoot 'build-unrouted.log')
    $buildUnroutedExit = $LASTEXITCODE
    $timer.Stop()
    if ($buildUnroutedExit -ne 0) { throw "Unrouted project build failed for $scenario; see build-unrouted.log" }
    $unroutedBuildMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 3)

    $timer.Restart()
    & npm run build:project -- --project-root $sourceTscircuit --output-dir $buildTscircuit *> (Join-Path $caseRoot 'build-tscircuit.log')
    $buildTscircuitExit = $LASTEXITCODE
    $timer.Stop()
    if ($buildTscircuitExit -ne 0) { throw "Tscircuit route build failed for $scenario; see build-tscircuit.log" }
    $tscircuitBuildMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 3)
  } finally { Pop-Location }

  $boardName = 'voltage-divider.kicad_pcb'
  $unroutedBoard = Join-Path $buildUnrouted "kicad\$boardName"
  $tscircuitBoard = Join-Path $buildTscircuit "kicad\$boardName"
  $dsnPath = Join-Path $caseRoot 'topola\voltage-divider.dsn'
  $sesPath = Join-Path $caseRoot 'topola\voltage-divider.ses'
  $dsnContainer = '/workspace/' + $dsnPath.Substring($repoRoot.Length + 1).Replace('\', '/')
  $sesContainer = '/workspace/' + $sesPath.Substring($repoRoot.Length + 1).Replace('\', '/')
  $relativeCase = $caseRoot.Substring($repoRoot.Length + 1).Replace('\', '/')
  $containerCase = '/workspace/' + $relativeCase
  New-Item -ItemType Directory -Path (Split-Path -Parent $dsnPath) | Out-Null

  Invoke-KiCadContainer "python3 $containerHelper export-dsn /workspace/$($unroutedBoard.Substring($repoRoot.Length + 1).Replace('\', '/')) $dsnContainer" (Join-Path $caseRoot 'dsn-export.log')

  $topolaOut = Join-Path $caseRoot 'topola\topola.stdout.txt'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $topolaOutput = & docker run --rm --mount $repoMount --workdir /workspace --entrypoint /workspace/build/topola-target/release/topola $rustImage $dsnContainer --output $sesContainer 2>&1
  $topolaExit = $LASTEXITCODE
  $timer.Stop()
  $topolaOutput | Set-Content -Encoding utf8 -LiteralPath $topolaOut
  if ($topolaExit -ne 0 -or -not (Test-Path -LiteralPath $sesPath)) { throw "Topola failed for $scenario (exit $topolaExit); see topola.stdout.txt" }
  $topolaRuntimeMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 3)

  $topolaProject = Join-Path $caseRoot 'topola\kicad-project'
  Copy-Item -LiteralPath (Join-Path $buildUnrouted 'kicad') -Destination $topolaProject -Recurse
  $topolaBoard = Join-Path $topolaProject $boardName
  $topolaBoardContainer = "$containerCase/topola/kicad-project/$boardName"
  $unroutedBoardContainer = "$containerCase/build-unrouted/kicad/$boardName"
  Invoke-KiCadContainer "python3 $containerHelper import-ses $unroutedBoardContainer $sesContainer $topolaBoardContainer" (Join-Path $caseRoot 'ses-import.log')

  $topolaDrcPath = Join-Path $caseRoot 'topola\drc.json'
  $tscircuitDrcPath = Join-Path $caseRoot 'tscircuit\drc.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $tscircuitDrcPath) | Out-Null
  $topolaDrcContainer = "$containerCase/topola/drc.json"
  $tscircuitDrcContainer = "$containerCase/tscircuit/drc.json"
  $topolaDrcCommand = "kicad-cli pcb drc --schematic-parity --format json --severity-all --output $topolaDrcContainer $topolaBoardContainer"
  $tscircuitBoardContainer = "$containerCase/build-tscircuit/kicad/$boardName"
  $tscircuitDrcCommand = "kicad-cli pcb drc --schematic-parity --format json --severity-all --output $tscircuitDrcContainer $tscircuitBoardContainer"
  Invoke-KiCadContainer $topolaDrcCommand (Join-Path $caseRoot 'topola\drc.log')
  Invoke-KiCadContainer $tscircuitDrcCommand (Join-Path $caseRoot 'tscircuit\drc.log')

  $topolaMetricsPath = Join-Path $caseRoot 'topola\metrics.json'
  $tscircuitMetricsPath = Join-Path $caseRoot 'tscircuit\metrics.json'
  $topolaMetricsContainer = "$containerCase/topola/metrics.json"
  $tscircuitMetricsContainer = "$containerCase/tscircuit/metrics.json"
  Invoke-KiCadContainer "python3 $containerHelper measure $topolaBoardContainer $topolaDrcContainer $topolaMetricsContainer --expected-nets VIN,MID,GND" (Join-Path $caseRoot 'topola\metrics.log')
  Invoke-KiCadContainer "python3 $containerHelper measure $tscircuitBoardContainer $tscircuitDrcContainer $tscircuitMetricsContainer --expected-nets VIN,MID,GND" (Join-Path $caseRoot 'tscircuit\metrics.log')

  $topolaMetrics = Get-Content -LiteralPath $topolaMetricsPath -Raw | ConvertFrom-Json
  $tscircuitMetrics = Get-Content -LiteralPath $tscircuitMetricsPath -Raw | ConvertFrom-Json
  $record = [ordered]@{
    scenario = $scenario
    description = $config.description
    input_source_sha = $sourceSha
    topola_source_sha = $topolaSha
    topola_wall_runtime_ms_including_docker = $topolaRuntimeMs
    tscircuit_build_runtime_ms = $tscircuitBuildMs
    unrouted_build_runtime_ms = $unroutedBuildMs
    topola = $topolaMetrics
    tscircuit = $tscircuitMetrics
  }
  $record | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $caseRoot 'metrics.json')
  $allMetrics.Add($record)
}

$manifest = [ordered]@{
  schema_version = 1
  input_source_sha = $sourceSha
  topola_source_sha = $topolaSha
  topola_binary = 'Topola CLI built from the pinned source revision with Rust 1.90.0'
  kicad_image = $kicadImage
  rust_image = $rustImage
  scenarios = $allMetrics
}
$manifest | ConvertTo-Json -Depth 14 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $outputRoot 'benchmark-results.json')
Write-Output (Join-Path $outputRoot 'benchmark-results.json')

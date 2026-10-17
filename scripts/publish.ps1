# Publishes the current version to npm with a set of pre-flight checks.
#
# Usage:
#   pwsh scripts/publish.ps1                 # verify + build + publish
#   pwsh scripts/publish.ps1 -SkipTests      # skip typecheck/test (not recommended)
#   pwsh scripts/publish.ps1 -DryRun         # run everything except the upload
#
# Requires `npm login` (or NPM_TOKEN + .npmrc) beforehand.

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npmCmd) { Fail "npm not found in PATH" }

# ---------------------------------------------------------------- preflight
Step "checking repository state"
$branch = git branch --show-current
if ($branch -ne "main") { Fail "publish from 'main', currently on '$branch'" }
$dirty = git status --porcelain
if ($dirty) { Fail "working tree is dirty - commit or stash first:`n$dirty" }
Ok "branch main, clean tree"

Step "checking version consistency"
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$versionFile = Get-Content src/version.ts -Raw
$declared = if ($versionFile -match 'VERSION\s*=\s*"([^"]+)"') { $matches[1] } else { $null }
if (-not $declared) { Fail "cannot read VERSION from src/version.ts" }
if ($declared -ne $pkg.version) { Fail "package.json ($($pkg.version)) != src/version.ts ($declared)" }
Ok "version $($pkg.version)"

Step "checking npm authentication"
& $npmCmd whoami 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "not logged in - run 'npm login', or set NPM_TOKEN with .npmrc (see .npmrc.example)"
}
$who = (& $npmCmd whoami).Trim()
Ok "logged in as $who"

$published = (& $npmCmd view "$($pkg.name)@$($pkg.version)" version 2>$null)
if ($published) { Fail "$($pkg.name)@$($pkg.version) is already published - bump the version first" }
Ok "$($pkg.name)@$($pkg.version) is not published yet"

# ---------------------------------------------------------------- verify
if (-not $SkipTests) {
    Step "typecheck + tests"
    & $npmCmd run typecheck
    if ($LASTEXITCODE -ne 0) { Fail "typecheck failed" }
    & $npmCmd test
    if ($LASTEXITCODE -ne 0) { Fail "tests failed" }
    Ok "tests passed"
}

Step "building"
& $npmCmd run build
if ($LASTEXITCODE -ne 0) { Fail "build failed" }
Ok "build finished"

Step "packing (dry run)"
& $npmCmd pack --dry-run 2>&1 | Select-String -Pattern "package size|total files|filename"
if ($LASTEXITCODE -ne 0) { Fail "npm pack failed" }

# ---------------------------------------------------------------- publish
Step "publishing"
if ($DryRun) {
    Write-Host "  (dry run) npm publish --access public" -ForegroundColor Yellow
} else {
    & $npmCmd publish --access public
    if ($LASTEXITCODE -ne 0) { Fail "npm publish failed" }
    Ok "published"

    Start-Sleep -Seconds 3
    $live = (& $npmCmd view "$($pkg.name)" version).Trim()
    Ok "registry now reports $($pkg.name)@$live"
}

# ---------------------------------------------------------------- done
Step "done"
Write-Host "  https://www.npmjs.com/package/$($pkg.name)"
Write-Host ""
Write-Host "next:"
Write-Host "  - verify: npx --yes $($pkg.name)@$($pkg.version) --version"
Write-Host "  - future releases: bump version -> commit -> 'git tag v<version>' -> push (release.yml publishes)"

# Creates the GitHub repository for this project and pushes the current branch.
#
# Prerequisites (one-time):
#   winget install GitHub.cli      # or https://cli.github.com/
#   gh auth login                  # choose HTTPS, login with a browser
#
# Usage:
#   pwsh scripts/bootstrap-github.ps1 -Owner <your-github-username>
#   pwsh scripts/bootstrap-github.ps1 -Owner <name> -GitName "Your Name" -GitEmail "you@users.noreply.github.com"
#   pwsh scripts/bootstrap-github.ps1 -Owner <name> -RewriteAuthors   # rewrite placeholder authors

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Owner,

    [string]$Repo = "harmony-sign-suite",

    [ValidateSet("public", "private")]
    [string]$Visibility = "public",

    [string]$GitName,
    [string]$GitEmail,

    [switch]$RewriteAuthors,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n=== $message ===" -ForegroundColor Cyan }
function Ok($message) { Write-Host "  OK  $message" -ForegroundColor Green }
function Warn($message) { Write-Host "  !!  $message" -ForegroundColor Yellow }
function Fail($message) { Write-Host "  XX  $message" -ForegroundColor Red }

# ---------------------------------------------------------------- sanity
Step "checking repository"
if (-not (Test-Path (Join-Path $root ".git"))) { Fail "not a git repository: $root"; exit 1 }
$branch = git branch --show-current
if ($branch -ne "main") { Fail "expected branch 'main', found '$branch'"; exit 1 }
Ok "branch: main"

# ---------------------------------------------------------------- identity
Step "git identity"
if ($GitName) { git config user.name $GitName; Ok "user.name = $GitName" }
if ($GitEmail) { git config user.email $GitEmail; Ok "user.email = $GitEmail" }

$currentName = git config user.name
$currentEmail = git config user.email
if (-not $GitName -and -not $GitEmail) {
    Warn "current identity: $currentName <$currentEmail>"
    if ($currentEmail -eq "you@example.com") {
        Warn "this is a placeholder identity - commits will not be linked to your GitHub account."
        Warn "re-run with: -GitName `"Your Name`" -GitEmail `"<id>+<user>@users.noreply.github.com`""
    }
}

# ---------------------------------------------------------------- placeholders
Step "filling OWNER placeholders"
$targets = @(
    (Join-Path $root "README.md"),
    (Join-Path $root ".github/ISSUE_TEMPLATE/config.yml")
)
$changed = $false
foreach ($file in $targets) {
    if (-not (Test-Path $file)) { continue }
    $text = Get-Content $file -Raw
    if ($text.Contains("OWNER/")) {
        $replaced = $text.Replace("OWNER/$Repo", "$Owner/$Repo")
        Set-Content -Path $file -Value $replaced -NoNewline -Encoding utf8
        Ok "patched $(Split-Path -Leaf $file)"
        $changed = $true
    }
}
if (-not $changed) { Ok "nothing to patch" }

# ---------------------------------------------------------------- authors
if ($RewriteAuthors) {
    Step "rewriting commit authors"
    $count = (git rev-list --count HEAD)
    Warn "$count commit(s) will be re-authored to '$currentName <$currentEmail>'"
    if (-not $Force) {
        $answer = Read-Host "Continue? (y/N)"
        if ($answer -notin @("y", "Y", "yes")) { Fail "aborted"; exit 1 }
    }
    $env:GIT_AUTHOR_NAME = $currentName
    git rebase --root --exec "git commit --amend --no-edit --reset-author" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "rebase failed"; exit 1 }
    Ok "authors rewritten"
}

# ---------------------------------------------------------------- commit
Step "committing repository metadata"
git add -A
$pending = git status --porcelain
if ($pending) {
    git commit -m "chore: 绑定仓库地址与 issue 模板链接" | Out-Null
    Ok "committed"
} else {
    Ok "working tree clean, nothing to commit"
}

# ---------------------------------------------------------------- remote
Step "creating repository"
$gh = Get-Command gh -ErrorAction SilentlyContinue
$hasRemote = (git remote) -contains "origin"

if ($hasRemote) {
    $url = git remote get-url origin
    Ok "origin already configured: $url"
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { Fail "push failed"; exit 1 }
    Ok "pushed to origin/main"
} elseif ($gh) {
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "gh is installed but not logged in"
        Write-Host "  run: gh auth login" -ForegroundColor Yellow
        exit 1
    }
    & gh repo create "$Owner/$Repo" "--$Visibility" --source . --remote origin --push `
        --description "HarmonyOS 签名与上架自动化工具链：体检 / 修复 / 一键签名，含 AGC 踩坑诊断"
    if ($LASTEXITCODE -ne 0) { Fail "gh repo create failed"; exit 1 }
    Ok "repository created and pushed"
} else {
    Warn "gh CLI not found - create the repository manually:"
    Write-Host ""
    Write-Host "  1) open https://github.com/new"
    Write-Host "     owner: $Owner   name: $Repo   visibility: $Visibility"
    Write-Host "     do NOT initialise with README/.gitignore/license"
    Write-Host ""
    Write-Host "  2) then run:"
    Write-Host "     git remote add origin https://github.com/$Owner/$Repo.git"
    Write-Host "     git push -u origin main"
    Write-Host ""
    exit 0
}

# ---------------------------------------------------------------- done
Step "done"
Ok "https://github.com/$Owner/$Repo"
Write-Host ""
Write-Host "next:"
Write-Host "  - add secrets.NPM_TOKEN (repo Settings -> Secrets -> Actions)"
Write-Host "  - enable Settings -> Code security -> Private vulnerability reporting"
Write-Host "  - npm publish, then: git tag v0.3.0 && git push origin v0.3.0"

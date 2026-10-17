# Creates the GitHub repository for this project and pushes the current branch.
#
# Prerequisites (one-time):
#   winget install GitHub.cli      # or https://cli.github.com/
#   gh auth login                  # choose HTTPS, login with a browser
#
# Usage:
#   pwsh scripts/bootstrap-github.ps1                  # auto-detect owner + identity
#   pwsh scripts/bootstrap-github.ps1 -RewriteAuthors  # also rewrite placeholder authors
#   pwsh scripts/bootstrap-github.ps1 -Owner someone -Repo my-repo -Visibility private

[CmdletBinding()]
param(
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

# ---------------------------------------------------------------- github account
Step "resolving GitHub account"
# PATH may be stale in some shells (e.g. right after a winget install), so fall
# back to the well-known install locations.
$ghExe = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $ghExe) {
    foreach ($candidate in @(
            "$env:ProgramFiles\GitHub CLI\gh.exe",
            "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe",
            "$env:LOCALAPPDATA\GitHub CLI\gh.exe"
        )) {
        if ($candidate -and (Test-Path $candidate)) { $ghExe = $candidate; break }
    }
}

$authed = $false
if ($ghExe) {
    & $ghExe auth status *> $null
    $authed = ($LASTEXITCODE -eq 0)
}

$login = $null
$userId = $null
if ($authed) {
    $login = (& $ghExe api user --jq .login).Trim()
    $userId = (& $ghExe api user --jq .id).Trim()
    Ok "gh authenticated as $login (id $userId)"
} else {
    Warn "gh is not installed or not logged in"
}

if (-not $Owner) {
    if (-not $login) {
        Fail "cannot determine the repository owner - run 'gh auth login' or pass -Owner"
        exit 1
    }
    $Owner = $login
}
Ok "owner: $Owner"

# ---------------------------------------------------------------- identity
Step "git identity"
$currentName = git config user.name
$currentEmail = git config user.email

# Auto-fill a sane identity when git still has the installer placeholder.
if ($authed -and -not $GitEmail -and ($currentEmail -like "*example.com" -or [string]::IsNullOrWhiteSpace($currentEmail))) {
    $GitEmail = "$userId+$login@users.noreply.github.com"
    Ok "using GitHub noreply email: $GitEmail"
}
if ($authed -and -not $GitName -and ($currentName -eq "Your Name" -or [string]::IsNullOrWhiteSpace($currentName))) {
    $displayName = (& $ghExe api user --jq '.name // .login').Trim()
    if (-not $displayName) { $displayName = $login }
    $GitName = $displayName
    Ok "using GitHub display name: $GitName"
}

if ($GitEmail) { git config user.email $GitEmail; Ok "user.email = $GitEmail" }
if ($GitName) { git config user.name $GitName; Ok "user.name = $GitName" }

$currentName = git config user.name
$currentEmail = git config user.email
if ($currentEmail -like "*example.com") {
    Warn "identity is still a placeholder - commits will not be linked to your GitHub account."
    Warn "re-run with: -GitName `"Your Name`" -GitEmail `"<id>+<user>@users.noreply.github.com`""
}

# ---------------------------------------------------------------- placeholders
Step "filling OWNER placeholders"
$targets = @(
    (Join-Path $root "README.md"),
    (Join-Path $root ".github/ISSUE_TEMPLATE/config.yml")
)
$changed = $false
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($file in $targets) {
    if (-not (Test-Path $file)) { continue }
    $text = Get-Content $file -Raw
    if ($text.Contains("OWNER/")) {
        $replaced = $text.Replace("OWNER/$Repo", "$Owner/$Repo")
        [System.IO.File]::WriteAllText($file, $replaced, $utf8NoBom)
        Ok "patched $(Split-Path -Leaf $file)"
        $changed = $true
    }
}
if (-not $changed) { Ok "nothing to patch" }

# ---------------------------------------------------------------- commit
# Commit the placeholder patch first: `git rebase` refuses to run on a dirty tree.
Step "committing repository metadata"
git add -A
$pending = git status --porcelain
if ($pending) {
    git commit -m "chore: 绑定仓库地址与 issue 模板链接" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "commit failed"; exit 1 }
    Ok "committed"
} else {
    Ok "working tree clean, nothing to commit"
}

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
    $env:GIT_AUTHOR_EMAIL = $currentEmail
    $env:GIT_COMMITTER_NAME = $currentName
    $env:GIT_COMMITTER_EMAIL = $currentEmail
    git rebase --root --exec "git commit --amend --no-edit --reset-author" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "rebase failed - resolve with 'git rebase --abort' and re-run without -RewriteAuthors"
        exit 1
    }
    Ok "authors rewritten"
}

# ---------------------------------------------------------------- remote
Step "creating repository"
$hasRemote = (git remote) -contains "origin"

if ($hasRemote) {
    $url = git remote get-url origin
    Ok "origin already configured: $url"
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { Fail "push failed"; exit 1 }
    Ok "pushed to origin/main"
} elseif ($authed) {
    & $ghExe repo create "$Owner/$Repo" "--$Visibility" --source . --remote origin --push `
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

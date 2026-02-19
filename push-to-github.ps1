# Push this folder to GitHub (replaces repo code with local code)
# 1. Install Git from https://git-scm.com/download/win if needed
# 2. Restart your terminal after installing Git
# 3. Run: .\push-to-github.ps1
# 4. When prompted, use your GitHub username and Personal Access Token (as password)

$ErrorActionPreference = "Stop"
$repoUrl = "https://github.com/DineshSingh2026/Bodybank.fit.git"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Download and install from: https://git-scm.com/download/win" -ForegroundColor Yellow
    Write-Host "Then restart this terminal and run this script again." -ForegroundColor Yellow
    exit 1
}

Set-Location $PSScriptRoot

if (-not (Test-Path .git)) {
    Write-Host "Initializing git repository..." -ForegroundColor Cyan
    git init
}

$remote = git remote get-url origin 2>$null
if (-not $remote) {
    Write-Host "Adding remote origin..." -ForegroundColor Cyan
    git remote add origin $repoUrl
} elseif ($remote -ne $repoUrl) {
    Write-Host "Setting remote origin to $repoUrl" -ForegroundColor Cyan
    git remote set-url origin $repoUrl
}

Write-Host "Staging all files..." -ForegroundColor Cyan
git add -A

Write-Host "Committing..." -ForegroundColor Cyan
git commit -m "BodyBank: PostgreSQL backend, E2E tests, scripts, admin fixes" 2>$null
if ($LASTEXITCODE -ne 0) {
    $status = git status --short
    if (-not $status) {
        Write-Host "Nothing to commit (already up to date)." -ForegroundColor Yellow
    } else {
        Write-Host "Commit failed or nothing to commit. Status:" -ForegroundColor Yellow
        git status
        exit 1
    }
}

git branch -M main 2>$null

Write-Host ""
Write-Host "Pushing to GitHub (you will be asked for username and password/token)..." -ForegroundColor Green
Write-Host "Use your GitHub username and a Personal Access Token as the password." -ForegroundColor Yellow
Write-Host "Create a token at: https://github.com/settings/tokens" -ForegroundColor Yellow
Write-Host ""

git push -u origin main --force

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done! Your repo is updated: https://github.com/DineshSingh2026/Bodybank.fit" -ForegroundColor Green
} else {
    Write-Host "Push failed. Check your credentials and try again." -ForegroundColor Red
    exit 1
}

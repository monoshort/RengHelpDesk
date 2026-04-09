# Eenmalig: repo op GitHub zetten. Vereist: gh auth login (zie README).
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) {
  $gh = "gh"
}

& $gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Je bent nog niet ingelogd bij GitHub. Er opent een browservenster — volg de stappen."
  & $gh auth login --web --git-protocol https
}

$hasOrigin = $false
try {
  git remote get-url origin 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $hasOrigin = $true }
} catch { }

if ($hasOrigin) {
  Write-Host "Remote origin bestaat al. Uitvoeren: git push -u origin main"
  git push -u origin main
} else {
  $name = $env:GITHUB_REPO_NAME
  if ([string]::IsNullOrWhiteSpace($name)) { $name = "RengHelpDesk" }
  Write-Host "Aanmaken en pushen: $name (private — veiliger voor .env-gevoelige setup). Zet GITHUB_REPO_NAME voor een andere naam."
  & $gh repo create $name --private --source=. --remote=origin --push
}

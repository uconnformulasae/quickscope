# Publish parser regression fixtures to GitHub Releases (fixtures-v1).
# Requires: gh auth login, local files in tests/fixtures/
#
# Usage (from repo root):
#   .\scripts\publish_fixtures_release.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$xrk = "tests\fixtures\endurance_CT16-EV_Standardized_a_5816.xrk"
$csv = "tests\fixtures\endurance_CT16-EV_Standardized_a_5816_rs.csv"

foreach ($f in @($xrk, $csv)) {
    if (-not (Test-Path $f)) {
        Write-Error "Missing $f — copy your XRK and RS CSV into tests/fixtures/ first."
    }
}

$repo = (gh repo view --json nameWithOwner -q .nameWithOwner)
Write-Host "Publishing fixtures-v1 to $repo ..."

$exists = gh release view fixtures-v1 --repo $repo 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Release fixtures-v1 exists — uploading assets ..."
    gh release upload fixtures-v1 $xrk $csv --repo $repo --clobber
} else {
    gh release create fixtures-v1 $xrk $csv --repo $repo `
        --title "Parser regression fixtures v1" `
        --notes "Pinned XRK + Race Studio CSV for dll-regression.yml CI."
}

Write-Host "Done. Verify: gh release view fixtures-v1 --repo $repo"

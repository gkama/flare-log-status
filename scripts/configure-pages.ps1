[CmdletBinding()]
param(
    [switch]$EnableHttps
)

$ErrorActionPreference = 'Stop'
$pagesApiPath = 'repos/gkama/flare-log-status/pages'
$pagesOutput = & gh api $pagesApiPath 2>$null
if ($LASTEXITCODE -ne 0) {
    $pagesOutput = & gh api --method POST $pagesApiPath -f build_type=workflow
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not enable GitHub Pages. Check repository administration access.'
    }
}

$pagesState = $pagesOutput | ConvertFrom-Json
if ($pagesState.cname -and $pagesState.cname -ne 'status.flarelog.net') {
    throw "The repository already uses a different custom domain: $($pagesState.cname)."
}

& gh api --method PUT $pagesApiPath -f build_type=workflow -f cname=status.flarelog.net
if ($LASTEXITCODE -ne 0) {
    throw 'Could not set the Pages workflow source and custom domain.'
}

$environmentApiPath = 'repos/gkama/flare-log-status/environments/github-pages'
$environmentRequest = @{
    deployment_branch_policy = @{
        protected_branches = $false
        custom_branch_policies = $true
    }
} | ConvertTo-Json -Compress
$environmentOutput = $environmentRequest | & gh api --method PUT $environmentApiPath --input -
if ($LASTEXITCODE -ne 0) {
    throw 'Could not configure the github-pages deployment environment.'
}

$branchPoliciesOutput = & gh api "$environmentApiPath/deployment-branch-policies"
if ($LASTEXITCODE -ne 0) {
    throw 'Could not read Pages deployment branch policies.'
}
$branchPolicies = $branchPoliciesOutput | ConvertFrom-Json
if (-not ($branchPolicies.branch_policies | Where-Object { $_.name -eq 'main' -and $_.type -eq 'branch' })) {
    '{"name":"main","type":"branch"}' | & gh api --method POST "$environmentApiPath/deployment-branch-policies" --input - | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not restrict Pages deployment to the main branch.'
    }
}

if ($EnableHttps) {
    & gh api --method PUT $pagesApiPath -F https_enforced=true
    if ($LASTEXITCODE -ne 0) {
        throw 'HTTPS could not be enforced yet. Verify DNS and wait for the Pages certificate to be issued.'
    }
}

& gh api $pagesApiPath --jq '{build_type, cname, html_url, https_enforced, https_certificate}'
if ($LASTEXITCODE -ne 0) {
    throw 'Could not verify the updated Pages configuration.'
}

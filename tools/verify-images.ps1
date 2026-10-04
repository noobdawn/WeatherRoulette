<#
.SYNOPSIS
    Batch-verifies that every city wallpaper URL in the project actually downloads
    as a real image (HTTP 200 + Content-Type image/jpeg or image/webp).

.DESCRIPTION
    The front-end (js/ui/assets.js) probes each candidate with an <img> preload; this
    script performs the equivalent check server-side so bad links are caught before
    they ship. Every URL in assets/images/manifest.json (primary + fallbacks) is
    requested with Invoke-WebRequest -UseBasicParsing and a browser User-Agent.

    Exit code 0 = every URL passed. Exit code 1 = at least one URL failed.

.PARAMETER Manifest
    Path to assets/images/manifest.json (default). Verifies primary + all fallbacks
    per city and reports per-city pass/fail.

.PARAMETER CandidateFile
    JSON file of candidate URLs, either {"cities":{"<id>":[{"url":"..."}]}} or
    {"<id>":["url1","url2"]}. Used while curating before manifest.json exists.

.PARAMETER UrlFile
    Plain text file, one URL per line (# comments and blank lines ignored).

.PARAMETER Out
    Optional path to write machine-readable JSON results.

.PARAMETER MaxParallel
    Concurrent requests (default 6). Use -Sequential on hosts that throttle.

.PARAMETER TimeoutSec
    Per-request timeout in seconds (default 25).

.EXAMPLE
    pwsh -File tools/verify-images.ps1
    Verify the shipped manifest and print a per-city table.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/verify-images.ps1 -Manifest assets/images/manifest.json -Out tools/_probe/verify.json
    Same check on Windows PowerShell 5.1, also writing JSON results.

.EXAMPLE
    powershell -File tools/verify-images.ps1 -CandidateFile tools/_probe/candidates.json -MaxParallel 10
    Dry-run a candidate pool before promoting URLs into the manifest.
#>
[CmdletBinding(DefaultParameterSetName = 'Manifest')]
param(
    [Parameter(ParameterSetName = 'Manifest')]
    [string]$Manifest = 'assets/images/manifest.json',

    [Parameter(ParameterSetName = 'Candidates', Mandatory = $true)]
    [string]$CandidateFile,

    [Parameter(ParameterSetName = 'Urls', Mandatory = $true)]
    [string]$UrlFile,

    [string]$Out,
    [int]$MaxParallel = 6,
    [int]$TimeoutSec = 25,
    [switch]$Sequential,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11

$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$AllowedTypes = @('image/jpeg', 'image/jpg', 'image/webp')

function Resolve-ProjectPath([string]$p) {
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path (Get-Location).Path $p)
}

# ---------------------------------------------------------------- collect targets
$targets = New-Object System.Collections.Generic.List[object]

switch ($PSCmdlet.ParameterSetName) {
    'Manifest' {
        $path = Resolve-ProjectPath $Manifest
        if (-not (Test-Path $path)) { throw "manifest not found: $path" }
        $m = Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
        if (-not $m.images) { throw "manifest has no 'images' object: $path" }
        foreach ($prop in $m.images.PSObject.Properties) {
            $cityId = $prop.Name
            $entry = $prop.Value
            if ($entry.primary) { $targets.Add([pscustomobject]@{ city = $cityId; role = 'primary'; url = [string]$entry.primary }) }
            $n = 0
            foreach ($fb in @($entry.fallbacks)) {
                if ($fb) { $n++; $targets.Add([pscustomobject]@{ city = $cityId; role = "fallback$n"; url = [string]$fb }) }
            }
        }
        if (-not $Quiet) { Write-Host "manifest : $path" ; Write-Host "cities   : $(@($m.images.PSObject.Properties).Count)" }
    }
    'Candidates' {
        $path = Resolve-ProjectPath $CandidateFile
        if (-not (Test-Path $path)) { throw "candidate file not found: $path" }
        $j = Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
        $root = if ($j.cities) { $j.cities } else { $j }
        foreach ($prop in $root.PSObject.Properties) {
            $cityId = $prop.Name
            foreach ($item in @($prop.Value)) {
                $u = if ($item -is [string]) { $item } elseif ($item.url) { [string]$item.url } else { $null }
                if ($u) { $targets.Add([pscustomobject]@{ city = $cityId; role = 'candidate'; url = $u }) }
            }
        }
        if (-not $Quiet) { Write-Host "candidates: $path"; Write-Host "cities    : $(@($root.PSObject.Properties).Count)" }
    }
    'Urls' {
        $path = Resolve-ProjectPath $UrlFile
        if (-not (Test-Path $path)) { throw "url file not found: $path" }
        foreach ($line in (Get-Content -Encoding UTF8 $path)) {
            $t = $line.Trim()
            if ($t -and -not $t.StartsWith('#')) { $targets.Add([pscustomobject]@{ city = ''; role = 'url'; url = $t }) }
        }
        if (-not $Quiet) { Write-Host "url file  : $path" }
    }
}

$unique = @($targets | Select-Object -ExpandProperty url | Select-Object -Unique)
if (-not $Quiet) { Write-Host "urls      : $($unique.Count) unique ($($targets.Count) slots)"; Write-Host '' }

# ---------------------------------------------------------------- checker
$checkScript = {
    param($url, $ua, $allowed, $timeoutSec)
    $res = [ordered]@{ url = $url; status = 0; contentType = ''; length = 0; ok = $false; error = '' }
    try {
        # Ask for JPEG/WebP explicitly: advertising image/avif makes some CDNs
        # (e.g. images.pexels.com) answer with AVIF, which is outside the
        # image/jpeg|image/webp contract this script checks.
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'User-Agent' = $ua; 'Accept' = 'image/jpeg,image/webp;q=0.9,image/*;q=0.8' } `
                               -TimeoutSec $timeoutSec -MaximumRedirection 6
        $ct = [string]$r.Headers['Content-Type']
        $res.status = [int]$r.StatusCode
        $res.contentType = $ct
        $res.length = [int]$r.RawContentLength
        $base = ($ct -split ';')[0].Trim().ToLower()
        $res.ok = ($res.status -eq 200 -and ($allowed -contains $base))
        if (-not $res.ok) { $res.error = "unexpected content-type '$ct'" }
    } catch {
        $resp = $null
        try { $resp = $_.Exception.Response } catch { }
        if ($resp -and $resp.StatusCode) { $res.status = [int]$resp.StatusCode }
        $res.error = $_.Exception.Message
    }
    return [pscustomobject]$res
}

$results = New-Object System.Collections.Generic.List[object]
$useParallel = (-not $Sequential) -and ($MaxParallel -gt 1) -and ($unique.Count -gt 1)

if ($useParallel) {
    # Runspace pool: PS 5.1 compatible worker fan-out.
    $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($MaxParallel, 16))
    $pool.Open()
    $handles = New-Object System.Collections.Generic.List[object]
    foreach ($u in $unique) {
        $ps = [powershell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($checkScript.ToString()).AddArgument($u).AddArgument($UserAgent).AddArgument($AllowedTypes).AddArgument($TimeoutSec)
        $handles.Add([pscustomobject]@{ ps = $ps; handle = $ps.BeginInvoke() })
    }
    $done = 0
    foreach ($h in $handles) {
        try { $o = $h.ps.EndInvoke($h.handle) } catch { $o = $null }
        $h.ps.Dispose()
        if ($o) { $results.Add(@($o)[0]) }
        $done++
        if (-not $Quiet -and ($done % 25 -eq 0)) { Write-Host "  ... $done / $($unique.Count)" }
    }
    $pool.Close(); $pool.Dispose()
} else {
    $done = 0
    foreach ($u in $unique) {
        $o = & $checkScript -url $u -ua $UserAgent -allowed $AllowedTypes -timeoutSec $TimeoutSec
        $results.Add($o)
        $done++
        if (-not $Quiet -and ($done % 25 -eq 0)) { Write-Host "  ... $done / $($unique.Count)" }
    }
}

# ---------------------------------------------------------------- report
$byUrl = @{}
foreach ($r in $results) { $byUrl[$r.url] = $r }
$passed = @($results | Where-Object { $_.ok })
$failed = @($results | Where-Object { -not $_.ok })

if (-not $Quiet) {
    Write-Host ''
    Write-Host '--- per-city ---'
    $cities = @($targets | Select-Object -ExpandProperty city | Select-Object -Unique)
    foreach ($c in $cities) {
        $slots = @($targets | Where-Object { $_.city -eq $c })
        $oks = @($slots | Where-Object { $byUrl[$_.url].ok })
        $mark = if ($oks.Count -eq $slots.Count) { 'OK  ' } else { 'FAIL' }
        Write-Host ("  {0} {1,-14} {2}/{3} verified" -f $mark, $c, $oks.Count, $slots.Count)
        foreach ($s in ($slots | Where-Object { -not $byUrl[$_.url].ok })) {
            $r = $byUrl[$s.url]
            Write-Host ("         - {0} [{1}] {2} :: {3}" -f $s.role, $r.status, $r.error, $s.url)
        }
    }
    Write-Host ''
    Write-Host '--- failures ---'
    if ($failed.Count -eq 0) {
        Write-Host '  (none)'
    } else {
        foreach ($r in $failed) { Write-Host ("  [{0}] {1}  {2}" -f $r.status, $r.error, $r.url) }
    }
}

$summary = [pscustomobject]@{
    checkedAt   = (Get-Date).ToString('o')
    urlsChecked = $unique.Count
    passed      = $passed.Count
    failed      = $failed.Count
    passRate    = if ($unique.Count) { [Math]::Round(100.0 * $passed.Count / $unique.Count, 1) } else { 0 }
    citiesTotal = @($targets | Select-Object -ExpandProperty city | Select-Object -Unique).Count
    results     = $results
}

Write-Host ''
Write-Host ("RESULT: {0}/{1} URLs verified ({2}%) - {3}" -f $passed.Count, $unique.Count, $summary.passRate, $(if ($failed.Count -eq 0) { 'ALL GOOD' } else { "$($failed.Count) FAILED" }))

if ($Out) {
    $outPath = Resolve-ProjectPath $Out
    $dir = Split-Path -Parent $outPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($outPath, ($summary | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "wrote $outPath"
}

if ($failed.Count -gt 0) { exit 1 }
exit 0

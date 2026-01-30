Param(
  [Parameter(Mandatory = $false)]
  [string]$UserMappingPath,

  [Parameter(Mandatory = $false)]
  [string]$AllowRdpFrom = "Any",

  [Parameter(Mandatory = $false)]
  [string]$AppMapJsonPath,

  [Parameter(Mandatory = $false)]
  [switch]$DisableAllowList,

  [Parameter(Mandatory = $false)]
  [switch]$RestartTermService
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in an elevated PowerShell (Run as Administrator)."
  }
}

function Set-RegistryDword {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [int]$Value
  )
  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
}

function Set-RegistryString {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )
  New-ItemProperty -Path $Path -Name $Name -PropertyType String -Value $Value -Force | Out-Null
}

function Read-JsonFileOrNull {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )
  if (-not $Path) { return $null }
  if (-not (Test-Path -LiteralPath $Path)) { throw "AppMapJsonPath not found: $Path" }
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if (-not $raw) { return $null }
  return ($raw | ConvertFrom-Json)
}

function Get-RemoteAppsFromUserMapping {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) { throw "user-mapping.xml not found: $Path" }

  [xml]$xml = Get-Content -LiteralPath $Path -Raw -Encoding UTF8

  $nodes = $xml.SelectNodes("//connection[protocol='rdp']/param[@name='remote-app']")
  if (-not $nodes) { return @() }

  $results = @()
  foreach ($n in $nodes) {
    $rawValue = $n.InnerText
    if ($null -eq $rawValue) { $rawValue = "" }
    $raw = $rawValue.Trim()
    if (-not $raw) { continue }

    $connName = $null
    try {
      $connName = $n.ParentNode.Attributes["name"].Value
    } catch {
      $connName = "(unknown)"
    }

    $results += [pscustomobject]@{
      ConnectionName = $connName
      RemoteAppRaw   = $raw
    }
  }
  return $results
}

function Get-BuiltInRemoteAppMap {
  return @{
    notepad   = "$env:WINDIR\System32\notepad.exe"
    calc      = "$env:WINDIR\System32\calc.exe"
    mspaint   = "$env:WINDIR\System32\mspaint.exe"
    cmd       = "$env:WINDIR\System32\cmd.exe"
    powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  }
}

function Resolve-RemoteAppSpec {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$RemoteAppRaw,

    [Parameter(Mandatory = $true)]
    [hashtable]$BuiltInMap,

    [Parameter(Mandatory = $false)]
    $CustomMap
  )

  $raw = $RemoteAppRaw.Trim()
  if (-not $raw) { return $null }

  if ($raw.StartsWith("||")) {
    $alias = $raw.Substring(2)
    $path = $BuiltInMap[$alias]
    if (-not $path -and $CustomMap -and $CustomMap.$alias) {
      $path = [string]$CustomMap.$alias
    }
    return [pscustomobject]@{
      Alias = $alias
      Path  = $path
      Raw   = $raw
    }
  }

  if ($raw -match "^[a-zA-Z]:\\\\") {
    $alias = [System.IO.Path]::GetFileNameWithoutExtension($raw)
    return [pscustomobject]@{
      Alias = $alias
      Path  = $raw
      Raw   = $raw
    }
  }

  $alias2 = $raw
  $path2 = $BuiltInMap[$alias2]
  if (-not $path2 -and $CustomMap -and $CustomMap.$alias2) {
    $path2 = [string]$CustomMap.$alias2
  }
  return [pscustomobject]@{
    Alias = $alias2
    Path  = $path2
    Raw   = $raw
  }
}

function Ensure-RdpEnabled {
  $tsKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server"
  $tcpKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp"
  if (-not (Test-Path -LiteralPath $tsKey)) { throw "Registry key not found: $tsKey" }
  if (-not (Test-Path -LiteralPath $tcpKey)) { throw "Registry key not found: $tcpKey" }

  Set-RegistryDword -Path $tsKey -Name "fDenyTSConnections" -Value 0
  Set-RegistryDword -Path $tcpKey -Name "UserAuthentication" -Value 1
}

function Ensure-RdpFirewallRule {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$AllowFrom
  )

  if (-not (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)) {
    Write-Warning "New-NetFirewallRule not found. Please open TCP 3389 inbound in Windows Firewall manually (or via netsh)."
    return
  }

  $ruleName = "MultipleShell-Guacamole-RDP-3389"
  $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $ruleName" -ForegroundColor Yellow
    return
  }

  $params = @{
    Name        = $ruleName
    DisplayName = "Guacamole RDP (TCP 3389)"
    Direction   = "Inbound"
    Action      = "Allow"
    Enabled     = "True"
    Protocol    = "TCP"
    LocalPort   = 3389
    Profile     = "Any"
  }

  if ($AllowFrom -and $AllowFrom -ne "Any") {
    $params.RemoteAddress = $AllowFrom
  }

  New-NetFirewallRule @params | Out-Null
  Write-Host "Created firewall rule: $ruleName" -ForegroundColor Green
}

function Ensure-RemoteAppRegistryEntry {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Alias,

    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [Parameter(Mandatory = $false)]
    [string]$DisplayName
  )

  $base = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Terminal Server\\TSAppAllowList"

  if (-not (Test-Path -LiteralPath $base)) {
    New-Item -Path $base -Force | Out-Null
  }

  if ($DisableAllowList) {
    Set-RegistryDword -Path $base -Name "fDisabledAllowList" -Value 1
  } else {
    Set-RegistryDword -Path $base -Name "fDisabledAllowList" -Value 0
  }

  $appsKey = Join-Path $base "Applications"
  if (-not (Test-Path -LiteralPath $appsKey)) {
    New-Item -Path $appsKey -Force | Out-Null
  }

  $appKey = Join-Path $appsKey $Alias
  if (-not (Test-Path -LiteralPath $appKey)) {
    New-Item -Path $appKey -Force | Out-Null
  }

  if (-not $DisplayName) {
    $DisplayName = $Alias
  }

  Set-RegistryString -Path $appKey -Name "Name" -Value $DisplayName
  Set-RegistryString -Path $appKey -Name "Path" -Value $ExePath
  Set-RegistryString -Path $appKey -Name "IconPath" -Value $ExePath
  Set-RegistryDword -Path $appKey -Name "IconIndex" -Value 0
  Set-RegistryDword -Path $appKey -Name "ShowInTSWA" -Value 1
  Set-RegistryDword -Path $appKey -Name "CommandLineSetting" -Value 0
  Set-RegistryString -Path $appKey -Name "RequiredCommandLine" -Value ""
}

function Restart-TermServiceIfRequested {
  if (-not $RestartTermService) { return }
  $svc = Get-Service -Name "TermService" -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Warning "Service TermService not found; skipping restart."
    return
  }
  Write-Host "Restarting TermService..." -ForegroundColor Cyan
  Restart-Service -Name "TermService" -Force
}

Assert-Admin

# Set default UserMappingPath if not provided
if (-not $UserMappingPath) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $UserMappingPath = Join-Path $scriptDir "..\user-mapping.xml"
  $UserMappingPath = [System.IO.Path]::GetFullPath($UserMappingPath)
}

Write-Host "Reading user-mapping:" -ForegroundColor Cyan
Write-Host "  $UserMappingPath"

$customMap = $null
if ($AppMapJsonPath) {
  Write-Host "Reading app map json:" -ForegroundColor Cyan
  Write-Host "  $AppMapJsonPath"
  $customMap = Read-JsonFileOrNull -Path $AppMapJsonPath
}

$builtIn = Get-BuiltInRemoteAppMap
$remoteApps = Get-RemoteAppsFromUserMapping -Path $UserMappingPath

if (-not $remoteApps -or $remoteApps.Count -eq 0) {
  Write-Warning "No <param name=\"remote-app\"> found under RDP connections in user-mapping.xml."
}

Write-Host "Enabling RDP + NLA..." -ForegroundColor Cyan
Ensure-RdpEnabled

Write-Host "Ensuring firewall inbound TCP 3389..." -ForegroundColor Cyan
Ensure-RdpFirewallRule -AllowFrom $AllowRdpFrom

$toEnsure = @()
foreach ($ra in $remoteApps) {
  $spec = Resolve-RemoteAppSpec -RemoteAppRaw $ra.RemoteAppRaw -BuiltInMap $builtIn -CustomMap $customMap
  if (-not $spec) { continue }
  if (-not $toEnsure.Where({ $_.Alias -eq $spec.Alias }, "First")) {
    $toEnsure += $spec
  }
}

foreach ($app in $toEnsure) {
  if (-not $app.Path) {
    Write-Warning ('Skipping RemoteApp alias ''{0}'' (from ''{1}''): missing exe path mapping. Provide -AppMapJsonPath with {{ "{0}": "C:\\Path\\App.exe" }}.' -f $app.Alias, $app.Raw)
    continue
  }
  if (-not (Test-Path -LiteralPath $app.Path)) {
    Write-Warning ("Skipping RemoteApp alias '{0}': exe not found: {1}" -f $app.Alias, $app.Path)
    continue
  }

  Write-Host ("Registering RemoteApp: ||{0} -> {1}" -f $app.Alias, $app.Path) -ForegroundColor Cyan
  Ensure-RemoteAppRegistryEntry -Alias $app.Alias -ExePath $app.Path -DisplayName $app.Alias
}

Restart-TermServiceIfRequested

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next: from a client machine, test with mstsc:" -ForegroundColor Cyan
Write-Host "  remoteapplicationprogram:s:||notepad"

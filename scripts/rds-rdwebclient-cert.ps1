Param(
  [Parameter(Mandatory = $true)]
  [string]$Domain,

  [Parameter(Mandatory = $false)]
  [string]$ConnectionBroker,

  [Parameter(Mandatory = $false)]
  [string]$PfxPath,

  [Parameter(Mandatory = $false)]
  [switch]$UseThumbprint,

  [Parameter(Mandatory = $false)]
  [switch]$AllRoles,

  [Parameter(Mandatory = $false)]
  [string]$WacsExe,

  [Parameter(Mandatory = $false)]
  [string]$WacsArgs
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in an elevated PowerShell (Run as Administrator)."
  }
}

function Get-DefaultConnectionBroker {
  try {
    return ([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME)).HostName
  } catch {
    return $env:COMPUTERNAME
  }
}

function Find-CertificateForDomain {
  Param(
    [Parameter(Mandatory = $true)]
    [string]$Domain
  )

  $candidates = @()

  foreach ($c in (Get-ChildItem -Path Cert:\LocalMachine\My)) {
    if (-not $c.HasPrivateKey) { continue }

    $match = $false

    if ($c.Subject -like "*CN=$Domain*") {
      $match = $true
    } else {
      try {
        foreach ($dns in $c.DnsNameList) {
          if ($dns.Unicode -and ($dns.Unicode -ieq $Domain)) { $match = $true; break }
        }
      } catch {
        # ignore
      }

      if (-not $match) {
        try {
          $san = $c.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" } | Select-Object -First 1
          if ($san) {
            $sanText = $san.Format($true)
            if ($sanText -match [regex]::Escape($Domain)) { $match = $true }
          }
        } catch {
          # ignore
        }
      }
    }

    if ($match) { $candidates += $c }
  }

  return $candidates | Sort-Object NotAfter -Descending | Select-Object -First 1
}

Assert-Admin

if (-not $ConnectionBroker) {
  $ConnectionBroker = Get-DefaultConnectionBroker
}

if (-not (Get-Command Set-RDCertificate -ErrorAction SilentlyContinue)) {
  throw "Set-RDCertificate cmdlet not found. Install/configure Remote Desktop Services management tools on this server."
}

if ($WacsExe -and $WacsArgs) {
  if (-not (Test-Path -LiteralPath $WacsExe)) {
    throw "win-acme not found: $WacsExe"
  }

  Write-Host "Running win-acme..." -ForegroundColor Cyan
  Write-Host "  $WacsExe $WacsArgs"
  & $WacsExe $WacsArgs
  if ($LASTEXITCODE -ne 0) {
    throw "win-acme failed with exit code $LASTEXITCODE"
  }
}

if ($UseThumbprint) {
  $cert = Find-CertificateForDomain -Domain $Domain
  if (-not $cert) {
    Write-Host "No matching certificate found in Cert:\LocalMachine\My for domain:" -ForegroundColor Red
    Write-Host "  $Domain"
    throw "Certificate not found for domain $Domain."
  }

  $thumbprint = $cert.Thumbprint
  Write-Host "Using certificate thumbprint:" -ForegroundColor Cyan
  Write-Host "  $thumbprint"

  $roles = @("RDWebAccess", "RDGateway")
  if ($AllRoles) {
    $roles += @("RDPublishing", "RDRedirector")
  }

  Write-Host "Applying certificate to RDS roles..." -ForegroundColor Cyan
  Write-Host "  Domain: $Domain"
  Write-Host "  ConnectionBroker: $ConnectionBroker"
  Write-Host "  Roles: $($roles -join ', ')"

  foreach ($role in $roles) {
    try {
      Set-RDCertificate -Role $role -Thumbprint $thumbprint -ConnectionBroker $ConnectionBroker -Force | Out-Null
      Write-Host "OK: $role" -ForegroundColor Green
    } catch {
      Write-Warning ("FAILED: {0} - {1}" -f $role, $_.Exception.Message)
    }
  }

  Write-Host ""
  Write-Host "Verify:" -ForegroundColor Cyan
  Write-Host ("  RD Web Client: https://{0}/RDWeb/webclient/" -f $Domain)
  Write-Host ("  RD Web (legacy): https://{0}/RDWeb/" -f $Domain)
  exit 0
}

if (-not $PfxPath) {
  $defaultPfxDir = Join-Path $env:ProgramData "rds-cert"
  New-Item -ItemType Directory -Force -Path $defaultPfxDir | Out-Null
  $PfxPath = Join-Path $defaultPfxDir ("{0}.pfx" -f $Domain)

  Write-Host "No -PfxPath provided; exporting latest cert for $Domain to:" -ForegroundColor Yellow
  Write-Host "  $PfxPath"

  $cert = Find-CertificateForDomain -Domain $Domain

  if (-not $cert) {
    Write-Host "No matching certificate found in Cert:\LocalMachine\My for domain:" -ForegroundColor Red
    Write-Host "  $Domain"
    Write-Host ""
    Write-Host "Tip: issue/install a public certificate first (e.g. win-acme/Let's Encrypt) or pass -PfxPath." -ForegroundColor Yellow
    Write-Host "To inspect what you have now:" -ForegroundColor Yellow
    Write-Host "  Get-ChildItem Cert:\LocalMachine\My | Select Subject, NotAfter, Thumbprint"
    throw "Certificate not found for domain $Domain."
  }

  $pfxPassword = Read-Host "Enter a password to protect the exported PFX" -AsSecureString
  Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $pfxPassword -Force | Out-Null
} else {
  if (-not (Test-Path -LiteralPath $PfxPath)) {
    throw "PFX not found: $PfxPath"
  }
  $pfxPassword = Read-Host "Enter PFX password" -AsSecureString
}

$roles = @("RDWebAccess", "RDGateway")
if ($AllRoles) {
  $roles += @("RDPublishing", "RDRedirector")
}

Write-Host "Applying certificate to RDS roles..." -ForegroundColor Cyan
Write-Host "  Domain: $Domain"
Write-Host "  ConnectionBroker: $ConnectionBroker"
Write-Host "  PfxPath: $PfxPath"
Write-Host "  Roles: $($roles -join ', ')"

foreach ($role in $roles) {
  try {
    Set-RDCertificate -Role $role -ImportPath $PfxPath -Password $pfxPassword -ConnectionBroker $ConnectionBroker -Force | Out-Null
    Write-Host "OK: $role" -ForegroundColor Green
  } catch {
    Write-Warning ("FAILED: {0} - {1}" -f $role, $_.Exception.Message)
  }
}

Write-Host ""
Write-Host "Verify:" -ForegroundColor Cyan
Write-Host ("  RD Web Client: https://{0}/RDWeb/webclient/" -f $Domain)
Write-Host ("  RD Web (legacy): https://{0}/RDWeb/" -f $Domain)

# Test RDP connection to remote server
Param(
  [Parameter(Mandatory = $false)]
  [string]$Hostname = "39.232.162.8",

  [Parameter(Mandatory = $false)]
  [int]$Port = 3389
)

Write-Host "Testing RDP connection to ${Hostname}:${Port}..." -ForegroundColor Cyan

# Test TCP connection
try {
  $tcpClient = New-Object System.Net.Sockets.TcpClient
  $connect = $tcpClient.BeginConnect($Hostname, $Port, $null, $null)
  $wait = $connect.AsyncWaitHandle.WaitOne(5000, $false)

  if ($wait) {
    try {
      $tcpClient.EndConnect($connect)
      Write-Host "✓ TCP connection successful" -ForegroundColor Green
      $tcpClient.Close()
    } catch {
      Write-Host "✗ TCP connection failed: $_" -ForegroundColor Red
      exit 1
    }
  } else {
    Write-Host "✗ Connection timeout" -ForegroundColor Red
    $tcpClient.Close()
    exit 1
  }
} catch {
  Write-Host "✗ Connection error: $_" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Connection test passed. RDP server is reachable." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Verify credentials in user-mapping.xml are correct"
Write-Host "2. Ensure RemoteApp is enabled on the server"
Write-Host "3. Check Guacamole logs for detailed error messages"

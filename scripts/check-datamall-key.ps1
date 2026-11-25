# Checks the stored LTA DataMall AccountKey with one live BusArrival call (stop 01012).
# Prints only the HTTP status and how many bus services answered. It never prints the key.
# The key is stored by you (see DEPLOY.md, "DataMall key") in %LOCALAPPDATA%\BUNI-Transit\datamall.key,
# encrypted with Windows DPAPI: only your Windows account on this PC can decrypt it.
$f = Join-Path $env:LOCALAPPDATA 'BUNI-Transit\datamall.key'
if (-not (Test-Path $f)) { 'NO KEY STORED YET'; exit 1 }
$sec = Get-Content $f | ConvertTo-SecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $k = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  $r = Invoke-WebRequest -Uri 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=01012' -Headers @{ AccountKey = $k; accept = 'application/json' } -UseBasicParsing -TimeoutSec 20
  $j = $r.Content | ConvertFrom-Json
  "KEY OK - HTTP $($r.StatusCode) - stop 01012 - $(@($j.Services).Count) services answering"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  "KEY CHECK FAILED - HTTP $code" + $(if ($code -eq 401) { ' (DataMall did not accept this key; DataMall AccountKeys are normally 24 characters ending in ==)' } else { '' })
  exit 2
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  Remove-Variable k -ErrorAction SilentlyContinue
}

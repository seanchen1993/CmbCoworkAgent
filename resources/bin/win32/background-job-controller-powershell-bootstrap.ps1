$script = $null
try {
  $inputStream = [Console]::OpenStandardInput()
  $memory = New-Object System.IO.MemoryStream
  $inputStream.CopyTo($memory)
  $bytes = $memory.ToArray()
  if (
    $bytes.Length -ge 3 -and
    $bytes[0] -eq 0xef -and
    $bytes[1] -eq 0xbb -and
    $bytes[2] -eq 0xbf
  ) {
    throw [System.IO.InvalidDataException]::new("Unexpected UTF-8 BOM on background stdin")
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $scriptText = $utf8.GetString($bytes)
  $exitFooter = [Environment]::NewLine + "if (-not `$?) { exit 1 }"
  $script = [ScriptBlock]::Create($scriptText + $exitFooter)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 126
}

& $script

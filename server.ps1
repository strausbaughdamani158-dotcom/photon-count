param(
  [int]$Port = 8000,
  [string]$HostName = "127.0.0.1"
)

$Root = [IO.Path]::GetFullPath((Get-Location).Path)
$RootPrefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$Prefix = "http://${HostName}:$Port/"

$ContentTypes = @{
  ".css" = "text/css; charset=utf-8"
  ".html" = "text/html; charset=utf-8"
  ".js" = "text/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".md" = "text/markdown; charset=utf-8"
}

$Server = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($HostName), $Port)
$Server.Start()
Write-Host "ArrayScope: $Prefix"

try {
  while ($true) {
    $Client = $Server.AcceptTcpClient()
    try {
      $Stream = $Client.GetStream()
      $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::ASCII, $false, 8192, $true)
      $RequestLine = $Reader.ReadLine()
      while ($true) {
        $HeaderLine = $Reader.ReadLine()
        if ($null -eq $HeaderLine -or $HeaderLine.Length -eq 0) {
          break
        }
      }

      $StatusCode = 200
      $Reason = "OK"
      $ContentType = "text/plain; charset=utf-8"
      $BodyBytes = [byte[]]::new(0)
      $Method = ""
      $Target = "/"

      if ($RequestLine) {
        $Parts = $RequestLine.Split(" ")
        if ($Parts.Length -ge 2) {
          $Method = $Parts[0].ToUpperInvariant()
          $Target = $Parts[1]
        }
      }

      if ($Method -ne "GET" -and $Method -ne "HEAD") {
        $StatusCode = 405
        $Reason = "Method Not Allowed"
        $BodyBytes = [Text.Encoding]::UTF8.GetBytes("Method Not Allowed")
      } else {
        $PathOnly = $Target.Split("?")[0]
        $RequestPath = [Uri]::UnescapeDataString($PathOnly.TrimStart("/"))
        if ([string]::IsNullOrWhiteSpace($RequestPath)) {
          $RequestPath = "index.html"
        }

        $FullPath = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $RequestPath))
        $InsideRoot = $FullPath.Equals($Root, [StringComparison]::OrdinalIgnoreCase) `
          -or $FullPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)

        if (-not $InsideRoot) {
          $StatusCode = 403
          $Reason = "Forbidden"
          $BodyBytes = [Text.Encoding]::UTF8.GetBytes("Forbidden")
        } elseif (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
          $StatusCode = 404
          $Reason = "Not Found"
          $BodyBytes = [Text.Encoding]::UTF8.GetBytes("Not Found")
        } else {
          $BodyBytes = [IO.File]::ReadAllBytes($FullPath)
          $Extension = [IO.Path]::GetExtension($FullPath)
          $ContentType = $ContentTypes[$Extension]
          if (-not $ContentType) {
            $ContentType = "application/octet-stream"
          }
        }
      }

      $Header = "HTTP/1.1 $StatusCode $Reason`r`n" `
        + "Content-Type: $ContentType`r`n" `
        + "Content-Length: $($BodyBytes.Length)`r`n" `
        + "Cache-Control: no-store`r`n" `
        + "Connection: close`r`n`r`n"
      $HeaderBytes = [Text.Encoding]::ASCII.GetBytes($Header)
      $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
      if ($Method -ne "HEAD" -and $BodyBytes.Length -gt 0) {
        $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
      }
    } catch {
      try {
        $BodyBytes = [Text.Encoding]::UTF8.GetBytes("Internal Server Error")
        $Header = "HTTP/1.1 500 Internal Server Error`r`n" `
          + "Content-Type: text/plain; charset=utf-8`r`n" `
          + "Content-Length: $($BodyBytes.Length)`r`n" `
          + "Connection: close`r`n`r`n"
        $HeaderBytes = [Text.Encoding]::ASCII.GetBytes($Header)
        $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
        $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
      } catch {
        # Ignore write failures for broken clients.
      }
    } finally {
      $Client.Close()
    }
  }
} finally {
  $Server.Stop()
}

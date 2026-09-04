# scripts-dev/repair-mojibake.ps1 — Invierte la doble codificación UTF-8↔ANSI de PS 5.1.
# Determinista: solo decodifica tokens cuyo PRIMER char sea lead byte de secuencia
# multi-byte (Ã=C3, Â=C2, â=E2). Los acentos legítimos empiezan por E1/E9/ED/F3/FA/F1… y quedan intactos.
param(
  [Parameter(Mandatory=$true)][string]$Files
)
$ErrorActionPreference = 'Stop'
# cp1252 (ANSI de Windows): mapea 0x80-0x9F a €‚ƒ„…†‡ˆ‰Š‹Œ''""•–—˜™š›œžŸ
# Es el inverso EXACTO del daño (Get-Content ANSI → Set-Content UTF8).
$latin1 = [Text.Encoding]::GetEncoding(1252)
$utf8New = New-Object System.Text.UTF8Encoding($false)  # sin BOM

function Test-Lead([char]$c) {
  $code = [int]$c
  return (($code -ge 0xC2 -and $code -le 0xC3) -or ($code -eq 0xE2))
}

function Repair([string]$text) {
  for ($round = 0; $round -lt 6; $round++) {
    $runs = [regex]::Matches($text, '[^\x00-\x7F]+')
    if ($runs.Count -eq 0) { break }
    $tokens = $runs | ForEach-Object { $_.Value } | Sort-Object -Unique
    $changed = $false
    foreach ($t in $tokens) {
      if (-not (Test-Lead $t[0])) { continue }
      # cp1252 mapea €‚""… etc. (>0xFF) a bytes 0x80-0x9F; solo el fallback produce '?'
      $bytes = $latin1.GetBytes($t)
      if (($bytes -contains 0x3F) -and (-not $t.Contains('?'))) { continue }
      $decoded = $utf8New.GetString($bytes)
      if ($decoded.Contains([string][char]0xFFFD)) { continue }   # decodificación inválida → no tocar
      if ($decoded -eq $t) { continue }                            # punto fijo
      $text = $text.Replace($t, $decoded)
      $changed = $true
    }
    if (-not $changed) { break }
  }
  return $text
}

$fileList = $Files.Split(',') | ForEach-Object { $_.Trim() }

foreach ($f in $fileList) {
  $before = [IO.File]::ReadAllText($f, $utf8New)
  $after = Repair $before
  if ($before -ne $after) {
    [IO.File]::WriteAllText($f, $after, $utf8New)
    $bad = [regex]::Matches($after, '[\u00C2\u00C3\u00E2][\u0080-\u00FF]').Count
    Write-Output ("{0}: reparado (residuo sospechoso: {1})" -f $f, $bad)
  } else {
    Write-Output ("{0}: sin cambios" -f $f)
  }
}

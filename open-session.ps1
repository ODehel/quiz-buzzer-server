<#
.SYNOPSIS
    Ouvre autant de fenêtres PowerShell que de buzzers configurés dans .env.

.PARAMETER NombreDeBuzzers
    Nombre de buzzers à ouvrir (1 à 10). Défaut : 10.

.PARAMETER ServeurUrl
    URL HTTP du serveur. Défaut : récupérée depuis start-server.ps1 via $serverUrl.

.EXAMPLE
    .\open-buzzers.ps1
    .\open-buzzers.ps1 -NombreDeBuzzers 4
    .\open-buzzers.ps1 -NombreDeBuzzers 4 -ServeurUrl "http://192.168.1.50:3000"
#>

[CmdletBinding()]
param (
    [ValidateRange(1, 10)]
    [int]$NombreDeBuzzers = 10,

    [string]$ServeurUrl = $serverUrl,   # Hérite de $serverUrl si défini dans la session

    [string]$EnvFile = "C:\Users\olivi\source\repos\QuizBuzzer\quiz-buzzer-server\.env"
)

# =============================================================================
# Fonctions utilitaires
# =============================================================================

function Read-EnvFile {
    param ([string]$Path)
    $result = @{}
    foreach ($line in Get-Content -Path $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) { continue }
        $parts = $line -split "=", 2
        if ($parts.Length -eq 2) { $result[$parts[0].Trim()] = $parts[1].Trim() }
    }
    return $result
}

# =============================================================================
# Vérifications préalables
# =============================================================================

if ([string]::IsNullOrEmpty($ServeurUrl)) {
    Write-Error "Aucune URL serveur fournie. Lance start-server.ps1 d'abord, ou passe -ServeurUrl."
    exit 1
}

if (-not (Test-Path $EnvFile)) {
    Write-Error "Fichier '$EnvFile' introuvable."
    exit 1
}

if (-not (Get-Command wscat -ErrorAction SilentlyContinue)) {
    Write-Error "'wscat' n'est pas installé. Lance : npm install -g wscat"
    exit 1
}

# =============================================================================
# Initialisation
# =============================================================================

$apiUrl = "$ServeurUrl/api/v1/token"
$wsUrl  = $ServeurUrl -replace "^http", "ws"
$wsUrl  = "$wsUrl/ws"
$env    = Read-EnvFile -Path $EnvFile
$opened = 0

Write-Host ""
Write-Host "  Quiz Buzzer — Ouverture des sessions WebSocket" -ForegroundColor Cyan
Write-Host "  Serveur : $wsUrl" -ForegroundColor Cyan
Write-Host ""

# =============================================================================
# Boucle principale
# =============================================================================

for ($i = 1; $i -le $NombreDeBuzzers; $i++) {
    $num      = $i.ToString("D2")
    $username = "quiz_buzzer_$num"
    $envKey   = "BUZZER_${num}_PASSWORD"
    $password = $env[$envKey]

    if ([string]::IsNullOrEmpty($password)) {
        Write-Warning "  Mot de passe introuvable pour $username ($envKey absent du .env) — fenêtre ignorée."
        continue
    }

    Write-Host "  🔑 Récupération du token pour $username..." -NoNewline

    try {
        $response = Invoke-RestMethod `
            -Uri $apiUrl `
            -Method POST `
            -ContentType "application/json" `
            -Body "{`"username`":`"$username`",`"password`":`"$password`"}" `
            -ErrorAction Stop
        $token = $response.token
    }
    catch {
        Write-Host " ECHEC" -ForegroundColor Red
        Write-Warning "  $_"
        continue
    }

    Write-Host " OK" -ForegroundColor Green

    $authMessage = [ordered]@{ type = "auth"; token = $token } | ConvertTo-Json -Compress

    # Script injecté dans la nouvelle fenêtre PowerShell
    $innerScript = @"
`$host.UI.RawUI.WindowTitle = '$username'

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║  Buzzer  : $username" -ForegroundColor Cyan
Write-Host "  ║  Serveur : $wsUrl" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Connexion et authentification en cours..." -ForegroundColor DarkGray
Write-Host ""

`$psi = New-Object System.Diagnostics.ProcessStartInfo
`$psi.FileName              = "cmd.exe"
`$psi.Arguments             = "/c wscat -c $wsUrl"
`$psi.UseShellExecute       = `$false
`$psi.RedirectStandardInput = `$true

`$p = [System.Diagnostics.Process]::Start(`$psi)
Start-Sleep -Milliseconds 500
`$p.StandardInput.WriteLine('$authMessage')
`$p.WaitForExit()
"@

    Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", $innerScript
    $opened++
    Start-Sleep -Milliseconds 300
}

Write-Host ""
Write-Host "  🎉 $opened fenêtre(s) ouverte(s) sur $wsUrl." -ForegroundColor Green
Write-Host ""
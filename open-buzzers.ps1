<#
.SYNOPSIS
    Ouvre autant de fenêtres PowerShell que de buzzers configurés dans .env,
    plus une fenêtre pour le compte admin (application Angular).

.PARAMETER NombreDeBuzzers
    Nombre de buzzers à ouvrir (1 à 10). Défaut : 10.

.PARAMETER ServeurUrl
    URL HTTP du serveur.

.EXAMPLE
    .\open-buzzers.ps1
    .\open-buzzers.ps1 -NombreDeBuzzers 4
    .\open-buzzers.ps1 -NombreDeBuzzers 4 -ServeurUrl "http://192.168.1.50:3000"
#>

[CmdletBinding()]
param (
    [ValidateRange(1, 10)]
    [int]$NombreDeBuzzers = 10,

    [string]$ServeurUrl = $serverUrl,

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

function Open-WsWindow {
    param (
        [string]$Username,
        [string]$Password,
        [string]$ApiUrl,
        [string]$WsUrl,
        [string]$WindowColor = "DarkBlue"
    )

    Write-Host "  Recuperation du token pour $Username..." -NoNewline

    try {
        $response = Invoke-RestMethod `
            -Uri $ApiUrl `
            -Method POST `
            -ContentType "application/json" `
            -Body "{`"username`":`"$Username`",`"password`":`"$Password`"}" `
            -ErrorAction Stop
        $token = $response.token
    }
    catch {
        Write-Host " ECHEC" -ForegroundColor Red
        Write-Warning "$_"
        return $false
    }

    Write-Host " OK" -ForegroundColor Green

    $authMessage = [ordered]@{ type = "auth"; token = $token } | ConvertTo-Json -Compress

    $tmpAuth   = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.txt'
    $tmpScript = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.ps1'

    Set-Content -Path $tmpAuth -Value $authMessage -Encoding UTF8

    Set-Content -Path $tmpScript -Encoding UTF8 -Value @"
`$host.UI.RawUI.WindowTitle = '$Username'

Write-Host ""
Write-Host "  Compte  : $Username" -ForegroundColor $WindowColor
Write-Host "  Serveur : $WsUrl" -ForegroundColor $WindowColor
Write-Host ""
Write-Host "  Connexion et authentification en cours..." -ForegroundColor DarkGray
Write-Host ""

`$authMessage = (Get-Content '$tmpAuth' -Raw).Trim()

`$psi = New-Object System.Diagnostics.ProcessStartInfo
`$psi.FileName              = "cmd.exe"
`$psi.Arguments             = "/c wscat -c $WsUrl"
`$psi.UseShellExecute       = `$false
`$psi.RedirectStandardInput = `$true

`$p = [System.Diagnostics.Process]::Start(`$psi)
Start-Sleep -Milliseconds 500
`$p.StandardInput.WriteLine(`$authMessage)
`$p.StandardInput.Flush()
`$p.WaitForExit()

Remove-Item '$tmpAuth'   -ErrorAction SilentlyContinue
Remove-Item '$tmpScript' -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Session wscat terminee." -ForegroundColor DarkGray
"@

    Start-Process powershell.exe -ArgumentList "-NoExit", "-File", $tmpScript
    return $true
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
    Write-Error "'wscat' n'est pas installe. Lance : npm install -g wscat"
    exit 1
}

# =============================================================================
# Initialisation
# =============================================================================

$apiUrl = "$ServeurUrl/api/v1/token"
$wsUrl  = ($ServeurUrl -replace "^http", "ws") + "/ws"
$env    = Read-EnvFile -Path $EnvFile
$opened = 0

Write-Host ""
Write-Host "  Quiz Buzzer - Ouverture des sessions WebSocket" -ForegroundColor Cyan
Write-Host "  Serveur : $wsUrl" -ForegroundColor Cyan
Write-Host ""

# =============================================================================
# Buzzers
# =============================================================================

Write-Host "  -- Buzzers --" -ForegroundColor DarkGray
Write-Host ""

for ($i = 1; $i -le $NombreDeBuzzers; $i++) {
    $num      = $i.ToString("D2")
    $username = "quiz_buzzer_$num"
    $envKey   = "BUZZER_${num}_PASSWORD"
    $password = $env[$envKey]

    if ([string]::IsNullOrEmpty($password)) {
        Write-Warning "Mot de passe introuvable pour $username - $envKey absent du .env - fenetre ignoree."
        continue
    }

    $ok = Open-WsWindow -Username $username -Password $password -ApiUrl $apiUrl -WsUrl $wsUrl -WindowColor "Cyan"
    if ($ok) { $opened++ }
    Start-Sleep -Milliseconds 300
}

# =============================================================================
# Admin (application Angular)
# =============================================================================

Write-Host ""
Write-Host "  -- Admin (application Angular) --" -ForegroundColor DarkGray
Write-Host ""

$adminPassword = $env["ADMIN_PASSWORD"]

if ([string]::IsNullOrEmpty($adminPassword)) {
    Write-Warning "Mot de passe introuvable pour admin - ADMIN_PASSWORD absent du .env - fenetre ignoree."
} else {
    $ok = Open-WsWindow -Username "admin" -Password $adminPassword -ApiUrl $apiUrl -WsUrl $wsUrl -WindowColor "Yellow"
    if ($ok) { $opened++ }
}

# =============================================================================
# Résumé
# =============================================================================

Write-Host ""
Write-Host "  $opened fenetre(s) ouverte(s) sur $wsUrl." -ForegroundColor Green
Write-Host ""
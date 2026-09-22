# audio_service.ps1 — start or stop the Khmer Dictionary audio server silently.
#
#   .\audio_service.ps1            start it (hidden) and open the browser
#   .\audio_service.ps1 -NoBrowser start it without opening the browser
#   .\audio_service.ps1 -Stop      stop it
#   .\audio_service.ps1 -Status    report whether it is running
#
# "Silently" means pythonw.exe, Python's console-less launcher: no terminal
# window appears. Everything the server would have printed goes to server.log
# next to server.py.

param(
    [switch]$Stop,
    [switch]$Status,
    [switch]$NoBrowser,
    [int]$Port = 8777
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Server {
    try { (New-Object Net.Sockets.TcpClient('127.0.0.1', $Port)).Close(); return $true }
    catch { return $false }
}

function Get-ServerProcesses {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' or Name='python.exe'" |
        Where-Object { $_.CommandLine -like '*server.py*' -and $_.CommandLine -notlike '*jedi*' }
}

if ($Status) {
    $procs = @(Get-ServerProcesses)
    if (Test-Server) { Write-Host "running on http://127.0.0.1:$Port  (pid $($procs.ProcessId -join ', '))" }
    else { Write-Host "not running" }
    return
}

if ($Stop) {
    $procs = @(Get-ServerProcesses)
    if ($procs.Count) {
        $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        Write-Host "stopped $($procs.Count) audio server process(es)."
    } else {
        Write-Host "the audio server is not running."
    }
    return
}

if (-not (Test-Server)) {
    # The Microsoft Store alias called pythonw.exe refuses to launch ("Access is
    # denied"), so skip anything under WindowsApps and take a real interpreter.
    # NB: no "Select-Object -First 1" here. Downstream of Get-Command -All it
    # raises a pipeline-stop that silently ends the whole script under
    # Windows PowerShell, so index the array instead.
    $cands = @(Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike '*WindowsApps*' })
    if ($cands.Count -eq 0) {
        $cands = @(Get-Command python.exe -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notlike '*WindowsApps*' })
    }
    $py = if ($cands.Count) { $cands[0] } else { $null }
    if (-not $py) {
        Write-Host "Python was not found on PATH — install it, or set khmerDictionary.pythonPath in VS Code."
        exit 1
    }

    # -WindowStyle Hidden plus pythonw.exe means no console at all; the server
    # writes to server.log itself when it finds no stdout.
    Start-Process -FilePath $py.Source -ArgumentList 'server.py' `
        -WorkingDirectory $here -WindowStyle Hidden

    $ok = $false
    foreach ($i in 1..25) {
        if (Test-Server) { $ok = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ok) {
        Write-Host "the audio server did not come up — see $here\server.log"
        exit 1
    }
}

if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/index.html" }

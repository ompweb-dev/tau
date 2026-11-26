#Requires -Version 5.1
<#
.SYNOPSIS
    Headless tau host daemon supervisor (`tau host`).
    Registered next to the tau service by install-tray.ps1 as the "tau-host" scheduled task.
.NOTES
    `tau host` exits when host.json does not exist yet (first install: the web server writes it
    at startup) and when the server revokes or outdates its token. This loop restarts it after a
    pause, so the daemon follows the web server instead of staying down.
#>
param(
    [int]$RestartDelaySeconds = 10
)

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$LauncherJs = Join-Path $RepoRoot "bin\tau.js"

# The updater replaces this installation in place, and Windows refuses to rename a
# directory that is a live process's working directory (ERROR_SHARING_VIOLATION).
# Every path below is absolute, so the children start outside the installation.
$LaunchWorkingDirectory = $env:USERPROFILE
# An empty value would make the child inherit the process's own directory, which is the
# installation; refuse instead of silently reintroducing the lock.
if ([string]::IsNullOrWhiteSpace($LaunchWorkingDirectory)) {
    throw "USERPROFILE is empty: refusing to start tau from inside its installation directory."
}

# One daemon supervisor per logon session.
$createdNew = $false
try { $script:AppMutex = New-Object System.Threading.Mutex($true, "Local\TauHostDaemon_Instance_Mutex", [ref]$createdNew) } catch { $createdNew = $true }
if (!$createdNew) { Exit 0 }

$LogDir = Join-Path $env:USERPROFILE ".pi\agent\logs"
if (!(Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
$LogFile = Join-Path $LogDir "tau-host.log"
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
    Move-Item -Path $LogFile -Destination "$LogFile.old" -Force -ErrorAction SilentlyContinue
}

function Find-BunExecutable {
    $bunCmd = Get-Command bun.exe -ErrorAction SilentlyContinue
    if ($bunCmd -and (Test-Path $bunCmd.Source)) { return $bunCmd.Source }
    $candidate = "$env:USERPROFILE\.bun\bin\bun.exe"
    if (Test-Path $candidate) { return $candidate }
    return "bun.exe"
}
$BunExe = Find-BunExecutable

try {
    while ($true) {
        # Output goes to a file through cmd, as in tau-service.ps1.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = "/d /s /c `"`"$BunExe`" `"$LauncherJs`" host >> `"$LogFile`" 2>&1`""
        $psi.WorkingDirectory = $LaunchWorkingDirectory
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    if ($script:AppMutex) { try { $script:AppMutex.ReleaseMutex() } catch { }; $script:AppMutex.Dispose() }
}

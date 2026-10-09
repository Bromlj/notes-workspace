$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'NotesWorkspace\DesktopProgram'
$source = $PSScriptRoot
$executable = Join-Path $destination 'Notes Workspace.exe'
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -ne [IO.Path]::GetFullPath($destination).TrimEnd('\')) {
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable }
    if ($running) { throw 'Close Notes Workspace, then run Install.cmd again.' }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destination -Recurse -Force
}
Start-Process -FilePath $executable -ArgumentList '--create-shortcut' -WorkingDirectory $destination
Write-Host 'Notes Workspace is installed. Its shortcut is on your desktop.'

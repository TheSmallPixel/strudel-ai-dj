import { execFile } from 'node:child_process';

/**
 * Drives the Windows Media Session API via PowerShell. Works with any
 * SMTC-aware media app (Spotify desktop, Edge/Chrome with Spotify Web, etc.).
 * We pick the session whose source AppUserModelId matches Spotify; if no
 * Spotify session exists, we fall back to the currently active session.
 *
 * All PowerShell snippets here are single-shot (powershell -NoProfile -Command)
 * and inline the WinRT calls.  PowerShell 5.1 is shipped with every Win10/11
 * box, so no extra install is needed.
 */

interface NowPlaying {
  title: string;
  artist: string;
  album?: string;
  sourceAppUserModelId?: string;
  status?: string;
}

const PS_HEADER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime > $null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function AwaitOp([object]$WinRtTask, [Type]$ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(5000) | Out-Null
    return $netTask.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
$mgr = AwaitOp $mgrOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = $mgr.GetSessions()
$session = $null
foreach ($s in $sessions) {
  if ($s.SourceAppUserModelId -match 'Spotify') { $session = $s; break }
}
if (-not $session) { $session = $mgr.GetCurrentSession() }
`;

function runPs(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_HEADER + script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve(stdout.toString().trim());
      },
    );
  });
}

function transport(action: 'TryPlayAsync' | 'TryPauseAsync' | 'TrySkipNextAsync' | 'TrySkipPreviousAsync' | 'TryTogglePlayPauseAsync'): Promise<string> {
  return runPs(`
if (-not $session) { Write-Output 'no-session'; exit }
$op = $session.${action}()
$null = AwaitOp $op ([bool])
Write-Output 'ok'
`);
}

export const windowsMedia = {
  async play(): Promise<string> {
    return await transport('TryPlayAsync');
  },
  async pause(): Promise<string> {
    return await transport('TryPauseAsync');
  },
  async togglePlayPause(): Promise<string> {
    return await transport('TryTogglePlayPauseAsync');
  },
  async next(): Promise<string> {
    return await transport('TrySkipNextAsync');
  },
  async prev(): Promise<string> {
    return await transport('TrySkipPreviousAsync');
  },
  async nowPlaying(): Promise<NowPlaying | null> {
    const out = await runPs(`
if (-not $session) { Write-Output ''; exit }
$propsOp = $session.TryGetMediaPropertiesAsync()
$props = AwaitOp $propsOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
if (-not $props) { Write-Output ''; exit }
$info = $session.GetPlaybackInfo()
$obj = [PSCustomObject]@{
  title = $props.Title
  artist = $props.Artist
  album = $props.AlbumTitle
  sourceAppUserModelId = $session.SourceAppUserModelId
  status = $info.PlaybackStatus.ToString()
}
$obj | ConvertTo-Json -Compress
`);
    if (!out) return null;
    try {
      return JSON.parse(out) as NowPlaying;
    } catch {
      return null;
    }
  },
  async openSpotifyUri(uri: string): Promise<string> {
    // spotify:track:xxx or https://open.spotify.com/track/xxx
    // `start` is a cmd builtin; use Start-Process directly.
    const safeUri = uri.replace(/['"]/g, '');
    await runPs(`Start-Process -FilePath '${safeUri}'`, 4000);
    return 'ok';
  },
};

import { watchedWindowsDialog } from './folder-dialog.mjs';
import { exec } from './util.mjs';

/** Choose a local executable without opening or executing the selected file. */
export async function chooseEngineFile({ platform = process.platform, run = exec, windowsDialog = watchedWindowsDialog } = {}) {
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Show(); $owner.Activate()',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = 'Choose the Strata engine executable'",
      "$dialog.Filter = 'Executables (*.exe)|*.exe|All files (*.*)|*.*'",
      '[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()',
      'if ($dialog.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($dialog.FileName) }',
      '$dialog.Dispose(); $owner.Close(); $owner.Dispose()',
    ].join('; ');
    const args = ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
    try {
      const result = await windowsDialog(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args);
      if (result.noDialog) return { unavailable: true };
      const path = String(result.stdout ?? '').split(/\r?\n/).filter(line => line.trim() && line.trim() !== 'READY').join('\n').trim();
      return path ? { path } : { cancelled: true };
    } catch { return { unavailable: true }; }
  }
  try {
    const result = platform === 'darwin'
      ? await run('osascript', ['-e', 'POSIX path of (choose file with prompt "Choose the Strata engine executable")'])
      : await run('zenity', ['--file-selection', '--title=Choose the Strata engine executable']);
    return result.stdout.trim() ? { path: result.stdout.trim() } : { cancelled: true };
  } catch (error) { return error?.code === 'ENOENT' ? { unavailable: true } : { cancelled: true }; }
}

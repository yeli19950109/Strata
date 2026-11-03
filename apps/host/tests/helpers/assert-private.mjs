import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { currentUserSid } from '../../server/private-file.mjs';

/** The effective protection of a file: mode 0600 on POSIX, the exact DACL (one protected entry for this user) on NTFS. */
export function assertPrivate(path) {
  if (process.platform !== 'win32') { assert.equal(statSync(path).mode & 0o777, 0o600); return; }
  // Avoid PowerShell module auto-loading: hosted runners may inherit a
  // PSModulePath from a different PowerShell version. This reads the same
  // security descriptor directly using the Windows .NET API.
  const sddl = execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `[IO.File]::GetAccessControl('${path.replace(/'/g, "''")}').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)`],
    { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();
  const dacl = sddl.slice(sddl.indexOf('D:'));
  assert.equal(dacl, `D:PAI(A;;FA;;;${currentUserSid()})`, `ACL is not owner-only: ${sddl}`);
}

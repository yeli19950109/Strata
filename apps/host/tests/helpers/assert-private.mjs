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
  const script = `$ErrorActionPreference='Stop'; $acl=[IO.File]::GetAccessControl($env:STRATA_TEST_ACL_PATH); $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $env:STRATA_TEST_ACL_SID -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL is not owner-only' }; 'ok'`;
  const result = execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, STRATA_TEST_ACL_PATH: path, STRATA_TEST_ACL_SID: currentUserSid() } }).trim();
  assert.equal(result, 'ok');
}

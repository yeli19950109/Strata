# Fork CI

This fork runs **Desktop client** on relevant pushes and pull requests using Windows x64 runners. It runs the
complete host test suite, browser import test, type check and frontend build, checks signed external engine updates
and release configuration, then builds an unsigned Windows NSIS test package. The package stages pinned, verified
Node and Python runtimes and locked Python wheels; it does not build or download an engine or model.

The Actions artifact is a **test build**, not a release installer. It does not include an engine or the optional
DeepSeek Harness, is not signed, has no updater metadata and expires after seven days. Select or install an engine
before loading a model. Existing platform-specific skips in the host suite still apply; no test name filter is used.

The upstream **Minimal serving runtime** workflow is manual-only in this fork because it is Linux-specific. Its full
server suite is therefore not run automatically on Windows. Choose **Run workflow** in Actions to run that Linux
check manually. The general PR title check may still use a Linux runner; it checks metadata and does not test or
package the client. Restore automatic Linux runtime checks by reviewing and restoring the upstream triggers in
`.github/workflows/terminal-minimal-server.yml`.

**Metal build**, **Portable monitor client** and **Scripts test** are manual-only in this fork. In GitHub Actions choose
one of them and select **Run workflow** to run it once. Docker engine-image publishing was already manual-only and stays
so; do not run it for this fork without first reviewing its upstream registry and signing settings. To restore upstream
automatic triggers, inspect the upstream version of each file and restore its `on:` triggers, then review and commit the
change. For example, with an upstream commit already available locally, run
`git show UPSTREAM_COMMIT:.github/workflows/metal-build.yml` to inspect its original triggers. Repeat for
`terminal-portable-monitor.yml` and `scripts-test.yml` as needed. Issue and PR management workflows remain unchanged;
they do not compile an engine.

For a publishable fork release, use the fork's `yeli19950109/Strata` release and updater metadata, and a signing key that
matches the updater public key in the client. Configure and verify those separately before publishing; this CI does not
create a key, disable signature checks, publish metadata or upload a release. Engine component manifests and downloads
remain on their existing upstream source and are separate from client releases.

## Fork updater release preparation

`Prepare signed fork release` is a separate, manually dispatched workflow. It only runs in
`yeli19950109/Strata` on an existing tag of the form `vMAJOR.MINOR.PATCH`, matching the desktop npm, Cargo and Tauri
versions. It runs the complete client test suite on Windows, stages the same verified runtime dependencies, and builds a
Windows x64 NSIS updater artifact without downloading an engine. It verifies the Tauri signature against the public
key embedded by that build, then re-verifies the artifact before creating a
**draft** GitHub release. It never publishes the draft. Existing releases are not overwritten.

Before the first production use, the owner must approve generating a **new fork-only** Tauri minisign key pair in a
secure place. Do not commit or send the private key. After that separate approval, configure these repository settings:

- Variable `FORK_TAURI_PUBLIC_KEY`: the complete Tauri public key content, the same for every release in this key series.
- Secret `TAURI_SIGNING_PRIVATE_KEY`: the corresponding private key content, stored only as an Actions secret.
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password, when the private key is password protected.
- Environment `fork-release`: configure required reviewers if the owner wants an Actions approval before the draft job.

Missing keys, an upstream public key, a mismatched private/public pair, a missing Windows artifact, a bad signature or a
version/tag mismatch fails the workflow. It never turns off signature checking. The public key is injected through a
Tauri configuration overlay during every release build; the inherited key in the checked-in default config is not a fork
release key. A user must install the first fork-key build manually before receiving later updates signed by the same key.
Changing the key breaks updates for already installed clients unless a separately designed key migration is performed.
Ordinary desktop CI creates unsigned test artifacts and is not an updater release.

The draft contains a Windows `.exe`, its `.sig` and `latest.json` with only the Windows x64 platform and a URL
under the fork tag. The Tauri update signature is **not** Windows Authenticode; SmartScreen may block an unsigned
installer. Do not publish the draft as a production release until Windows distribution requirements are addressed.
No production key or secret is created by this repository change. Engine feed signatures and their upstream keys
remain independent.

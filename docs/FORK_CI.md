# Fork CI

This fork runs **Desktop client** on relevant pushes and pull requests. It type-checks, tests and builds the host UI,
checks the external engine updater with signed temporary stubs, then builds unsigned Windows NSIS, Linux deb and Apple Silicon macOS app test packages. The updater test runs on all three platforms and uses only Python’s standard library; it uses a loopback test feed and does not download a real engine, execute one or use a GPU. The **Minimal serving runtime**
workflow stays automatic: the desktop uses the same Python server and Control code. The desktop package job stages the
pinned, verified Node and Python runtimes and locked Python wheels. It does not build or download an engine or model.

These Actions artifacts are **test builds**, not release installers: they do not include an engine or the optional DeepSeek
Harness (agent features need the latter). This includes macOS, unlike the upstream release DMG that bundles Metal. They
are not signed, do not include updater metadata and are not published as a GitHub release. Install an engine explicitly or
select an existing one before loading a model. Artifacts expire after seven days.

The host test step runs the complete `tests/*.test.mjs` suite without a name filter. Three tests failed on the clean
baseline in the development container: the old app-update test uses a Windows executable name on Linux, the parent-exit
test can mistake an unreaped zombie for a live process, and the time-skip test left an orphaned grandchild. Their results
on GitHub-hosted runners have not been verified; CI does not suppress them.

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
versions. It runs the complete client test suite, stages the same verified runtime dependencies, and builds Windows
NSIS, Linux AppImage and macOS app updater artifacts without downloading an engine. It verifies each Tauri signature
against the public key embedded by that build, then combines and re-verifies all three artifacts before creating a
**draft** GitHub release. It never publishes the draft. Existing releases are not overwritten.

Before the first production use, the owner must approve generating a **new fork-only** Tauri minisign key pair in a
secure place. Do not commit or send the private key. After that separate approval, configure these repository settings:

- Variable `FORK_TAURI_PUBLIC_KEY`: the complete Tauri public key content, the same for every release in this key series.
- Secret `TAURI_SIGNING_PRIVATE_KEY`: the corresponding private key content, stored only as an Actions secret.
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password, when the private key is password protected.
- Environment `fork-release`: configure required reviewers if the owner wants an Actions approval before the draft job.

Missing keys, an upstream public key, a mismatched private/public pair, missing platform files, a bad signature or a
version/tag mismatch fails the workflow. It never turns off signature checking. The public key is injected through a
Tauri configuration overlay during every release build; the inherited key in the checked-in default config is not a fork
release key. A user must install the first fork-key build manually before receiving later updates signed by the same key.
Changing the key breaks updates for already installed clients unless a separately designed key migration is performed.
Ordinary desktop CI creates unsigned test artifacts and is not an updater release.

The draft contains `.exe`, `.AppImage` and `.app.tar.gz` updater files, their `.sig` files and `latest.json` with URLs
under the fork tag. The Tauri update signature is **not** Windows Authenticode or Apple Developer signing/notarization.
The workflow does not configure those OS signing credentials; macOS Gatekeeper and Windows SmartScreen may block an
unsigned OS package. Do not publish the draft as a production release until OS distribution requirements are addressed.
If a macOS app is code-signed or notarized afterward, rebuild its updater archive, sign the final archive again and
regenerate/verify `latest.json`; never publish metadata for the earlier archive. No production key or secret is created
by this repository change. Engine feed signatures and their upstream keys remain independent.

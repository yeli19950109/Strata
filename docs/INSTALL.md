# Install Strata

This page is for anyone installing or updating Strata (version 0.2.5). Use the **desktop app** for a graphical
interface, or the **Terminal** for `strata launch` and coding tools. Both use released engine packages. A normal
install does not need a source checkout or a startup `.bat` file.

## Quick start

| I want | Do this |
| --- | --- |
| A window with chat | Download the installer from the [latest release](https://github.com/Niko1221/Strata/releases/latest) ([steps](#the-app)) |
| The terminal, or my coding tool | Run the one-line install, then `strata launch` ([steps](#the-terminal)) |
| DeepSeek V4.1-Flash | Pick it in the app, or run `strata launch --family deepseek41` ([model page](MODELS.md#deepseek-v41-flash)) |

[Requirements](#what-you-need) · [Desktop app](#the-app) · [Terminal](#the-terminal) ·
[Update](#updating) · [Files and folders](#where-things-are-stored) · [Build from source](SOURCE_INSTALL.md)

## What you need

| Computer | Guide |
| --- | --- |
| Windows 10/11 or Linux x86-64 with an NVIDIA RTX GPU | Use the app or the Terminal. The engine for your card is downloaded for you. [Older NVIDIA cards](OLDER_GPUS.md) use the CUDA 12 engine. DeepSeek V4.1-Flash runs on RTX 30, 40 and 50 cards in the app and the Terminal. |
| Windows or Linux x86-64 with a supported AMD Radeon | [AMD guide](AMD_HIP.md), including the card-to-package table. DeepSeek V4.1-Flash runs on the Radeon AI PRO R9700 under Linux, in the app and the Terminal. |
| Linux x86-64 with Intel Arc | [Intel Arc guide](INTEL_ARC.md); install the driver/compute runtime and check model preparation requirements |
| Apple Silicon Mac, macOS 15 or newer | [Mac guide](MAC.md). Intel Macs are not supported by the Mac package. |
| AMD Ryzen AI Max / Strix Halo | [Strix Halo guide](STRIX_HALO.md) |
| NVIDIA DGX Spark (Linux ARM64) | [DGX Spark guide](DGX_SPARK_LINUX.md). Use the Terminal; there is no desktop app for ARM64 Linux. |

Memory and disk needs depend on the **model, quantization, context and enabled features**. Check
[which model fits](MODELS.md#pick-by-memory); download size is not the same as RAM use. Unified memory counts once.
Use an SSD and leave room for helper files and model preparation. The Terminal's `--plan` prints what is missing.

Install a graphics driver that supports the package you choose. CUDA 13 packages require NVIDIA driver 580 or newer;
older NVIDIA cards use CUDA 12. AMD and Intel requirements are in their guides. Packaged GPU runtimes do not replace
hardware drivers. Models and updates need an internet connection to download.

## The app

1. Open the [latest release](https://github.com/Niko1221/Strata/releases/latest).
2. Download the one installer for your system. There is one per system, not one per graphics card:
   - **Windows:** run `Strata-0.2.9-windows-x64-setup.exe`. It installs for your user and needs no administrator rights.
   - **Linux:** make `Strata-0.2.9-linux-x86_64.AppImage` executable, then open it. If FUSE is unavailable, run the
     downloaded file with `--appimage-extract-and-run`. [Linux help](TROUBLESHOOTING.md).
   - **Mac:** open `Strata-0.2.9-macos-arm64.dmg`, drag Strata into Applications, then open it. [Mac help](MAC.md).
3. On Windows and Linux the installer has no engine inside. On first start the app shows the engine for your
   graphics card with its size and one **Download** button, with progress and resume. If you already downloaded the
   engine file, choose **I already have the file** and it installs without internet. The Mac file keeps its small
   Metal engine inside.
4. Choose a model and its storage folder, let it download, then chat. DeepSeek V4.1-Flash is in the model list on
   the supported cards ([model page](MODELS.md#deepseek-v41-flash)); it has three sizes, an 8K context and a **Speed**
   choice, Faster or Full quality.

The `strata-engine-…` and `strata-control-…` archives on the release page are components, not installers. The
installer is the same file for a first install and for an update. There is no Intel desktop installer yet; Intel Arc
runs on Linux only, through the [Terminal](INTEL_ARC.md).

The first launch can take time to check and prepare large model files. Watch its progress and logs; there is no fixed
startup time for every model or computer. Closing the desktop app stops its managed engine.

### Use an existing engine and run configuration

On the first engine screen, choose **Use an existing engine** and enter the full path to its executable. You can
also find this choice under **Models → Existing engine configurations**. Strata references the executable in place;
it does not move or delete it. Stop loaded models before changing the selection. If its drive is disconnected,
the selection stays saved; reconnect the drive before loading a model. Choose **Stop using this engine** to return to
the app-managed engine.

To update a selected external engine, open **Use an existing engine**, choose **Check external engine update**, and
review the current version, target version and path. The update starts only after confirmation and saves a backup first.
Stop models in the app and stop any other command-line engine processes before updating; another program could start one
again while the update runs. The updater accepts only intact, signed standard engine packages with a complete signed file
list. Older official Windows HIP ZIPs as well as custom layouts may lack that list. The app cannot safely update them in
place without it. Back up the existing files and install an official signed component in a separate folder, then select
its executable; your original engine, models and JSON stay in place. If using an imported JSON, also update a separate
copy as described below. The path alone cannot establish whether a particular old engine has a usable signed list.
Reconnect an offline drive before checking or restoring. If an update is interrupted, use the restore prompt after restart
to restore the verified backup. On macOS the app cannot reliably detect a running command-line engine, so it refuses
this update; stop it and update manually. Automatic external-engine updates are implemented for Windows and Linux;
Windows has not yet been verified on native hardware. While external references
are present, some managed-engine install/rollback and model-folder moves are
paused to protect files those references may use.
Recovery leaves any files added by the interrupted update in place to avoid deleting files it cannot prove ownership of.
Their paths are shown after recovery; review them before retrying, because existing files can prevent a later update.

To bring in a command-line run, choose **Import run JSON** on that screen (or **Use an existing engine and JSON
configuration** on first start). Review the configuration and the changes listed, give it a unique name, and confirm.
The app saves its own copy without starting the model or downloading an engine. The original JSON, engine, models and
libraries stay in place; **Remove from Strata** removes only the app's copy. Reconnect missing drives before loading.
Use absolute paths for the working directory, tokenizer, log and library directories; engine and known model argument
paths may be relative to an absolute working directory.
An imported configuration's explicit `exe` takes precedence over the globally selected engine. If you move an old
engine to a new folder, edit a separate copy of the JSON to name the new `exe`, then import it under a new name; selecting
the new engine alone does not change the imported configuration. Keep the original JSON and files until the new setup
has been checked.

Imported engine arguments are passed in their original order. The app server uses localhost and its own port and API
key, disables automatic browser opening, adds an alias and may increase the startup timeout. Other settings that would
rewrite the engine arguments are not applied to an imported run. If the configuration has a `before_load` command,
the app shows it for confirmation each time before loading. If the configuration changes after that review, review it
again. The command runs when the model starts. The server may adjust GPU and HIP environment settings for the selected
hardware.
Paths in the imported `env` are kept as written. An external HIP tuning file referenced there is not updated with the
engine; check that it is compatible with the new engine before starting the model.

The provider order recommended here is **ISTA-DASLab, Unsloth, Gyro, then others**, when a compatible pack fits.
Current app recommendations can differ; choose the model explicitly when you want a particular provider.

## The Terminal

Install once, then use `strata launch`. The Terminal includes Python and downloads the engine for your computer.

**Linux / Mac**

```sh
curl -fsSL https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o install.sh && sh install.sh
```

**Windows PowerShell**

```powershell
irm https://github.com/Niko1221/Strata/releases/latest/download/install.ps1 | iex
```

On Windows, open a **new terminal** afterwards. On Linux and Mac, if `strata` is not found, use the full path printed
by the installer (normally `~/.local/bin/strata`) or add that folder to your shell's PATH.

```sh
strata launch
```

Follow the screens to choose a model, context, storage folder and access settings. The monitor opens after startup.
Use the address printed by Strata; the default local endpoint is `http://127.0.0.1:8080`.
The Terminal opens a browser only when you add `--open`.

For a script or AI agent, inspect a plan before downloading. This example selects ISTA-DASLab Q2_0 explicitly:

```sh
strata launch --family qwen --model q2_0 --plan
strata launch --family qwen --model q2_0 --yes --no-tui
```

`--no-tui` leaves the server running in the background. Check it, connect a tool, or stop it:

```sh
strata launch --status
strata connect
strata launch --stop
```

If a model is already running with different settings, add `--restart` to replace that run; `--yes` alone does not
restart it. A restart interrupts current answers. See [all launch options](TERMINAL_LAUNCH.md),
[advanced Terminal commands](TERMINAL.md), and [agent setup](AI_SETUP.md).

## Updating

**Desktop app:** open Settings and find the update controls, check for updates, and use the offered app or engine update.
Unload running models before replacing the engine. Your model files and settings are kept.

**Terminal:**

```sh
strata update --check
strata update
strata --version
```

With a model loaded, `strata update` says which model, asks before it stops it, downloads the new engine while the model keeps
serving, stops it cleanly, updates, and asks whether to start it again with the same settings (answer no and it stays stopped;
the start line is printed). If the update fails the old engine stays in use and the model can be started again. The launch
monitor and the start screen show one quiet line when a newer engine is available; press `u` in the monitor to update.
In a script nothing is asked: `--yes` alone never stops a model (exit 7, nothing changed); `--stop-model` lets the update stop it
and `--start-again` starts it again afterwards (exit 8 if it did not start again). The next Terminal command uses the updated
Control component. The app, Control and engine have separate version numbers, so they can differ.

Use `strata components rollback` to return to the previous engine. See [update details](../packaging/UPDATES.md).
Source checkouts have a [separate update workflow](SOURCE_INSTALL.md#updating).

## Where things are stored

| Item | Default location |
| --- | --- |
| Desktop chats and host state | `~/.strata` (or `STRATA_HOME`) |
| Engine components, Windows | `%LOCALAPPDATA%\Strata\components` |
| Engine components, Linux / Mac | `$XDG_DATA_HOME/strata/components`, normally `~/.local/share/strata/components` |
| Terminal files | The `terminal` folder beside `components`; the installer prints the exact path |
| Models | The folder chosen in the app or launch screens; an existing model library is reused |

The desktop app normally proposes `Documents/Strata/Models` for a new library. The Terminal discovers saved
folders from earlier installs. Use the path shown by the app or `strata models list`, not an assumed folder name.
`--data-dir` changes where new downloads go; it does not move existing models unless you add `--move-data`.
See [model discovery](TERMINAL_LAUNCH.md#models-you-already-have).

## More options

- [Docker](DOCKER.md)
- [Build or run from a source checkout](SOURCE_INSTALL.md)
- [Multiple GPUs](MULTI_GPU.md)
- [Troubleshooting and logs](TROUBLESHOOTING.md)
- [Model compatibility](MODELS.md)

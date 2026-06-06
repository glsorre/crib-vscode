# Devcontainers from your favorite IDE, in one click

`crib-vscode` is a VS Code and Cursor extension that wraps [crib](https://github.com/fgrehm/crib) — a thin, opinionated CLI for "just enough devcontainers" — and gives it a one-click flow inside your editor.

Open a project, press a key, and you get a fully provisioned devcontainer with your editor attached. No `devcontainer.json` ceremony, no waiting for the IDE to rebuild, no losing your current window.

## What it is

The project ships as **two** extensions:

- **`crib-vscode-main`** — the main extension. It runs as `extensionKind: ["workspace"]`, so it lives where your files and the `crib` CLI are: the same machine for a local window, or the **remote** for a Remote‑SSH window. It provides the Workspaces tree, the lifecycle/attach commands, and writes the Dev Containers `nameConfig` that attach actually reads.
- **`crib-vscode-attach-bridge`** — a tiny companion that runs as `extensionKind: ["ui"]`, i.e. on the machine showing your editor window.

**Why the split?** Dev Containers' "Attach to Running Container" is a **UI‑host** command — it is only registered on the machine running the editor window, never on a Remote‑SSH host. When the main extension is running on a remote, it has no attach command to call. The bridge exposes one (`crib.attachViaUiHost`) on the UI host so the remote can hand attach off to it. This is why **any Remote‑SSH setup needs the bridge** — VS Code and Cursor alike.

## Requirements

- VS Code 1.105+ or Cursor
- Dev Containers extension, on the **UI host**, where attach runs:
  - VS Code: [`ms-vscode-remote.remote-containers`](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
  - Cursor: `anysphere.remote-containers`
- [crib](https://github.com/fgrehm/crib) on `PATH` (or set `crib.path`)
- Docker or Podman on the workspace host

## Install

Both extensions are published to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) and [Open VSX](https://open-vsx.org/):

- Main: `rightright-me.crib-vscode-main`
- Bridge: `rightright-me.crib-vscode-attach-bridge`

Install from the Extensions view. In a Remote‑SSH window the view offers **"Install in SSH: …"** for the remote and a local install for the UI host — make sure each extension lands on the right side per the matrix below.

### Install matrix

`workspace host` = machine running your files / the `crib` command. `UI host` = machine showing the editor window.

| Scenario | `crib-vscode-main` | `crib-vscode-attach-bridge` |
|---|---|---|
| Local folder window | UI host (same machine) | Not required |
| Remote‑SSH — VS Code **or** Cursor | Workspace host (remote) | **UI host (local) — required** |
| WSL / attached‑container | Workspace host | UI host (local) — required for attach |

For a local window the main extension and the Dev Containers extension are on the same machine, so attach is direct and the bridge is unnecessary. Any time the main extension runs on a different host than the editor window (Remote‑SSH, WSL), install the bridge locally too.

## Usage

The extension contributes a **Workspaces** view (look for *Crib* in the activity bar / Remote Explorer) listing the crib containers it can see. Right‑click a row for actions, or run any command from the Command Palette:

| Command | What it does |
|---|---|
| `crib.up` | Bring the container up (`crib up`) |
| `crib.attach` | Sync the nameConfig and attach the editor to the container |
| `crib.down` | Stop the container |
| `crib.restart` | Restart the container |
| `crib.rebuild` | Rebuild the container |
| `crib.remove` | Remove the container and its nameConfig |
| `crib.syncNow` | Sync nameConfigs from `devcontainer.json` |
| `crib.openConfig` | Open the generated nameConfig |
| `crib.openDevcontainerJson` | Open the project's `devcontainer.json` |
| `crib.refresh` | Refresh the Workspaces view |
| `crib.focusOutput` | Show the **Crib** output log |

## Settings

| Setting | Default | Description |
|---|---|---|
| `crib.path` | `"crib"` | Path to the `crib` executable. Defaults to looking it up on `PATH`. |
| `crib.autoUpOnAttach` | `true` | When attaching, automatically run `crib up` if the workspace's container is not running. |
| `crib.extraExtensions` | `[]` | Extra extension IDs to install on every attached crib container, in addition to those in `devcontainer.json`. |
| `crib.includeFeatureExtensions` | `true` | Merge `customizations.vscode.extensions` contributed by devcontainer features (from the image's `devcontainer.metadata` label, with a best‑effort OCI manifest fetch fallback). |
| `crib.featureManifestFetch` | `true` | Allow fetching feature manifests from OCI registries when the image is not yet built. Disable for fully offline environments. |
| `crib.forwardSshAgent` | `true` | Forward `SSH_AUTH_SOCK` to the `crib` subprocess so its `ssh` plugin can bind‑mount the agent socket into the container. Set to `false` if `crib up`/`rebuild` fails with `invalid mount config … permission denied` because the agent socket is unreadable. |

## Troubleshooting

### "Install the Crib Attach Bridge" when attaching over Remote‑SSH

This is expected when the bridge isn't installed on your **local** machine. Over Remote‑SSH the main extension runs on the remote, where no Dev Containers attach command exists, so attach is routed to the UI‑host bridge command — which only exists if `crib-vscode-attach-bridge` is installed locally.

**Fix:** install `rightright-me.crib-vscode-attach-bridge` on your local machine, reload the window, and retry attach.

**Diagnose:** open the **Crib** output channel (`crib.focusOutput`). On attach it logs the resolved route, e.g. `[attach] target=uiBridge`. At startup it also logs whether a Dev Containers extension is present but its attach command isn't registered on the current host — useful for confirming why the bridge path was taken.

## Key features

- **One-click up, attach, and down** — three commands, no configuration files required
- **Works in VS Code and Cursor** — the companion bridge makes both editors' Remote‑SSH attach flow reliable
- **Wraps `crib`, doesn't replace it** — you keep the CLI for everything else
- **Multi-root workspace aware** — picks the right container for the active workspace
- **Output channel logging** — see exactly what's happening, no black box
- **Open source** — TypeScript, MIT-licensed, contributions welcome

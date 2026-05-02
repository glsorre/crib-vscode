# crib for VS Code / Cursor

Run [crib](https://github.com/fgrehm/crib) from the editor and keep Dev Containers `nameConfigs/<container>.json` synced from `devcontainer.json`, so attach installs the expected extensions.

For project status and architecture notes, see [SPEC.md](https://github.com/glsorre/crib-vscode/blob/master/SPEC.md).

## Quick start

1. Build VSIX files from repo root:

```sh
npx vsce package
(cd ui-bridge && npx vsce package --no-rewrite-relative-links -o crib-vscode-attach-bridge-0.1.1.vsix)
cp ./ui-bridge/crib-vscode-attach-bridge-0.1.1.vsix ./
```

2. Install the main extension where your workspace runs:
   - local folder window: local machine
   - Remote-SSH: remote host
3. If using Cursor Remote-SSH, also install the bridge on your local UI machine.
4. Open Command Palette and run: `Crib: Up`.
5. Run: `Crib: Attach to Container`.

## Install matrix

`workspace host` = machine running your files/crib command.  
`UI host` = machine showing the editor window.

| Scenario | Install `crib-vscode-main` | Install `crib-vscode-attach-bridge` |
|---|---|---|
| Local folder window | UI host (same machine) | Not required |
| VS Code Remote-SSH | Workspace host (remote) | Not required |
| Cursor Remote-SSH | Workspace host (remote) | UI host (local) |

Main extension ID: `rightright-me.crib-vscode-main`

## Install commands

### Main extension (workspace host)

```sh
cursor --install-extension ./crib-vscode-main-0.1.1.vsix --remote ssh-remote+PASTE_AUTHORITY_HERE
cursor --list-extensions --remote ssh-remote+PASTE_AUTHORITY_HERE | rg rightright-me.crib-vscode-main
```

For a local window, install without `--remote`:

```sh
cursor --install-extension ./crib-vscode-main-0.1.1.vsix
```

### Bridge extension (Cursor Remote-SSH UI host only)

```sh
cursor --install-extension ./crib-vscode-attach-bridge-0.1.1.vsix
```

## Use it

Typical flow:

1. `Crib: Up`
2. `Crib: Sync nameConfigs from devcontainer.json` (usually optional; run if you edited devcontainer files)
3. `Crib: Attach to Container`

Core commands:

| Command | Purpose |
|---|---|
| `Crib: Up` | Start container and sync nameConfig |
| `Crib: Down` | Stop container |
| `Crib: Restart` / `Crib: Rebuild` | Recreate container, then sync |
| `Crib: Attach to Container` | Attach via Dev Containers (directly or through bridge) |
| `Crib: Open Generated nameConfig` | Open generated `nameConfigs/<name>.json` |
| `Crib: Show Crib Output Log` | Show activation and troubleshooting logs |

## Settings

| Setting | Default | Use when |
|---|---|---|
| `crib.path` | `crib` | Crib binary is not on `PATH` |
| `crib.autoUpOnAttach` | `true` | You want attach to auto-start container |
| `crib.extraExtensions` | `[]` | You always want extra editor extensions in containers |
| `crib.includeFeatureExtensions` | `true` | You want extensions from devcontainer features |
| `crib.featureManifestFetch` | `true` | Disable for strict offline environments |

## Troubleshooting

- Extension appears only under **Local** in Remote-SSH:
  - install `crib-vscode-main` on the workspace host (`Install in SSH` or `--remote`).
- `Crib` commands missing:
  - reload window, then run `Crib: Show Crib Output Log`.
- Attached container has missing extensions:
  - run `Crib: Sync nameConfigs from devcontainer.json`,
  - run `Crib: Open Generated nameConfig`,
  - then re-attach.
- Cursor Remote-SSH attach fails:
  - confirm bridge is installed on UI host and check `Crib (UI bridge)` output channel.

## Requirements

- VS Code 1.105+ or Cursor
- Dev Containers extension where attach runs:
  - VS Code: [`ms-vscode-remote.remote-containers`](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
  - Cursor: `anysphere.remote-containers`
- [crib](https://github.com/fgrehm/crib) on `PATH` (or set `crib.path`)
- Docker or Podman on the workspace host

## License

See [LICENSE](https://github.com/glsorre/crib-vscode/blob/master/LICENSE).

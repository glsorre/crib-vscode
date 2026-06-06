# Crib Attach Bridge

UI-host companion for the main extension (`rightright-me.crib-vscode-main`).

This extension is `extensionKind: ["ui"]` and should be installed on the machine running your editor window. It does not provide `crib` lifecycle commands or the Crib workspaces tree.

For full setup and user workflow, see the main [README](https://github.com/glsorre/crib-vscode/blob/master/README.md).

## When you need it

- **Required:** any Remote-SSH window — **VS Code and Cursor alike** (the main extension runs on the remote, the bridge runs on the local UI host). Also WSL / attached-container windows.
- **Not required:** local folder windows, where the main extension and Dev Containers run on the same machine and attach is direct.

The bridge is needed because Dev Containers' "Attach to Running Container" is a UI-host command that is never registered on a Remote-SSH host, so the remote main extension has nothing to call without it.

## Install

Recommended — install from the Marketplace / Open VSX on the **local** machine:

```
rightright-me.crib-vscode-attach-bridge
```

Or build and install the vsix from the repo root:

```sh
cd ui-bridge
npx vsce package --no-rewrite-relative-links -o ../crib-vscode-attach-bridge.vsix
cd ..
# VS Code:
code --install-extension ./crib-vscode-attach-bridge.vsix
# Cursor:
cursor --install-extension ./crib-vscode-attach-bridge.vsix
```

## How it works

- The main extension calls internal command `crib.attachViaUiHost`.
- The bridge triggers Dev Containers attach from the UI host.
- Use output channel `Crib (UI bridge)` for attach diagnostics.

## Remote-SSH reminder

- Main extension (`crib-vscode-main`) installs on workspace host (remote).
- Bridge (`crib-vscode-attach-bridge`) installs on UI host (local).

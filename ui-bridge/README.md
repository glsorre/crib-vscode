# Crib Attach Bridge

UI-host companion for the main extension (`rightright-me.crib-vscode-main`).

This extension is `extensionKind: ["ui"]` and should be installed on the machine running your editor window. It does not provide `crib` lifecycle commands or the Crib workspaces tree.

For full setup and user workflow, see the main [README](https://github.com/glsorre/crib-vscode/blob/master/README.md).

## When you need it

- **Required:** Cursor Remote-SSH (main extension is remote, bridge is local UI host)
- **Usually not required:** local folder windows or standard VS Code Remote-SSH

## Install

From repo root:

```sh
cd ui-bridge
npx vsce package --no-rewrite-relative-links -o crib-vscode-attach-bridge-0.1.1.vsix
cd ..
cp ./ui-bridge/crib-vscode-attach-bridge-0.1.1.vsix ./
cursor --install-extension ./crib-vscode-attach-bridge-0.1.1.vsix
```

## How it works

- The main extension calls internal command `crib.attachViaUiHost`.
- The bridge triggers Dev Containers attach from the UI host.
- Use output channel `Crib (UI bridge)` for attach diagnostics.

## Remote-SSH reminder

- Main extension (`crib-vscode-main`) installs on workspace host (remote).
- Bridge (`crib-vscode-attach-bridge`) installs on UI host (local).

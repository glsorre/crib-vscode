# crib-vscode Developer Notes

This is not a sample "Hello World" extension. `crib-vscode-main` is a workspace
extension that runs where the workspace lives, including the Remote-SSH host.

## Local Development

- `npm run compile` type-checks the extension into `out/`.
- `npm run lint` runs ESLint over `src/`.
- `npm test` runs the VS Code extension test harness.
- `npx vsce package` builds a local VSIX.

## Remote-SSH Manual Test

Package locally, then install the VSIX on the SSH host:

```sh
npx vsce package
(cd ui-bridge && npx vsce package)
cursor --install-extension ./crib-vscode-main-0.1.1.vsix --remote ssh-remote+HOST
cursor --install-extension ./crib-vscode-attach-bridge-0.1.1.vsix
cursor --list-extensions --remote ssh-remote+HOST | rg crib
```

After reloading the Remote-SSH window, `Output: Crib` should show workspace-host
activation, the `Crib` activity-bar view should list discovered workspaces, and
`Crib: Attach to Container` should route through the local UI bridge when the
Dev Containers attach command is not registered in the workspace host.

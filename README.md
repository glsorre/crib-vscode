# Devcontainers from your favorite IDE, in one click

`crib-vscode` is a VS Code and Cursor extension that wraps [crib](https://github.com/fgrehm/crib) — a thin, opinionated CLI for "just enough devcontainers" — and gives it a one-click flow inside your editor.

Open a project, press a key, and you get a fully provisioned devcontainer with your editor attached. No `devcontainer.json` ceremony, no waiting for the IDE to rebuild, no losing your current window.

## Requirements

- VS Code 1.105+ or Cursor
- Dev Containers extension where attach runs:
  - VS Code: [`ms-vscode-remote.remote-containers`](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
  - Cursor: `anysphere.remote-containers`
- [crib](https://github.com/fgrehm/crib) on `PATH` (or set `crib.path`)
- Docker or Podman on the workspace host

## Getting Started

The project is composed of 2 extensions:

- `crib-vscode-main` the main extensions
- `crib-vscode-attach-bridge` the extension needed in cursor to interoperate with `
anysphere.remote-ssh`

### Install matrix
`workspace host` = machine running your files/crib command.  
`UI host` = machine showing the editor window.

| Scenario | Install `crib-vscode-main` | Install `crib-vscode-attach-bridge` |
|---|---|---|
| Local folder window | UI host (same machine) | Not required |
| VS Code Remote-SSH | Workspace host (remote) | Not required |
| Cursor Remote-SSH | Workspace host (remote) | UI host (local) |

## Key features

- **One-click up, attach, and down** — three commands, no configuration files required
- **Works in VS Code and Cursor** — companion bridge extension makes Cursor's Remote-SSH flow reliable
- **Wraps `crib`, doesn't replace it** — you keep the CLI for everything else
- **Multi-root workspace aware** — picks the right container for the active workspace
- **Output channel logging** — see exactly what's happening, no black box
- **Open source** — TypeScript, MIT-licensed, contributions welcome

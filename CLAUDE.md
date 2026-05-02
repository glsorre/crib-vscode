# crib-vscode

VS Code / Cursor extension that wraps `crib` (devcontainer CLI) and bridges its containers into the editor's container UI.

## Spec.md

We are building the VS Code / Cursor extension described in @SPEC.md. Read that file for general architectural tasks or to double check the tech stack or application architecture.

## Why

The dev-containers extension's "Attach to Running Container" mode ignores `customizations.vscode.extensions` from `devcontainer.json`. Users have to maintain `nameConfigs/<container>.json` by hand. This extension does it for them, plus wraps `crib up`/`down`/`attach` as commands.
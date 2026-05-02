# crib-vscode — specification (snapshot)

## 1. Purpose

**crib-vscode** is a **VS Code / Cursor workspace extension** that:

1. **Keeps Dev Containers “name configs” in sync** with each workspace’s `devcontainer.json`, so “Attach to Running Container” installs the extensions you declared (including from features), instead of relying on hand-maintained `nameConfigs/<container>.json`.
2. **Exposes [crib](https://github.com/fgrehm/crib)** lifecycle and attach as editor commands and tree actions (`up`, `down`, `restart`, `rebuild`, `remove`, `attach`, `syncNow`, etc.).

**Problem it solves:** Dev Containers’ attach path does not consume `customizations.vscode.extensions` from `devcontainer.json` the way users expect; this extension writes the shape Dev Containers *does* read for named containers.

## 2. Product split

| Piece | Role |
|--------|------|
| **Main extension** (`crib-vscode-main`) | Runs as **`extensionKind: ["workspace"]`**: file access, `crib` CLI, Docker/Podman via crib, writing Dev Containers `globalStorage` nameConfigs. |
| **UI attach bridge** (`ui-bridge/`) | Optional **local (UI host)** companion so attach can invoke Dev Containers when the workspace extension cannot drive the UI host directly (e.g. Cursor Remote-SSH). |

## 3. Functional requirements (as implemented / documented)

- **Sync engine:** Scan + `FileSystemWatcher` on `devcontainer.json` (and related paths); merge feature extensions (image `devcontainer.metadata` preferred; optional OCI feature manifest fetch + cache).
- **Commands & UI:** Activity bar “Crib” view (workspaces, state, actions); palette commands; remote indicator menu entries gated on `remoteName` / workspace host.
- **Attach:** Resolve target container name, optional `crib.autoUpOnAttach`, then Dev Containers attach API or bridge command.
- **Settings:** `crib.path`, `crib.autoUpOnAttach`, `crib.extraExtensions`, `crib.includeFeatureExtensions`, `crib.featureManifestFetch`.

## 4. Non-functional / platform

- **Engine:** VS Code `^1.105.0` (see `package.json`).
- **Dependencies:** Runtime `jsonc-parser`; dev stack TypeScript, ESLint, `@vscode/test-*`.
- **Distribution:** Publisher `rightright-me`, extension id `rightright-me.crib-vscode-main` (see README); OpenVSX / VSIX workflows documented there.

## 5. Known limitations (documented)

- Pre-build feature resolution: anonymous OCI/bearer-style only; private registries beyond that → rely on post-build metadata.
- Only **nameConfigs**, not **imageConfigs**.
- Main extension not supported as UI-only for sync/lifecycle; bridge is attach-oriented on the UI host.

---

## Current status (repository state)

**Versioning:** `package.json` lists **`0.1.1`** for both packages; [README.md](README.md) and [ui-bridge/README.md](ui-bridge/README.md) install examples use matching VSIX names—update them when you bump `version`.

**Recent direction (from source layout):** Core areas include attach resolution (`attach.ts`, `attachPayload.ts`), target discovery (`targetDiscovery.ts`), sync (`sync.ts`), optional rebuild coordination (`rebuildQueue.ts`), container naming / ids (`containerName.ts`, `dockerContainerId.ts`), Dev Containers storage paths (`paths.ts`), structured output (`runtimeDebugLog.ts`), tree UI (`views.ts`), watchers (`watcher.ts`), and the **UI attach bridge** under `ui-bridge/`. Tests live under `src/test/`.

**Maintenance notes:** Keep `SPEC.md` updated when architecture or release status changes materially.

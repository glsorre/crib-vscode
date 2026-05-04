import { describe } from './util';
import * as vscode from 'vscode';
import { DEVCONTAINER_GLOBS, workspaceRootFor } from './devcontainer';
import { deleteNameConfig } from './nameConfig';
import { displayPath, nameConfigUri, DevContainerStorage } from './paths';
import { resolveContainerName } from './containerName';
import { CribCli } from './crib';
import { SyncEngine, SyncSource } from './sync';

const DEBOUNCE_MS = 300;

export interface WatcherDeps {
	readonly engine: SyncEngine;
	readonly storage: DevContainerStorage;
	readonly crib: CribCli | undefined;
	readonly output: vscode.OutputChannel;
}

/**
 * Install file watchers for every workspace folder + an activation-time
 * bootstrap scan. Returns a disposable that tears the whole machinery down.
 *
 * The bootstrap is what makes the sync feel "free": when the user opens a
 * project, the nameConfig is written before they ever click anything, so an
 * attach via the Dev Containers viewlet (which never goes through our
 * commands) already has the right extensions list.
 */
export function installWatchers(deps: WatcherDeps): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	const pending = new Map<string, NodeJS.Timeout>();

	const triggerSync = (uri: vscode.Uri, source: SyncSource) => {
		const key = uri.toString();
		const existing = pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		const handle = setTimeout(async () => {
			pending.delete(key);
			try {
				await deps.engine.sync(uri, { source });
			} catch (err) {
				deps.output.appendLine(
					`[watcher] sync failed for ${displayPath(uri)}: ${describe(err)}`,
				);
			}
		}, DEBOUNCE_MS);
		pending.set(key, handle);
	};

	const triggerDelete = async (uri: vscode.Uri) => {
		const key = uri.toString();
		const existing = pending.get(key);
		if (existing) {
			clearTimeout(existing);
			pending.delete(key);
		}
		try {
			const root = workspaceRootFor(uri);
			const name = await resolveContainerName(
				root,
				deps.crib,
				msg => deps.output.appendLine(msg),
			);
			const target = nameConfigUri(deps.storage, name);
			const removed = await deleteNameConfig(target);
			deps.output.appendLine(
				`[watcher] devcontainer.json deleted (${displayPath(uri)}); ` +
					`${removed ? 'removed' : 'no'} stale nameConfig ${displayPath(target)}`,
			);
		} catch (err) {
			deps.output.appendLine(
				`[watcher] cleanup failed for ${displayPath(uri)}: ${describe(err)}`,
			);
		}
	};

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		for (const glob of DEVCONTAINER_GLOBS) {
			const pattern = new vscode.RelativePattern(folder, glob);
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			watcher.onDidCreate(uri => triggerSync(uri, 'watcher.create'), undefined, disposables);
			watcher.onDidChange(uri => triggerSync(uri, 'watcher.change'), undefined, disposables);
			watcher.onDidDelete(triggerDelete, undefined, disposables);
			disposables.push(watcher);
		}
	}

	// Bootstrap scan: kick a sync for every devcontainer.json that already
	// exists in the workspace.
	void bootstrapScan(deps).catch(err => {
		deps.output.appendLine(`[watcher] bootstrap scan failed: ${describe(err)}`);
	});

	return new vscode.Disposable(() => {
		for (const handle of pending.values()) {
			clearTimeout(handle);
		}
		pending.clear();
		for (const d of disposables) {
			d.dispose();
		}
	});
}

export async function bootstrapScan(deps: WatcherDeps): Promise<vscode.Uri[]> {
	const found: vscode.Uri[] = [];
	for (const glob of DEVCONTAINER_GLOBS) {
		const matches = await vscode.workspace.findFiles(glob, '**/node_modules/**');
		for (const uri of matches) {
			found.push(uri);
			try {
				await deps.engine.sync(uri, { source: 'bootstrap' });
			} catch (err) {
				deps.output.appendLine(
					`[bootstrap] sync failed for ${displayPath(uri)}: ${describe(err)}`,
				);
			}
		}
	}
	return found;
}

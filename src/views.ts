import * as path from 'path';
import * as vscode from 'vscode';
import { CribCli, CribState, CribStatus } from './crib';
import { DEVCONTAINER_GLOBS, workspaceRootFor } from './devcontainer';
import { collectAllDiscoverableTargets } from './targetDiscovery';
import { resolveContainerName } from './containerName';
import { displayPath, nameConfigUri, DevContainerStorage } from './paths';
import { RebuildQueue } from './rebuildQueue';
import { SyncEngine, SyncResult } from './sync';

export interface WorkspaceItemData {
	readonly devcontainerUri: vscode.Uri;
	readonly workspaceFolderUri: vscode.Uri;
	readonly devcontainerOnDisk: boolean;
	containerName: string;
	state: CribState;
	lastSync?: SyncResult;
}

/**
 * The TreeView's nodes are kept simple on purpose: one row per discovered
 * `devcontainer.json`. Status (up / down / unknown) and last sync info come
 * from the engine and the crib CLI; rebuilds are async and serialized via {@link RebuildQueue}.
 */
export class CribTreeDataProvider implements vscode.TreeDataProvider<WorkspaceItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private cache: WorkspaceItemData[] = [];
	private readonly rebuildQueue = new RebuildQueue();
	/** Prevents getChildren → rebuild → onDidChangeTreeData → getChildren loops when discovery returns 0 rows. */
	private discoverySeeded = false;
	private readonly subscriptions: vscode.Disposable[] = [];
	private disposed = false;
	private _pollTimer: NodeJS.Timeout | undefined;
	private readonly _pollIntervalMs: number;

	constructor(
		private readonly storage: DevContainerStorage,
		private readonly crib: CribCli | undefined,
		engine: SyncEngine,
		private readonly appendLog: (message: string) => void = () => {},
		pollIntervalMs = 30_000,
	) {
		this._pollIntervalMs = pollIntervalMs;
		this.subscriptions.push(
			engine.onDidSync(result => {
				if (this.disposed) {
					return;
				}
				const hit = this.cache.find(c => c.devcontainerUri.toString() === result.devcontainerUri.toString());
				if (hit) {
					hit.lastSync = result;
					hit.containerName = result.containerName;
					this._onDidChangeTreeData.fire(undefined);
				}
			}),
		);
	}

	dispose(): void {
		this.disposed = true;
		if (this._pollTimer) {
			clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
		for (const d of this.subscriptions) {
			d.dispose();
		}
		this.subscriptions.length = 0;
		this._onDidChangeTreeData.dispose();
		void vscode.commands.executeCommand('setContext', 'crib.hasDevcontainerTargets', false);
	}

	refresh(): void {
		this.discoverySeeded = false;
		void this.rebuildQueue.run(() => this.rebuildCore());
	}

	startPolling(): void {
		if (this._pollTimer !== undefined) {
			return;
		}
		if (this.disposed) {
			return;
		}
		if (!this.crib) {
			return;
		}
		this._pollTimer = setInterval(async () => {
			if (this.disposed) {
				return;
			}
			await this.refreshStates();
		}, this._pollIntervalMs);
		this.subscriptions.push({
			dispose: () => {
				if (this._pollTimer) {
					clearInterval(this._pollTimer);
					this._pollTimer = undefined;
				}
			},
		});
	}

	getTreeItem(element: WorkspaceItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: WorkspaceItem): Promise<WorkspaceItem[]> {
		if (element) {
			return [];
		}
		if (!this.discoverySeeded) {
			this.discoverySeeded = true;
			try {
				await this.rebuildQueue.run(() => this.rebuildCore());
			} catch (err) {
				this.discoverySeeded = false;
				const msg = err instanceof Error ? err.message : String(err);
				this.appendLog(`[discover] getChildren: unexpected rebuild error: ${msg}`);
				return [];
			}
		}
		return this.cache.map(data => new WorkspaceItem(data, this.storage));
	}

	private async rebuildCore(): Promise<void> {
		// Snapshot: on discovery failure, keep last good rows if we had any (avoid wiping on transient I/O errors).
		const cacheBefore = this.cache;
		try {
			const seen = new Map<string, WorkspaceItemData>();
			if (!this.crib) {
				for (const glob of DEVCONTAINER_GLOBS) {
					const matches = await vscode.workspace.findFiles(glob, '**/node_modules/**');
					for (const uri of matches) {
						if (seen.has(uri.toString())) {
							continue;
						}
						const folderUri = workspaceRootFor(uri);
						const containerName = await resolveContainerName(folderUri, undefined);
						const state = await this.probeState(folderUri);
						seen.set(uri.toString(), {
							devcontainerUri: uri,
							workspaceFolderUri: folderUri,
							devcontainerOnDisk: true,
							containerName,
							state,
						});
					}
				}
			} else {
				const discovered = await collectAllDiscoverableTargets(this.crib, this.appendLog);
				for (const t of discovered) {
					if (seen.has(t.devcontainerUri.toString())) {
						continue;
					}
					const state = await this.probeState(t.workspaceFolderUri);
					seen.set(t.devcontainerUri.toString(), {
						devcontainerUri: t.devcontainerUri,
						workspaceFolderUri: t.workspaceFolderUri,
						devcontainerOnDisk: t.devcontainerOnDisk,
						containerName: t.containerName,
						state,
					});
				}
			}
			this.cache = [...seen.values()].sort((a, b) =>
				a.containerName.localeCompare(b.containerName),
			);
			this.appendLog(`[discover] tree rebuilt with ${this.cache.length} visible workspace(s)`);
			const hasDc = this.cache.some(c => c.devcontainerOnDisk);
			void vscode.commands.executeCommand('setContext', 'crib.hasDevcontainerTargets', hasDc);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.appendLog(`[discover] tree rebuild failed: ${msg}`);
			if (cacheBefore.length > 0) {
				this.cache = cacheBefore;
			}
			const hasDc = this.cache.some(c => c.devcontainerOnDisk);
			void vscode.commands.executeCommand('setContext', 'crib.hasDevcontainerTargets', hasDc);
		} finally {
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	private async probeState(folderUri: vscode.Uri): Promise<CribState> {
		if (!this.crib) {
			return 'unknown';
		}
		try {
			const status: CribStatus = await this.crib.status(folderUri);
			return status.state;
		} catch {
			return 'unknown';
		}
	}

	/**
	 * Incrementally refresh state for all cached workspaces. Fires
	 * _onDidChangeTreeData only if at least one state changed, to avoid
	 * unnecessary UI churn during poll cycles.
	 */
	private async refreshStates(): Promise<void> {
		if (this.cache.length === 0) {
			return;
		}
		let anyChanged = false;
		for (const item of this.cache) {
			const next = await this.probeState(item.workspaceFolderUri);
			if (item.state !== next) {
				item.state = next;
				anyChanged = true;
			}
		}
		if (anyChanged) {
			this.appendLog(`[poll] state changed; refreshing tree`);
			this._onDidChangeTreeData.fire(undefined);
		}
	}
}

export class WorkspaceItem extends vscode.TreeItem {
	constructor(public readonly data: WorkspaceItemData, storage: DevContainerStorage) {
		super(data.containerName, vscode.TreeItemCollapsibleState.None);
		const folderName = path.posix.basename(data.workspaceFolderUri.path);
		this.description =
			data.state === 'up' ? 'running' : data.state === 'down' ? 'stopped' : folderName;
		this.tooltip = buildTooltip(data, storage);
		this.iconPath =
			data.state === 'up'
				? new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('charts.green'))
				: data.state === 'down'
				? new vscode.ThemeIcon('vm-outline')
				: new vscode.ThemeIcon('question');
		const up = data.state === 'up';
		this.contextValue = data.devcontainerOnDisk
			? up
				? 'workspace.up'
				: 'workspace.down'
			: up
				? 'workspace.runtime.up'
				: 'workspace.runtime.down';
		this.resourceUri = data.devcontainerUri;
	}
}

function buildTooltip(data: WorkspaceItemData, storage: DevContainerStorage): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.appendMarkdown(`**${data.containerName}**\n\n`);
	if (!data.devcontainerOnDisk) {
		md.appendMarkdown(
			`*No \`devcontainer.json\` on disk yet — crib lifecycle works; sync and attach need a real config.*\n\n`,
		);
	}
	md.appendMarkdown(`- devcontainer: \`${displayPath(data.devcontainerUri)}\`\n`);
	md.appendMarkdown(`- workspace: \`${displayPath(data.workspaceFolderUri)}\`\n`);
	md.appendMarkdown(`- state: \`${data.state}\`\n`);
	if (data.lastSync) {
		md.appendMarkdown(
			`- nameConfig: \`${displayPath(data.lastSync.nameConfigUri)}\`\n` +
				`- extensions synced: \`${data.lastSync.extensionsCount}\`\n`,
		);
	} else {
		md.appendMarkdown(`- nameConfig: \`${displayPath(nameConfigUri(storage, data.containerName))}\`\n`);
	}
	return md;
}

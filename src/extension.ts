import { describe } from './util';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	hasContainerName,
	resolveAttachTarget,
	UI_ATTACH_BRIDGE_COMMAND,
} from './attach';
import { installAttachExtensionsFallback } from './attachExtensionFallback';
import { devContainersAttachArgument } from './attachPayload';
import { CribCli, CribNotFoundError } from './crib';
import { collectAllDiscoverableTargets, DiscoveredTarget } from './targetDiscovery';
import { FeatureResolver } from './features';
import { deleteNameConfig } from './nameConfig';
import {
	displayPath,
	getDevContainerStorage,
	KNOWN_DEV_CONTAINER_EXTENSION_IDS,
	nameConfigUri,
} from './paths';
import { SyncEngine, SyncSettings } from './sync';
import { initRuntimeDebugLog } from './runtimeDebugLog';
import { CribTreeDataProvider, WorkspaceItem } from './views';
import { installWatchers } from './watcher';

const CONFIG_SECTION = 'crib';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Crib');
	context.subscriptions.push(output);
	context.subscriptions.push(
		vscode.commands.registerCommand('crib.focusOutput', () => {
			output.show(true);
		}),
	);
	const runsOnWorkspaceHost = context.extension.extensionKind === vscode.ExtensionKind.Workspace;
	void vscode.commands.executeCommand('setContext', 'crib.runsOnWorkspaceHost', runsOnWorkspaceHost);
	context.subscriptions.push({
		dispose: () => {
			void vscode.commands.executeCommand('setContext', 'crib.runsOnWorkspaceHost', false);
		},
	});
	// Workspace trust: gate lifecycle commands to trusted workspaces only.
	void vscode.commands.executeCommand('setContext', 'crib.trusted', vscode.workspace.isTrusted);
	const trustDisposable = vscode.workspace.onDidGrantWorkspaceTrust(() => {
		void vscode.commands.executeCommand('setContext', 'crib.trusted', true);
	});
	context.subscriptions.push(trustDisposable);
	output.appendLine(
		'[crib] If this channel is missing from the Output dropdown, run command **Crib: Show Crib Output Log** from the Command Palette (it activates the extension).',
	);
	const extPkg = context.extension.packageJSON as { name?: string; version?: string };
	output.appendLine(
		`[crib] ${extPkg.name ?? 'crib-vscode'} v${extPkg.version ?? '?'} from ${context.extension.extensionPath}`,
	);
	try {
		activateBody(context, output, runsOnWorkspaceHost);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		output.appendLine(`[crib] activate failed: ${msg}`);
		if (err instanceof Error && err.stack) {
			output.appendLine(err.stack);
		}
		void vscode.window.showErrorMessage(`Crib failed to start: ${msg}`);
	}
}

function activateBody(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	runsOnWorkspaceHost: boolean,
): void {
	initRuntimeDebugLog(context, line => output.appendLine(line));

	const storage = getDevContainerStorage(context);
	output.appendLine(
		`crib-vscode activating; Dev Containers storage = ${storage.extensionId}, ` +
			`globalStorage = ${displayPath(storage.globalStorage)}`,
	);
	const hostKind =
		context.extension.extensionKind === vscode.ExtensionKind.UI
			? 'UI'
			: context.extension.extensionKind === vscode.ExtensionKind.Workspace
				? 'Workspace'
				: String(context.extension.extensionKind);
	output.appendLine(
		`crib-vscode host: extensionKind=${hostKind} (${context.extension.extensionKind}), ` +
			`remoteName=${vscode.env.remoteName ?? 'local'}`,
	);
	if (context.extension.extensionKind === vscode.ExtensionKind.UI) {
		output.appendLine(
			'[warn] Crib is running on the **UI** extension host, so it cannot see Remote-SSH workspace files or run `crib` in your remote project. ' +
				'Install this extension **on the remote** (e.g. `cursor --install-extension path/to/crib-vscode-main.vsix --force --remote ssh-remote+<your-target>`), then reload the SSH window.',
		);
	} else {
		output.appendLine(
			'crib-vscode workspace extension host active; sync/up/down/rebuild commands are registered here.',
		);
	}
	if (!storage.extensionFound) {
		output.appendLine(
			`[warn] no known Dev Containers extension object is visible in this host; ` +
				`sync will write ${storage.extensionId} storage as best effort` +
				`${storage.fallbackReason ? ` (${storage.fallbackReason})` : ''}.`,
		);
	}

	if (!runsOnWorkspaceHost) {
		void vscode.commands.executeCommand('setContext', 'crib.hasDevcontainerTargets', false);
		output.appendLine(
			'[crib] Workspaces tree, `crib` CLI, and Crib commands are not activated on this host (UI extension host). Use **Crib: Show Crib Output Log** here; run Crib from the SSH workspace window.',
		);
		registerUiHostCommandStubs(context);
		output.appendLine('crib-vscode ready');
		return;
	}

	const crib = new CribCli(output, () => settings().path);
	output.appendLine(`[crib] crib.path → ${JSON.stringify(crib.binary)} (Remote-SSH: must be on PATH in this host or set in settings)`);
	void crib.version().then(
		version => {
			output.appendLine(`[crib] ${version ? `version ${version}` : 'version unavailable (is `crib` installed here? try the same path in an integrated terminal)'}`);
		},
		err => {
			output.appendLine(`[crib] version probe failed: ${describe(err)}`);
		},
	);

	const featureCacheRoot = vscode.Uri.joinPath(context.globalStorageUri, 'feature-cache');
	const features = new FeatureResolver(
		featureCacheRoot,
		msg => output.appendLine(`[features] ${msg}`),
		() => settings().featureManifestFetch,
	);

	const engine = new SyncEngine(
		storage,
		features,
		crib,
		output,
		() => settings(),
	);
	context.subscriptions.push({ dispose: () => engine.dispose() });

	const tree = new CribTreeDataProvider(storage, crib, engine, msg => output.appendLine(msg));
	context.subscriptions.push({ dispose: () => tree.dispose() });
	const treeView = vscode.window.createTreeView('cribWorkspaces', {
		treeDataProvider: tree,
		showCollapseAll: false,
	});
	context.subscriptions.push(treeView);
	void vscode.commands.executeCommand('setContext', 'crib.hasDevcontainerTargets', false);
	tree.startPolling();

	registerCommands(context, { engine, crib, tree, output, storage });

	// Avoid blocking Remote-SSH activation: getCommands(true) activates many extensions over IPC;
	// bootstrap findFiles competes with the same host. Defer both until after activate() returns.
	void Promise.resolve().then(() => {
		try {
			context.subscriptions.push(installWatchers({ engine, storage, crib, output }));
		} catch (err) {
			output.appendLine(`[watcher] deferred install failed: ${describe(err)}`);
		}
	});

	void (async () => {
		try {
			await logAttachCapability(output);
		} catch (err) {
			output.appendLine(`[info] attach capability probe failed: ${describe(err)}`);
		}
	})();

	output.appendLine('crib-vscode ready');
}


async function activateDevContainerExtensions(): Promise<void> {
	for (const id of KNOWN_DEV_CONTAINER_EXTENSION_IDS) {
		try {
			await vscode.extensions.getExtension(id)?.activate();
		} catch {
			// non-fatal; attach probe still runs with whatever commands are registered
		}
	}
}

/** Stub handlers so `onCommand:*` activation and palette invocations get a clear message (manifest enablement usually hides these on UI). */
function registerUiHostCommandStubs(context: vscode.ExtensionContext): void {
	const message =
		'Crib runs on the **workspace** extension host (SSH / WSL / dev container window). Open that window, or use **Crib: Show Crib Output Log** here.';
	const stub = (): void => {
		void vscode.window.showInformationMessage(message);
	};
	for (const cmd of [
		'crib.up',
		'crib.down',
		'crib.restart',
		'crib.rebuild',
		'crib.remove',
		'crib.attach',
		'crib.syncNow',
		'crib.openConfig',
		'crib.refresh',
	] as const) {
		context.subscriptions.push(vscode.commands.registerCommand(cmd, stub));
	}
}

async function logAttachCapability(output: vscode.OutputChannel): Promise<void> {
	const commands = await vscode.commands.getCommands(false);
	const target = resolveAttachTarget(commands);
	if (target.kind === 'direct') {
		output.appendLine(`[info] attach capability available via ${target.command}`);
		return;
	}
	if (target.kind === 'uiBridge') {
		output.appendLine(`[info] attach capability available via UI bridge ${target.command}`);
		return;
	}
	const found = KNOWN_DEV_CONTAINER_EXTENSION_IDS.find(id => vscode.extensions.getExtension(id));
	output.appendLine(
		found
			? `[warn] Dev Containers extension ${found} is visible, but its attach command is not registered in this workspace host.`
			: '[warn] no Dev Containers attach command is registered in this workspace host; Crib attach will try the UI bridge on demand.',
	);
	output.appendLine(
		'[hint] Attach details stay in this log only (no startup toast). Reload if Dev Containers just updated; install Crib Attach Bridge on the UI host if attach is unavailable.',
	);
}

export function deactivate(): void {
	// All disposables are owned by the context; nothing extra to do.
}

interface CommandDeps {
	engine: SyncEngine;
	crib: CribCli;
	tree: CribTreeDataProvider;
	output: vscode.OutputChannel;
	storage: ReturnType<typeof getDevContainerStorage>;
}

function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const reg = (cmd: string, handler: (...args: unknown[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));

	registerLifecycleCommands(reg, deps);
	registerAttachCommand(reg, deps);
	registerSyncCommands(reg, deps);
}

/** Guard: show trust message and return true if workspace is untrusted. */
function checkWorkspaceTrust(output: vscode.OutputChannel): boolean {
	if (vscode.workspace.isTrusted) {
		return false;
	}
	vscode.window.showWarningMessage(
		'Crib: Workspace is not trusted. Run `Trust Workspace` from the Command Palette to enable lifecycle commands.',
		'Open Trust Settings',
	).then(choice => {
		if (choice === 'Open Trust Settings') {
			void vscode.commands.executeCommand('workbench.action.openWorkspaceTrustSettings');
		}
	}, () => {});
	output.appendLine('[crib] workspace not trusted; lifecycle command blocked');
	return true;
}

function registerLifecycleCommands(
	reg: (cmd: string, handler: (...args: unknown[]) => unknown) => void,
	deps: CommandDeps,
): void {
	reg('crib.up', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (checkWorkspaceTrust(deps.output)) {
			return;
		}
		await runCribLifecycle('up', target, deps, () => deps.crib.up(target.workspaceFolderUri));
		if (target.devcontainerOnDisk) {
			await deps.engine.sync(target.devcontainerUri, {
				source: 'crib.up',
				containerName: target.containerName,
				refreshFeatures: true,
			});
		} else {
			deps.output.appendLine('[crib.up] skip nameConfig sync — no devcontainer.json on disk for this row');
		}
		deps.tree.refresh();
	}));

	reg('crib.down', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (checkWorkspaceTrust(deps.output)) {
			return;
		}
		await runCribLifecycle('down', target, deps, () => deps.crib.down(target.workspaceFolderUri));
		deps.tree.refresh();
	}));

	reg('crib.restart', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (checkWorkspaceTrust(deps.output)) {
			return;
		}
		await runCribLifecycle('restart', target, deps, () => deps.crib.restart(target.workspaceFolderUri));
		if (target.devcontainerOnDisk) {
			await deps.engine.sync(target.devcontainerUri, {
				source: 'crib.restart',
				containerName: target.containerName,
				refreshFeatures: true,
			});
		} else {
			deps.output.appendLine('[crib.restart] skip nameConfig sync — no devcontainer.json on disk for this row');
		}
		deps.tree.refresh();
	}));

	reg('crib.rebuild', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (checkWorkspaceTrust(deps.output)) {
			return;
		}
		await runCribLifecycle('rebuild', target, deps, () => deps.crib.rebuild(target.workspaceFolderUri));
		if (target.devcontainerOnDisk) {
			await deps.engine.sync(target.devcontainerUri, {
				source: 'crib.rebuild',
				containerName: target.containerName,
				refreshFeatures: true,
			});
		} else {
			deps.output.appendLine('[crib.rebuild] skip nameConfig sync — no devcontainer.json on disk for this row');
		}
		deps.tree.refresh();
	}));

	reg('crib.remove', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (checkWorkspaceTrust(deps.output)) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Remove crib container "${target.containerName}"? The matching nameConfig will also be deleted.`,
			{ modal: true },
			'Remove',
		);
		if (confirm !== 'Remove') {
			return;
		}
		await runCribLifecycle('remove', target, deps, () => deps.crib.remove(target.workspaceFolderUri));
		await deleteNameConfig(nameConfigUri(deps.storage, target.containerName));
		deps.tree.refresh();
	}));
}

function registerAttachCommand(
	reg: (cmd: string, handler: (...args: unknown[]) => unknown) => void,
	deps: CommandDeps,
): void {
	reg('crib.attach', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (!target.devcontainerOnDisk) {
			const choice = await vscode.window.showInformationMessage(
				'Crib: attach and nameConfig sync need a devcontainer.json on disk. Open the project folder or add a config, then retry.',
				'Open Folder',
			);
			if (choice === 'Open Folder') {
				await vscode.commands.executeCommand('vscode.openFolder', target.workspaceFolderUri, false);
			}
			return;
		}
		await ensureUp(target, deps);
		const result = await deps.engine.sync(target.devcontainerUri, {
			source: 'crib.attach',
			containerName: target.containerName,
		});
		if (!hasContainerName(result.containerName)) {
			vscode.window.showErrorMessage('Crib: cannot attach because no container name was resolved.');
			return;
		}
		await activateDevContainerExtensions();
		const commands = await vscode.commands.getCommands(false);
		const attachTarget = resolveAttachTarget(commands, { allowUiBridgeFallback: true });
		deps.output.appendLine(
			`[attach] target=${attachTarget.kind}, requestedName=${result.containerName}`,
		);
		const dockerId = await deps.crib.resolveContainerDockerId(
			target.workspaceFolderUri,
			result.containerName,
		);
		if (dockerId) {
			deps.output.appendLine(`[attach] resolved Docker container id ${dockerId}`);
		} else {
			deps.output.appendLine('[attach] could not resolve Docker container id (name-only attach)');
		}
		if (attachTarget.kind === 'direct' && dockerId) {
			const payload = devContainersAttachArgument(attachTarget.command, result.containerName, dockerId);
			const uiBridgeConfig = await readNameConfigForUiBridge(result.nameConfigUri, deps);
			deps.output.appendLine(
				`[attach] invoking direct command ${attachTarget.command} with docker id payload`,
			);
			try {
				await vscode.commands.executeCommand(
					attachTarget.command,
					payload,
				);
				await runRemoteAttachExtensionFallback('direct', true, uiBridgeConfig.nameConfig, deps);
			} catch (err) {
				const reason = describe(err);
				deps.output.appendLine(`[attach] direct command failed: ${reason}`);
				vscode.window.showErrorMessage(
					'Crib: attach command was invoked, but Dev Containers failed while opening the container. ' +
						`Check "Dev Containers" output for details (${reason}).`,
				);
			}
			return;
		}
		if (attachTarget.kind === 'direct' && !dockerId) {
			deps.output.appendLine(
				'[attach] direct attach command exists, but docker id is missing; routing through UI bridge/picker path.',
			);
		}
		if (attachTarget.kind === 'uiBridge') {
			const uiBridgeConfig = await readNameConfigForUiBridge(result.nameConfigUri, deps);
			if (uiBridgeConfig.nameConfig) {
				deps.output.appendLine(
					`[attach] loaded nameConfig for UI bridge: ${uiBridgeConfig.extensionsCount ?? 0} extension(s)`,
				);
			}
			const attachSucceeded = await executeUiAttachBridge(
				{
					containerName: result.containerName,
					containerId: dockerId,
					nameConfig: uiBridgeConfig.nameConfig,
				},
				deps,
			);
			await runRemoteAttachExtensionFallback('uiBridge', attachSucceeded, uiBridgeConfig.nameConfig, deps);
			return;
		}
		if (attachTarget.kind === 'direct' && !dockerId) {
			vscode.window.showErrorMessage(
				'Crib: could not resolve Docker container id and no UI bridge route is available. ' +
					'Install/enable Crib Attach Bridge locally or retry after container is fully running.',
			);
			return;
		}
		const reason = attachTarget.kind === 'unavailable'
			? attachTarget.reason
			: 'No compatible attach route was selected.';
		vscode.window.showErrorMessage(
			`Crib: synced ${result.containerName}, but no attach target is available. ${reason}`,
		);
	}));
}

async function executeUiAttachBridge(
	payload: { readonly containerName: string; readonly containerId?: string; readonly nameConfig?: unknown },
	deps: CommandDeps,
): Promise<boolean> {
	try {
		if (!payload.containerId) {
			deps.output.appendLine(
				'[attach] no Docker container id resolved; UI bridge may fall back to picker attach.',
			);
		}
		deps.output.appendLine(
			`[attach] routing via UI bridge (${payload.containerName}` +
				(payload.containerId ? `, id=${payload.containerId}` : '') +
				')',
		);
		await vscode.commands.executeCommand(UI_ATTACH_BRIDGE_COMMAND, payload);
		return true;
	} catch (err) {
		const reason = describe(err);
		deps.output.appendLine(`[attach] UI bridge failed: ${reason}`);
		vscode.window.showErrorMessage(
			'Crib: nameConfig was synced, but the UI attach bridge is unavailable. ' +
				'Install the Crib Attach Bridge extension locally, reload the Remote-SSH window, and retry attach.',
		);
		return false;
	}
}

async function runRemoteAttachExtensionFallback(
	route: 'direct' | 'uiBridge',
	attachSucceeded: boolean,
	nameConfig: unknown,
	deps: CommandDeps,
): Promise<void> {
	await installAttachExtensionsFallback({
		remoteName: vscode.env.remoteName,
		route,
		attachSucceeded,
		nameConfig,
		installedExtensionIds: vscode.extensions.all.map(ext => ext.id),
		installExtension: async id => {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
		},
		log: line => deps.output.appendLine(line),
		notifyFailure: line => {
			void vscode.window.showWarningMessage(line);
		},
	});
}

async function readNameConfigForUiBridge(
	target: vscode.Uri,
	deps: CommandDeps,
): Promise<{ readonly nameConfig?: unknown; readonly extensionsCount?: number }> {
	try {
		const bytes = await vscode.workspace.fs.readFile(target);
		const raw = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const extensions = Array.isArray(parsed.extensions) ? parsed.extensions : [];
		return {
			nameConfig: parsed,
			extensionsCount: extensions.length,
		};
	} catch (err) {
		const reason = describe(err);
		deps.output.appendLine(`[attach] could not load nameConfig for UI bridge: ${reason}`);
		return {};
	}
}

function registerSyncCommands(
	reg: (cmd: string, handler: (...args: unknown[]) => unknown) => void,
	deps: CommandDeps,
): void {
	reg('crib.syncNow', (item?: unknown) => withOptionalWorkspace(item, deps, async targets => {
		const syncable = targets.filter(t => t.devcontainerOnDisk);
		const skipped = targets.length - syncable.length;
		let count = 0;
		for (const target of syncable) {
			try {
				await deps.engine.sync(target.devcontainerUri, {
					source: 'crib.syncNow',
					containerName: target.containerName,
					refreshFeatures: true,
				});
				count++;
			} catch (err) {
				deps.output.appendLine(
					`[syncNow] ${displayPath(target.devcontainerUri)} failed: ${describe(err)}`,
				);
			}
		}
		let msg: string;
		if (count === 0 && syncable.length === 0) {
			msg =
				'Crib: nothing to sync — no devcontainer.json on disk in the selected targets (runtime-only rows need a real devcontainer file).';
		} else if (count === 0) {
			msg = 'Crib: sync failed for all devcontainer.json targets; see Crib output for details.';
		} else {
			msg =
				skipped > 0
					? `Crib: synced ${count} devcontainer.json file(s); skipped ${skipped} runtime-only row(s) without a config on disk.`
					: `Crib: synced ${count} devcontainer.json file(s).`;
		}
		vscode.window.showInformationMessage(msg);
		deps.tree.refresh();
	}));

	reg('crib.openConfig', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (!target.devcontainerOnDisk) {
			const choice = await vscode.window.showInformationMessage(
				'Crib: nameConfig sync requires devcontainer.json on disk first.',
				'Open Folder',
			);
			if (choice === 'Open Folder') {
				await vscode.commands.executeCommand('vscode.openFolder', target.workspaceFolderUri, false);
			}
			return;
		}
		const target2 = nameConfigUri(deps.storage, target.containerName);
		try {
			const doc = await vscode.workspace.openTextDocument(target2);
			await vscode.window.showTextDocument(doc);
		} catch {
			vscode.window.showInformationMessage(
				`No nameConfig has been written yet for ${target.containerName}.`,
			);
		}
	}));

	reg('crib.openDevcontainerJson', (item?: unknown) => withWorkspace(item, deps, async target => {
		if (!target.devcontainerOnDisk) {
			vscode.window.showInformationMessage(
				`No devcontainer.json on disk for workspace "${target.containerName}".`,
				'Open Folder',
			).then(choice => {
				if (choice === 'Open Folder') {
					void vscode.commands.executeCommand('vscode.openFolder', target.workspaceFolderUri, false);
				}
			}, () => {});
			return;
		}
		const doc = await vscode.workspace.openTextDocument(target.devcontainerUri);
		await vscode.window.showTextDocument(doc);
	}));

	reg('crib.refresh', () => {
		deps.tree.refresh();
	});
}



async function withWorkspace(
	item: unknown,
	deps: CommandDeps,
	fn: (target: DiscoveredTarget) => Promise<void>,
): Promise<void> {
	try {
		const target = await pickWorkspace(item, deps, false);
		if (!target) {
			return;
		}
		await fn(target);
	} catch (err) {
		reportError(err, deps);
	}
}

async function withOptionalWorkspace(
	item: unknown,
	deps: CommandDeps,
	fn: (targets: DiscoveredTarget[]) => Promise<void>,
): Promise<void> {
	try {
		const target = await pickWorkspace(item, deps, true);
		if (target) {
			await fn([target]);
			return;
		}
		const all = await collectAllDiscoverableTargets(deps.crib, msg => deps.output.appendLine(msg));
		await fn(all);
	} catch (err) {
		reportError(err, deps);
	}
}

async function pickWorkspace(
	item: unknown,
	deps: CommandDeps,
	allowSyncAll: boolean,
): Promise<DiscoveredTarget | undefined> {
	if (item instanceof WorkspaceItem) {
		return {
			devcontainerUri: item.data.devcontainerUri,
			workspaceFolderUri: item.data.workspaceFolderUri,
			containerName: item.data.containerName,
			devcontainerOnDisk: item.data.devcontainerOnDisk,
		};
	}
	const all = await collectAllDiscoverableTargets(deps.crib, msg => deps.output.appendLine(msg));
	if (all.length === 0) {
		if (!allowSyncAll) {
			vscode.window.showInformationMessage(
				'Crib: no workspaces in the tree (open a folder with a devcontainer, or ensure `crib` reports running workspaces on this host).',
			);
		}
		return undefined;
	}
	if (all.length === 1) {
		return all[0];
	}
	const picked = await vscode.window.showQuickPick(
		all.map(t => ({
			label: t.containerName,
			description: path.posix.basename(t.workspaceFolderUri.path),
			detail: displayPath(t.devcontainerUri),
			target: t,
		})),
		{ placeHolder: 'Select a crib workspace' },
	);
	return picked?.target;
}

async function ensureUp(target: DiscoveredTarget, deps: CommandDeps): Promise<void> {
	if (!settings().autoUpOnAttach) {
		return;
	}
	let status;
	try {
		status = await deps.crib.status(target.workspaceFolderUri);
	} catch (err) {
		throw err;
	}
	if (status.state === 'up') {
		return;
	}
	await runCribLifecycle('up', target, deps, () => deps.crib.up(target.workspaceFolderUri));
}

async function runCribLifecycle(
	verb: string,
	target: DiscoveredTarget,
	deps: CommandDeps,
	action: () => Promise<void>,
): Promise<void> {
	deps.output.show(true);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `crib ${verb} (${target.containerName})`,
			cancellable: false,
		},
		async () => {
			await action();
		},
	);
}

function reportError(err: unknown, deps: CommandDeps): void {
	const msg = describe(err);
	deps.output.appendLine(`[error] ${msg}`);
	if (err instanceof CribNotFoundError) {
		vscode.window.showErrorMessage(msg, 'Open Settings').then(
			choice => {
				if (choice === 'Open Settings') {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'crib.path');
				}
			},
			showErr => {
				deps.output.appendLine(`[error] showErrorMessage failed: ${describe(showErr)}`);
			},
		);
		return;
	}
	void vscode.window.showErrorMessage(`Crib: ${msg}`);
}

function settings(): SyncSettings & {
	path: string;
	autoUpOnAttach: boolean;
	featureManifestFetch: boolean;
} {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		path: cfg.get<string>('path') ?? 'crib',
		autoUpOnAttach: cfg.get<boolean>('autoUpOnAttach') ?? true,
		extraExtensions: cfg.get<string[]>('extraExtensions') ?? [],
		includeFeatureExtensions: cfg.get<boolean>('includeFeatureExtensions') ?? true,
		featureManifestFetch: cfg.get<boolean>('featureManifestFetch') ?? true,
	};
}

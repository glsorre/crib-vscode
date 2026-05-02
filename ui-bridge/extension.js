const vscode = require('vscode');
const path = require('path');

const BRIDGE_COMMAND = 'crib.attachViaUiHost';
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9._-]+$/;

function isSafeContainerName(value) {
	return typeof value === 'string' && SAFE_CONTAINER_NAME.test(value);
}
const DEV_CONTAINERS_EXTENSION_IDS = [
	'ms-vscode-remote.remote-containers',
	'anysphere.remote-containers',
];
const DIRECT_ATTACH_COMMANDS = [
	'remote-containers.attachToRunningContainer',
	'anysphere.remote-containers.attachToRunningContainer',
];
const PICKER_ATTACH_COMMANDS = [
	'remote-containers.attachToRunningContainerFromViewlet',
	'anysphere.remote-containers.attachToRunningContainerFromViewlet',
];

function activate(context) {
	const output = vscode.window.createOutputChannel('Crib (UI bridge)');
	context.subscriptions.push(output);
	output.appendLine(
		'This channel is the **Crib Attach Bridge** (UI-only). It wires Dev Containers attach from your desktop.',
	);
	if (vscode.env.remoteName) {
		output.appendLine('');
		output.appendLine(
			`[setup] remoteName=${vscode.env.remoteName} — the **main Crib** extension (rightright-me.crib-vscode-main) must be installed **on this SSH host** or you get missing commands (crib.refresh) and WORKSPACES shows no data provider.`,
		);
		output.appendLine(
			'[setup] Extensions → search **crib** → **Install in SSH: …** (or `cursor --install-extension <vsix> --force --remote ssh-remote+…`), then reload the window.',
		);
	} else {
		output.appendLine('');
		output.appendLine(
			'[setup] For Remote-SSH, install the main **crib** workspace extension on the remote too — this bridge does not register crib.refresh or the WORKSPACES tree.',
		);
	}
	output.appendLine('');
	output.appendLine('--- attach bridge logs ---');
	context.subscriptions.push(
		vscode.commands.registerCommand(BRIDGE_COMMAND, async arg => {
			const payload = normalizeBridgePayload(arg);
			if (!payload.containerName && !payload.containerId) {
				vscode.window.showErrorMessage(
					'Crib: cannot attach because no container name or id was provided to the UI bridge.',
				);
				return;
			}
			if (payload.nameConfig && payload.containerName) {
				if (!isSafeContainerName(payload.containerName)) {
					output.appendLine(
						`[attach] refusing nameConfig sync: containerName "${payload.containerName}" contains characters outside [A-Za-z0-9._-]`,
					);
					vscode.window.showErrorMessage(
						`Crib: refusing to write Dev Containers nameConfig for unsafe container name "${payload.containerName}".`,
					);
					return;
				}
				try {
					await writeUiNameConfig(payload.containerName, payload.nameConfig, context, output);
					output.appendLine(`[attach] synced local UI nameConfig for ${payload.containerName}`);
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					output.appendLine(`[attach] failed to sync local UI nameConfig: ${reason}`);
					vscode.window.showErrorMessage(
						`Crib: failed to sync local Dev Containers nameConfig before attach (${reason}).`,
					);
					return;
				}
			}
			await activateDevContainers();
			const commands = await vscode.commands.getCommands(false);
			const direct = DIRECT_ATTACH_COMMANDS.find(command => commands.includes(command));
			if (direct && payload.containerId) {
				output.appendLine(`[attach] ${direct} payload={ containerId: ${payload.containerId} }`);
				await vscode.commands.executeCommand(direct, {
					containerId: payload.containerId,
				});
				return;
			}
			const picker = PICKER_ATTACH_COMMANDS.find(command => commands.includes(command));
			if (picker) {
				const reason = direct && !payload.containerId
					? 'direct command available but missing containerId'
					: 'direct command unavailable';
				output.appendLine(
					`[attach] ${picker} (picker fallback; reason=${reason}; ` +
						`resolved name=${payload.containerName ?? '(none)'})`,
				);
				await vscode.commands.executeCommand(picker);
				return;
			}
			vscode.window.showErrorMessage(
				'Crib: Dev Containers attach is not registered in the UI host. Open Dev Containers once, then retry Crib attach.',
			);
		}),
	);
	output.appendLine('crib attach bridge: ready (use Crib attach from the remote workspace to see attach logs here).');
}

/**
 * @param {unknown} arg string (container name) or { containerName?, containerId? }
 * @returns {{ containerName: string, containerId?: string, nameConfig?: unknown }}
 */
function normalizeBridgePayload(arg) {
	if (typeof arg === 'string') {
		const containerName = arg.trim();
		return { containerName, containerId: undefined, nameConfig: undefined };
	}
	if (arg && typeof arg === 'object') {
		const o = /** @type {Record<string, unknown>} */ (arg);
		const containerName = typeof o.containerName === 'string' ? o.containerName.trim() : '';
		const containerId = typeof o.containerId === 'string' ? o.containerId.trim() : '';
		const nameConfig = o.nameConfig;
		return {
			containerName,
			containerId: containerId.length > 0 ? containerId : undefined,
			nameConfig,
		};
	}
	return { containerName: '', containerId: undefined, nameConfig: undefined };
}

async function activateDevContainers() {
	for (const id of DEV_CONTAINERS_EXTENSION_IDS) {
		try {
			await vscode.extensions.getExtension(id)?.activate();
		} catch {
			// Activation failures surface when the attach command is missing below.
		}
	}
}

function deactivate() {}

function resolveUiDevContainersStorage(context) {
	const parent = vscode.Uri.joinPath(context.globalStorageUri, '..');
	for (const id of DEV_CONTAINERS_EXTENSION_IDS) {
		if (vscode.extensions.getExtension(id)) {
			const globalStorage = vscode.Uri.joinPath(parent, id);
			return {
				extensionId: id,
				nameConfigs: vscode.Uri.joinPath(globalStorage, 'nameConfigs'),
			};
		}
	}
	const globalStorage = vscode.Uri.joinPath(parent, DEV_CONTAINERS_EXTENSION_IDS[0]);
	return {
		extensionId: DEV_CONTAINERS_EXTENSION_IDS[0],
		nameConfigs: vscode.Uri.joinPath(globalStorage, 'nameConfigs'),
	};
}

async function writeUiNameConfig(containerName, nameConfig, context, output) {
	if (!isSafeContainerName(containerName)) {
		throw new Error(`unsafe containerName "${containerName}"`);
	}
	const storage = resolveUiDevContainersStorage(context);
	await vscode.workspace.fs.createDirectory(storage.nameConfigs);
	const target = vscode.Uri.joinPath(storage.nameConfigs, `${containerName}.json`);
	const serialized = `${JSON.stringify(nameConfig, null, 2)}\n`;
	await vscode.workspace.fs.writeFile(target, Buffer.from(serialized, 'utf8'));
	output.appendLine(`[attach] wrote ${path.posix.normalize(target.path)} (${storage.extensionId})`);
}

module.exports = {
	activate,
	deactivate,
	normalizeBridgePayload,
	isSafeContainerName,
};

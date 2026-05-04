import * as path from 'path';
import * as vscode from 'vscode';

export const KNOWN_DEV_CONTAINER_EXTENSION_IDS = [
	'ms-vscode-remote.remote-containers',
	'anysphere.remote-containers',
];

export interface DevContainerStorage {
	readonly extensionId: string;
	readonly extensionFound: boolean;
	readonly fallbackReason?: string;
	readonly globalStorage: vscode.Uri;
	readonly nameConfigs: vscode.Uri;
	readonly imageConfigs: vscode.Uri;
}

/**
 * Locate the Dev Containers extension's globalStorage directory by piggy-backing
 * on our own. Both extensions live as siblings under
 *   .../User/globalStorage/<extension-id>/
 * so we can derive the target path without per-OS branching, and it works
 * identically on a remote SSH host.
 */
export function getDevContainerStorage(context: vscode.ExtensionContext): DevContainerStorage {
	const ours = context.globalStorageUri;
	const parent = vscode.Uri.joinPath(ours, '..');
	const resolved = resolveDevContainerExtensionId();
	const extensionId = resolved.extensionId;
	const globalStorage = vscode.Uri.joinPath(parent, extensionId);
	return {
		extensionId,
		extensionFound: resolved.found,
		fallbackReason: resolved.fallbackReason,
		globalStorage,
		nameConfigs: vscode.Uri.joinPath(globalStorage, 'nameConfigs'),
		imageConfigs: vscode.Uri.joinPath(globalStorage, 'imageConfigs'),
	};
}

function resolveDevContainerExtensionId(): {
	extensionId: string;
	found: boolean;
	fallbackReason?: string;
} {
	return chooseDevContainerExtensionId(
		id => Boolean(vscode.extensions.getExtension(id)),
		vscode.env.appName,
	);
}

export function chooseDevContainerExtensionId(
	hasExtension: (id: string) => boolean,
	appName = '',
): { extensionId: string; found: boolean; fallbackReason?: string } {
	for (const id of KNOWN_DEV_CONTAINER_EXTENSION_IDS) {
		if (hasExtension(id)) {
			return { extensionId: id, found: true };
		}
	}
	if (isCursorApp(appName)) {
		return {
			extensionId: 'anysphere.remote-containers',
			found: false,
			fallbackReason: `Cursor app detected (${appName})`,
		};
	}
	// Fall back to the upstream id so sync can still prepare the conventional
	// location. The caller should log that this is only a best-effort path.
	return {
		extensionId: KNOWN_DEV_CONTAINER_EXTENSION_IDS[0],
		found: false,
		fallbackReason: appName ? `VS Code-compatible app detected (${appName})` : 'unknown app',
	};
}

function isCursorApp(appName: string): boolean {
	return appName.toLowerCase().includes('cursor');
}

/**
 * Build a nameConfig URI for a given container name. The Dev Containers
 * extension reads `nameConfigs/<containerName>.json`, so the file basename
 * is the container name verbatim.
 */
export function nameConfigUri(storage: DevContainerStorage, containerName: string): vscode.Uri {
	return vscode.Uri.joinPath(storage.nameConfigs, `${containerName}.json`);
}

/**
 * Build an imageConfig URI for a given image name. The Dev Containers
 * extension reads `imageConfigs/<image>.json`, where the image name
 * is the key (e.g. "my-image:latest").
 */
export function imageConfigUri(storage: DevContainerStorage, imageName: string): vscode.Uri {
	return vscode.Uri.joinPath(storage.imageConfigs, `${imageName}.json`);
}

/**
 * For logging — a printable absolute path even when the URI scheme is `vscode-remote`.
 */
export function displayPath(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : path.posix.normalize(uri.path);
}

/**
 * `cwd` for `child_process.spawn` on the extension host machine. Remote-SSH
 * workspace folders use `vscode-remote:`; only accepting `file` left `cwd`
 * unset so crib ran in the wrong directory.
 */
export function workspaceUriToSpawnCwd(uri: vscode.Uri | undefined): string | undefined {
	if (!uri) {
		return undefined;
	}
	if (uri.scheme === 'file' || uri.scheme === 'vscode-remote') {
		const trimmed = uri.fsPath?.trim();
		if (trimmed) {
			return trimmed;
		}
		const fromPath = uri.path?.trim();
		return fromPath ? path.posix.normalize(fromPath) : undefined;
	}
	return undefined;
}

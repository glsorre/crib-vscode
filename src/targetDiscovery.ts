import * as vscode from 'vscode';
import type { CribCli, CribRuntimeWorkspace } from './crib';
import { DEVCONTAINER_GLOBS, workspaceRootFor } from './devcontainer';
import { resolveContainerName } from './containerName';

export interface DiscoveredTarget {
	readonly devcontainerUri: vscode.Uri;
	readonly workspaceFolderUri: vscode.Uri;
	readonly containerName: string;
	/** False when the row comes from crib runtime but `.devcontainer/devcontainer.json` (or legacy) is missing — lifecycle works; sync/attach need a real file. */
	readonly devcontainerOnDisk: boolean;
}

export interface DiscoverySummary {
	readonly workspaceCount: number;
	readonly runtimeReported: number;
	readonly runtimeUsable: number;
	readonly totalUnique: number;
}

async function devcontainerUriUnderFolder(folderUri: vscode.Uri): Promise<vscode.Uri | undefined> {
	const nested = vscode.Uri.joinPath(folderUri, '.devcontainer', 'devcontainer.json');
	try {
		await vscode.workspace.fs.stat(nested);
		return nested;
	} catch {
		// continue
	}
	const legacy = vscode.Uri.joinPath(folderUri, '.devcontainer.json');
	try {
		await vscode.workspace.fs.stat(legacy);
		return legacy;
	} catch {
		return undefined;
	}
}

async function folderUriFromSourcePath(
	source: string,
	appendLog?: (m: string) => void,
): Promise<vscode.Uri | undefined> {
	const trimmed = source.trim();
	if (
		!trimmed.startsWith('/') &&
		!/^[a-zA-Z]:[\\/]/.test(trimmed)
	) {
		return undefined;
	}
	const folderUri = vscode.Uri.file(trimmed);
	const noOpenFolders = (vscode.workspace.workspaceFolders?.length ?? 0) === 0;
	try {
		await vscode.workspace.fs.stat(folderUri);
		return folderUri;
	} catch {
		if (noOpenFolders) {
			appendLog?.(
				`[discover] stat(${trimmed}) failed with no open folder; using path anyway for crib runtime listing`,
			);
			return folderUri;
		}
		return undefined;
	}
}

/** Used when crib reports a source path but no devcontainer.json exists yet. */
export function discoveredRuntimeTargetWithoutDevcontainer(
	folderUri: vscode.Uri,
	containerName: string,
): DiscoveredTarget {
	const dc = vscode.Uri.joinPath(folderUri, '.devcontainer', 'devcontainer.json');
	return {
		devcontainerUri: dc,
		workspaceFolderUri: folderUri,
		containerName,
		devcontainerOnDisk: false,
	};
}

async function targetFromRuntimeWorkspace(
	runtime: CribRuntimeWorkspace,
	crib: CribCli,
	appendLog: (m: string) => void,
): Promise<DiscoveredTarget | undefined> {
	if (!runtime.source) {
		return undefined;
	}
	const folderUri = await folderUriFromSourcePath(runtime.source, appendLog);
	if (!folderUri) {
		appendLog(`[discover] crib source path missing or unreadable: ${runtime.source}`);
		return undefined;
	}
	const dc = await devcontainerUriUnderFolder(folderUri);
	if (!dc) {
		let containerName: string;
		if (runtime.containerName && runtime.containerName.trim().length > 0) {
			containerName = runtime.containerName.trim();
		} else {
			containerName = await resolveContainerName(folderUri, crib, appendLog);
		}
		appendLog(
			`[discover] crib runtime ${runtime.source}: no devcontainer.json on disk; listing for lifecycle only`,
		);
		return discoveredRuntimeTargetWithoutDevcontainer(folderUri, containerName);
	}
	let containerName: string;
	if (runtime.containerName && runtime.containerName.trim().length > 0) {
		containerName = runtime.containerName.trim();
	} else {
		containerName = await resolveContainerName(folderUri, crib, appendLog);
	}
	return {
		devcontainerUri: dc,
		workspaceFolderUri: workspaceRootFor(dc),
		containerName,
		devcontainerOnDisk: true,
	};
}

/** Root devcontainer paths (spec): nested config or legacy single file at workspace root. */
async function statRootDevcontainerUris(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
	const candidates = [
		vscode.Uri.joinPath(folder.uri, '.devcontainer', 'devcontainer.json'),
		vscode.Uri.joinPath(folder.uri, '.devcontainer.json'),
	];
	const found: vscode.Uri[] = [];
	for (const u of candidates) {
		try {
			await vscode.workspace.fs.stat(u);
			found.push(u);
		} catch {
			// not present
		}
	}
	return found;
}

/** Devcontainer files found under open workspace folders. */
export async function collectWorkspaceScan(
	crib: CribCli,
	appendLog: (m: string) => void,
): Promise<DiscoveredTarget[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		appendLog('[discover] workspace scan: no vscode.workspace.workspaceFolders (crib runtime listing may still apply)');
		return [];
	}

	const out: DiscoveredTarget[] = [];
	const seen = new Set<string>();

	const pushUri = async (uri: vscode.Uri) => {
		const key = uri.toString();
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		const folderUri = workspaceRootFor(uri);
		const containerName = await resolveContainerName(folderUri, crib, appendLog);
		out.push({
			devcontainerUri: uri,
			workspaceFolderUri: folderUri,
			containerName,
			devcontainerOnDisk: true,
		});
	};

	for (const folder of folders) {
		appendLog(
			`[discover] workspace scan: folder="${folder.name}" scheme=${folder.uri.scheme} index=${folder.index}`,
		);

		const rootHits = await statRootDevcontainerUris(folder);
		if (rootHits.length > 0) {
			appendLog(`[discover] workspace scan: stat(root) in "${folder.name}" → ${rootHits.length} file(s)`);
		}
		for (const u of rootHits) {
			await pushUri(u);
		}

		for (const glob of DEVCONTAINER_GLOBS) {
			const pattern = new vscode.RelativePattern(folder, glob);
			const matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
			appendLog(`[discover] workspace scan: findFiles ${glob} in "${folder.name}" → ${matches.length} match(es)`);
			for (const uri of matches) {
				await pushUri(uri);
			}
		}
	}

	return out;
}

/** Targets derived from `crib ls` / `ps` / `status` when no open-folder devcontainer applies. */
export async function collectFallbackFromCribRuntime(
	crib: CribCli,
	appendLog: (m: string) => void,
): Promise<DiscoveredTarget[]> {
	let runtimes: readonly CribRuntimeWorkspace[];
	try {
		runtimes = await crib.listRuntimeWorkspaces();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendLog(`[discover] crib listRuntimeWorkspaces failed: ${msg}`);
		return [];
	}
	if (runtimes.length === 0) {
		appendLog(`[discover] crib binary was: ${JSON.stringify(crib.binary)}`);
		appendLog(
			'[discover] crib runtime list is empty (no rows in crib store, or list output not parsed — scroll up in this channel for `[discover] crib printed text…` or install errors).',
		);
		return [];
	}
	const out: DiscoveredTarget[] = [];
	for (const r of runtimes) {
		const t = await targetFromRuntimeWorkspace(r, crib, appendLog);
		if (t) {
			out.push(t);
		}
	}
	const skipped = runtimes.length - out.length;
	appendLog(
		`[discover] crib runtime candidates=${runtimes.length}, usable=${out.length}, skipped=${skipped}`,
	);
	return mergeUniqueTargets([], out);
}

export function mergeUniqueTargets(
	primary: readonly DiscoveredTarget[],
	secondary: readonly DiscoveredTarget[],
): DiscoveredTarget[] {
	const seen = new Set<string>();
	const out: DiscoveredTarget[] = [];
	for (const t of [...primary, ...secondary]) {
		const key = t.devcontainerUri.toString();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(t);
	}
	return out;
}

export async function collectAllDiscoverableTargets(
	crib: CribCli,
	appendLog: (m: string) => void,
): Promise<DiscoveredTarget[]> {
	const fromWorkspace = await collectWorkspaceScan(crib, appendLog);
	const fromCrib = await collectFallbackFromCribRuntime(crib, appendLog);
	const merged = mergeUniqueTargets(fromWorkspace, fromCrib);
	appendLog(formatDiscoverySummary({
		workspaceCount: fromWorkspace.length,
		runtimeReported: fromCrib.length,
		runtimeUsable: fromCrib.length,
		totalUnique: merged.length,
	}));
	return merged;
}

export function formatDiscoverySummary(summary: DiscoverySummary): string {
	return (
		'[discover] summary: ' +
		`workspace=${summary.workspaceCount}, ` +
		`runtimeReported=${summary.runtimeReported}, ` +
		`runtimeUsable=${summary.runtimeUsable}, ` +
		`merged=${summary.totalUnique}`
	);
}

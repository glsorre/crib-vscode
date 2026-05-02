import * as vscode from 'vscode';
import { DevContainerJson, vscodeCustomizations } from './devcontainer';
import { FeatureCustomizations } from './features';

/**
 * Marker key we put on every nameConfig we author so a future version can
 * prune cleanly without trampling user-added keys.
 */
export const MANAGED_BY_KEY = 'x-crib-managed';

export interface NameConfig {
	workspaceFolder?: string;
	remoteUser?: string;
	remoteEnv?: Record<string, string | null>;
	forwardPorts?: Array<number | string>;
	postAttachCommand?: unknown;
	extensions?: string[];
	settings?: Record<string, unknown>;
	[k: string]: unknown;
}

/**
 * Produce the attached-container schema (root-level `extensions`/`settings`,
 * NOT `customizations.vscode.*`). The Dev Containers extension reads exactly
 * this shape from `nameConfigs/<name>.json` and `imageConfigs/<image>.json`.
 */
export function buildNameConfig(
	devcontainer: DevContainerJson,
	features: FeatureCustomizations | undefined,
	extraExtensions: ReadonlyArray<string>,
): NameConfig {
	const own = vscodeCustomizations(devcontainer);
	const extensions = uniqueStrings([
		...own.extensions,
		...(features?.extensions ?? []),
		...extraExtensions,
	]);
	const settings: Record<string, unknown> = {
		...(features?.settings ?? {}),
		...own.settings,
	};

	const out: NameConfig = {};
	if (devcontainer.workspaceFolder) {
		out.workspaceFolder = devcontainer.workspaceFolder;
	}
	if (devcontainer.remoteUser) {
		out.remoteUser = devcontainer.remoteUser;
	}
	if (devcontainer.remoteEnv) {
		out.remoteEnv = { ...devcontainer.remoteEnv };
	}
	if (devcontainer.forwardPorts) {
		out.forwardPorts = [...devcontainer.forwardPorts];
	}
	if (devcontainer.postAttachCommand !== undefined) {
		out.postAttachCommand = devcontainer.postAttachCommand;
	}
	if (extensions.length > 0) {
		out.extensions = extensions;
	}
	if (Object.keys(settings).length > 0) {
		out.settings = settings;
	}
	return out;
}

interface ManagedMarker {
	tool: 'crib-vscode';
	managedKeys: string[];
	source: string;
	updatedAt: string;
}

/**
 * Read-modify-write merge into the destination file. We only own the keys we
 * wrote last time (recorded under `x-crib-managed`); any key the user added
 * by hand is preserved verbatim.
 *
 * The write is atomic: tmp file in the same directory, then rename, so a
 * crashed write never leaves a half-formed JSON behind.
 */
export async function writeNameConfig(
	target: vscode.Uri,
	next: NameConfig,
	source: string,
): Promise<{ written: boolean; merged: NameConfig }> {
	const existing = await readJsonIfExists(target);
	const previousMarker = (existing?.[MANAGED_BY_KEY] as ManagedMarker | undefined) ?? undefined;
	const previouslyManaged = new Set(previousMarker?.managedKeys ?? []);

	const merged: Record<string, unknown> = { ...(existing ?? {}) };

	// Drop keys we wrote last time but are no longer producing.
	for (const key of previouslyManaged) {
		if (!(key in next)) {
			delete merged[key];
		}
	}
	// Apply the new managed keys.
	for (const [k, v] of Object.entries(next)) {
		merged[k] = v;
	}

	const managedKeys = Object.keys(next).sort();
	const marker: ManagedMarker = {
		tool: 'crib-vscode',
		managedKeys,
		source,
		updatedAt: new Date().toISOString(),
	};
	merged[MANAGED_BY_KEY] = marker;

	if (existing && deepEqualWithoutTimestamp(existing, merged)) {
		return { written: false, merged: merged as NameConfig };
	}

	const dir = vscode.Uri.joinPath(target, '..');
	await vscode.workspace.fs.createDirectory(dir);
	const tmp = vscode.Uri.joinPath(dir, `.${target.path.split('/').pop()}.${process.pid}.tmp`);
	const payload = Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8');
	await vscode.workspace.fs.writeFile(tmp, payload);
	try {
		await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
	} catch (err) {
		// Best effort: drop the temp file before rethrowing.
		try {
			await vscode.workspace.fs.delete(tmp);
		} catch {
			// ignore
		}
		throw err;
	}
	return { written: true, merged: merged as NameConfig };
}

export async function deleteNameConfig(target: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.delete(target);
		return true;
	} catch {
		return false;
	}
}

async function readJsonIfExists(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// File missing or corrupt — treat as fresh.
	}
	return undefined;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (typeof v !== 'string' || v.length === 0) {
			continue;
		}
		const key = v.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(v);
	}
	return out;
}

/**
 * Compare two configs ignoring the `updatedAt` field of the marker so that
 * idempotent syncs don't churn the file (and don't trip filesystem watchers
 * elsewhere into re-syncing forever).
 */
function deepEqualWithoutTimestamp(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const stripA = stripTimestamp(a);
	const stripB = stripTimestamp(b);
	return JSON.stringify(stripA) === JSON.stringify(stripB);
}

function stripTimestamp(obj: Record<string, unknown>): Record<string, unknown> {
	const { [MANAGED_BY_KEY]: marker, ...rest } = obj;
	if (marker && typeof marker === 'object') {
		const { updatedAt: _ts, ...restMarker } = marker as ManagedMarker & Record<string, unknown>;
		return { ...rest, [MANAGED_BY_KEY]: restMarker };
	}
	return rest;
}

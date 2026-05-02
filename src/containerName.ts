import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Whitelist for any name we will append to a filesystem path or pass into
 * IPC. Matches the `[a-z0-9._-]` set produced by {@link deriveContainerName}
 * (case-insensitive on the way in to tolerate values reported by `crib
 * status`). Anything else is rejected upstream of joinPath / writeFile.
 */
export const SAFE_CONTAINER_NAME = /^[A-Za-z0-9._-]+$/;

export function isSafeContainerName(value: unknown): value is string {
	return typeof value === 'string' && SAFE_CONTAINER_NAME.test(value);
}

/**
 * Mirror of crib's workspace-name derivation. Per the crib blog post and
 * source, the workspace name is the basename of the workspace folder,
 * sanitised to a Docker-safe identifier:
 *
 *   - lower-case
 *   - non-alphanumerics collapsed to `-`
 *   - leading/trailing `-` trimmed
 *   - if the result is empty, fall back to "workspace"
 *
 * This MUST stay in sync with crib's own logic. We treat any mismatch
 * surfaced by `crib status` as authoritative and reconcile by reading the
 * actual container name from there.
 */
export function deriveContainerName(workspaceFolder: vscode.Uri): string {
	const base = path.posix.basename(workspaceFolder.path) || 'workspace';
	const sanitised = base
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return sanitised || 'workspace';
}

/**
 * Best-effort cross-check against `crib status --json`. Falls back to the
 * derived name if crib is not installed, the call fails, or the output
 * cannot be parsed. Either way we always return a usable name.
 */
export async function resolveContainerName(
	workspaceFolder: vscode.Uri,
	crib: { status: (cwd: vscode.Uri) => Promise<unknown> } | undefined,
	logger?: (message: string) => void,
): Promise<string> {
	const derived = deriveContainerName(workspaceFolder);
	if (!crib) {
		logger?.(`[container] using derived name "${derived}" because crib is unavailable`);
		return derived;
	}
	try {
		const status = await crib.status(workspaceFolder);
		const fromCrib = extractContainerName(status);
		if (!fromCrib) {
			logger?.(`[container] crib status did not report a container name; using derived name "${derived}"`);
		}
		return fromCrib ?? derived;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger?.(`[container] crib status failed (${msg}); using derived name "${derived}"`);
		return derived;
	}
}

/**
 * Extract the container name from any of the shapes crib's status output
 * has historically returned. We're permissive on purpose: the field name
 * differs across versions (`containerName`, `name`, `workspace.name`).
 */
export function extractContainerName(status: unknown): string | undefined {
	if (typeof status === 'string') {
		return extractContainerNameFromText(status);
	}
	if (!status || typeof status !== 'object') {
		return undefined;
	}
	const obj = status as Record<string, unknown>;
	for (const key of ['containerName', 'container_name', 'name']) {
		const v = obj[key];
		if (isSafeContainerName(v)) {
			return v;
		}
	}
	const ws = obj['workspace'] ?? obj['Workspace'];
	if (ws && typeof ws === 'object') {
		const wsObj = ws as Record<string, unknown>;
		for (const key of ['containerName', 'container_name', 'name']) {
			const v = wsObj[key];
			if (isSafeContainerName(v)) {
				return v;
			}
		}
	}
	const raw = obj['raw'];
	if (typeof raw === 'string') {
		return extractContainerNameFromText(raw);
	}
	return undefined;
}

function extractContainerNameFromText(text: string): string | undefined {
	const match = text.match(/^\s*container\s+(\S+)\s*$/m);
	const candidate = match?.[1];
	return isSafeContainerName(candidate) ? candidate : undefined;
}

/**
 * Extract crib-reported workspace source path from status-derived shapes.
 * Mirrors `extractContainerName` field coverage where possible.
 */
export function extractSourcePath(status: unknown): string | undefined {
	if (typeof status === 'string') {
		return extractSourcePathFromText(status);
	}
	if (!status || typeof status !== 'object') {
		return undefined;
	}
	const obj = status as Record<string, unknown>;
	for (const key of ['source', 'path', 'workspacePath', 'workspace_path', 'cwd']) {
		const v = obj[key];
		if (typeof v === 'string' && looksLikeFilesystemPath(v)) {
			return v;
		}
	}
	const ws = obj['workspace'] ?? obj['Workspace'];
	if (ws && typeof ws === 'object') {
		const wsObj = ws as Record<string, unknown>;
		for (const key of ['source', 'path', 'folder', 'folderPath']) {
			const v = wsObj[key];
			if (typeof v === 'string' && looksLikeFilesystemPath(v)) {
				return v;
			}
		}
	}
	const raw = obj['raw'];
	if (typeof raw === 'string') {
		return extractSourcePathFromText(raw);
	}
	return undefined;
}

export function extractSourcePathFromText(text: string): string | undefined {
	const match = text.match(/^\s*source\s+(\S+)\s*$/im);
	const pathPiece = match?.[1]?.trim();
	if (pathPiece && looksLikeFilesystemPath(pathPiece)) {
		return pathPiece;
	}
	return undefined;
}

function looksLikeFilesystemPath(s: string): boolean {
	const t = s.trim();
	return t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t);
}

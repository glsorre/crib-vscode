import * as vscode from 'vscode';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';

export type FeaturesMap = Record<string, unknown>;

/**
 * Subset of the devcontainer.json schema we care about. We deliberately keep
 * unknown keys around in `raw` so callers can pass them through.
 */
export interface DevContainerJson {
	readonly raw: Record<string, unknown>;
	readonly name?: string;
	readonly workspaceFolder?: string;
	readonly remoteUser?: string;
	readonly remoteEnv?: Record<string, string | null>;
	readonly forwardPorts?: ReadonlyArray<number | string>;
	readonly postAttachCommand?: unknown;
	readonly customizations?: {
		readonly vscode?: {
			readonly extensions?: ReadonlyArray<string>;
			readonly settings?: Record<string, unknown>;
		};
	};
	readonly features?: FeaturesMap;
	readonly image?: string;
	readonly dockerComposeFile?: string | string[];
	readonly service?: string;
	readonly build?: { readonly dockerfile?: string; readonly context?: string };
}

export interface ParsedDevContainer {
	readonly uri: vscode.Uri;
	readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
	readonly config: DevContainerJson;
}

/**
 * Filenames the devcontainer spec accepts in priority order. We surface both
 * locations because either is valid (the spec lists `.devcontainer.json` as
 * legacy but still supported).
 */
export const DEVCONTAINER_GLOBS: ReadonlyArray<string> = [
	'**/.devcontainer/devcontainer.json',
	'**/.devcontainer.json',
];

export async function readDevContainer(uri: vscode.Uri): Promise<ParsedDevContainer> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	const text = Buffer.from(bytes).toString('utf8');
	const errors: ParseError[] = [];
	const parsed = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: false });
	if (!parsed || typeof parsed !== 'object') {
		throw new DevContainerParseError(uri, errors, 'devcontainer.json did not parse to an object');
	}
	if (errors.length > 0) {
		// JSONC-parser still returns a partial object on recoverable errors; we
		// surface them but only throw if the result is unusable.
		const messages = errors
			.map(e => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
			.join(', ');
		console.warn(`[crib] devcontainer.json parsed with warnings (${uri.toString()}): ${messages}`);
	}
	const config = parsed as DevContainerJson & { raw: Record<string, unknown> };
	(config as { raw: Record<string, unknown> }).raw = parsed as Record<string, unknown>;
	return {
		uri,
		workspaceFolder: vscode.workspace.getWorkspaceFolder(uri),
		config,
	};
}

export class DevContainerParseError extends Error {
	constructor(
		public readonly uri: vscode.Uri,
		public readonly errors: ParseError[],
		message: string,
	) {
		super(`${message} (${uri.toString()})`);
		this.name = 'DevContainerParseError';
	}
}

/**
 * Pull `customizations.vscode.{extensions,settings}` out of the parsed config.
 * Returns empty arrays/objects rather than `undefined` so callers can blindly
 * union them.
 */
export function vscodeCustomizations(config: DevContainerJson): {
	extensions: string[];
	settings: Record<string, unknown>;
} {
	const vscodeBlock = config.customizations?.vscode;
	const extensions = Array.isArray(vscodeBlock?.extensions)
		? [...(vscodeBlock!.extensions as ReadonlyArray<string>)]
		: [];
	const settings =
		vscodeBlock?.settings && typeof vscodeBlock.settings === 'object'
			? { ...(vscodeBlock.settings as Record<string, unknown>) }
			: {};
	return { extensions, settings };
}

/**
 * The `features` map can use either string keys (the OCI ref) with object
 * values (the per-feature options), or — historically — be absent. We
 * normalise to a Map and skip falsy entries.
 */
export function featureRefs(config: DevContainerJson): string[] {
	const features = config.features;
	if (!features || typeof features !== 'object') {
		return [];
	}
	return Object.keys(features).filter(k => typeof k === 'string' && k.length > 0);
}

/**
 * Resolve the workspace folder a devcontainer.json belongs to. We fall back
 * to walking the path because `vscode.workspace.getWorkspaceFolder` returns
 * undefined for files outside any folder (which can happen when the user
 * opens a single file).
 */
export function workspaceRootFor(uri: vscode.Uri): vscode.Uri {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder) {
		return folder.uri;
	}
	// .devcontainer/devcontainer.json -> drop two segments; .devcontainer.json -> drop one.
	const parts = uri.path.split('/');
	const last = parts[parts.length - 1];
	const drop = last === 'devcontainer.json' && parts[parts.length - 2] === '.devcontainer' ? 2 : 1;
	const rootPath = parts.slice(0, parts.length - drop).join('/') || '/';
	return uri.with({ path: rootPath });
}

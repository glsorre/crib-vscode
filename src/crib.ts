import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { workspaceUriToSpawnCwd } from './paths';
import { extractContainerName, extractSourcePath } from './containerName';
import {
	extractDockerContainerIdFromStatusJson,
	extractDockerContainerIdFromText,
	firstDockerIdFromPsQOutput,
	normalizeDockerInspectId,
	resolveDockerContainerIdFromDockerPs,
} from './dockerContainerId';

export class CribNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CribNotFoundError';
	}
}

export type CribState = 'up' | 'down' | 'unknown';

export interface CribStatus {
	state: CribState;
	containerName?: string;
	image?: string;
	raw?: unknown;
}

/** One crib-managed workspace as reported by `crib ls`/`ps`/`status` (text or JSON). */
export interface CribRuntimeWorkspace {
	readonly source?: string;
	readonly containerName?: string;
	readonly workspaceKey?: string;
	readonly raw?: unknown;
}

export class CribCli {
	constructor(
		private readonly output: vscode.OutputChannel,
		private readonly resolveBinary: () => string,
	) {}

	get binary(): string {
		return this.resolveBinary();
	}

	/** Run `crib up`, streaming to the output channel. */
	up(cwd: vscode.Uri, opts: { recreate?: boolean } = {}): Promise<void> {
		const args = ['up'];
		if (opts.recreate) {
			args.push('--recreate');
		}
		return this.runStreaming(cwd, args);
	}

	down(cwd: vscode.Uri): Promise<void> {
		return this.runStreaming(cwd, ['down']);
	}

	restart(cwd: vscode.Uri): Promise<void> {
		return this.runStreaming(cwd, ['restart']);
	}

	rebuild(cwd: vscode.Uri): Promise<void> {
		return this.runStreaming(cwd, ['rebuild']);
	}

	remove(cwd: vscode.Uri): Promise<void> {
		return this.runStreaming(cwd, ['remove']);
	}

	async version(): Promise<string | undefined> {
		for (const args of [['--version'], ['version']] as const) {
			try {
				const out = await this.runCapture(undefined, [...args]);
				const line = out.trim().split(/\r?\n/)[0]?.trim();
				if (line) {
					return line;
				}
			} catch {
				// try next
			}
		}
		return undefined;
	}

	/**
	 * Best-effort status. We try `--json` first; if crib doesn't support it
	 * (older versions or different subcommand spellings), we fall back to a
	 * plain `status` and just report `unknown`.
	 */
	async status(cwd: vscode.Uri): Promise<CribStatus> {
		for (const args of [['status', '--json'], ['status', '-o', 'json']]) {
			try {
				const out = await this.runCapture(cwd, args);
				const parsed = JSON.parse(out);
				return interpretStatus(parsed);
			} catch {
				// try next variant
			}
		}
		try {
			const out = await this.runCapture(cwd, ['status']);
			return { state: heuristicState(out), raw: out };
		} catch (err) {
			if (err instanceof CribNotFoundError) {
				throw err;
			}
			return { state: 'unknown' };
		}
	}

	/**
	 * Discover crib workspaces without relying on VS Code workspace folders.
	 */
	async listRuntimeWorkspaces(): Promise<readonly CribRuntimeWorkspace[]> {
		const jsonVariants: ReadonlyArray<string[]> = [
			['ls', '--json'],
			['ls', '-o', 'json'],
			['ps', '--json'],
			['ps', '-o', 'json'],
			['status', '--json'],
			['status', '-o', 'json'],
		];
		for (const args of jsonVariants) {
			try {
				const out = await this.runCapture(undefined, args);
				const parsed = JSON.parse(out);
				const list = workspacesFromJson(parsed);
				if (list.length > 0) {
					return list;
				}
			} catch {
				// continue
			}
		}
		let lastPlainWithNoRows: string | undefined;
		for (const cmd of [['list'], ['ls'], ['ps'], ['status']] as const) {
			try {
				const out = await this.runCapture(undefined, [...cmd]);
				const list = parseCribDiscoverText(out);
				if (list.length > 0) {
					return list;
				}
				if (out.trim().length > 0) {
					lastPlainWithNoRows = out;
				}
			} catch {
				// continue
			}
		}
		if (lastPlainWithNoRows !== undefined) {
			const line = lastPlainWithNoRows.trim().split(/\r?\n/)[0] ?? '';
			this.output.appendLine(
				`[discover] crib printed text but no workspaces were parsed (first line): ${line.slice(0, 200)}`,
			);
		} else {
			this.output.appendLine(
				'[discover] crib list/ls produced no stdout or failed; check `crib.path` and PATH on this host.',
			);
		}
		return [];
	}

	private runStreaming(cwd: vscode.Uri | undefined, args: string[]): Promise<void> {
		const bin = this.binary;
		this.output.appendLine(`$ ${bin} ${args.join(' ')}`);
		return new Promise((resolve, reject) => {
			const proc = spawnSafe(bin, args, cwd);
			proc.stdout?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
			proc.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
			proc.on('error', err => reject(translateSpawnError(bin, err)));
			proc.on('close', code => {
				this.output.appendLine(`[exit ${code ?? 0}]`);
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`crib ${args.join(' ')} exited with code ${code}`));
				}
			});
		});
	}

	/**
	 * Resolve the Docker container ID for `containerName` on the workspace host:
	 * crib status output first, then `docker ps -a`.
	 */
	async resolveContainerDockerId(cwd: vscode.Uri, containerName: string): Promise<string | undefined> {
		try {
			this.output.appendLine(`[attach] resolving Docker id for container name "${containerName}"`);
			const status = await this.status(cwd);
			const raw = status.raw;
			if (raw !== undefined) {
				if (typeof raw === 'string') {
					this.output.appendLine('[attach] trying crib status text parser for docker id');
					const id = extractDockerContainerIdFromText(raw, containerName);
					if (id) {
						this.output.appendLine(`[attach] docker id resolved from crib status text: ${id}`);
						return id;
					}
					this.output.appendLine('[attach] crib status text did not include a matching docker id');
				} else {
					this.output.appendLine('[attach] trying crib status json parser for docker id');
					const id = extractDockerContainerIdFromStatusJson(raw, containerName);
					if (id) {
						this.output.appendLine(`[attach] docker id resolved from crib status json: ${id}`);
						return id;
					}
					this.output.appendLine('[attach] crib status json did not include a matching docker id');
				}
			}
			return await this.resolveDockerContainerIdFromDocker(containerName);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[attach] resolveContainerDockerId failed: ${msg}`);
			return undefined;
		}
	}

	private async resolveDockerContainerIdFromDocker(containerName: string): Promise<string | undefined> {
		const want = containerName.trim();
		if (!want) {
			return undefined;
		}

		this.output.appendLine(`[attach] trying docker ps -a name matching for "${want}"`);
		const tabOut = await this.tryDockerCapture(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}']);
		if (tabOut) {
			const fromPs = resolveDockerContainerIdFromDockerPs(tabOut, want);
			if (fromPs) {
				this.output.appendLine(`[attach] docker id resolved from docker ps -a: ${fromPs}`);
				return fromPs;
			}
			this.output.appendLine('[attach] docker ps -a had no matching name/id pair');
		}

		this.output.appendLine(`[attach] trying docker ps -q --filter name=${want}`);
		const filterRunning = await this.tryDockerCapture(['ps', '-q', '--filter', `name=${want}`]);
		if (filterRunning) {
			const id = firstDockerIdFromPsQOutput(filterRunning);
			if (id) {
				this.output.appendLine(`[attach] docker id resolved from docker ps -q filter: ${id}`);
				return id;
			}
			this.output.appendLine('[attach] docker ps -q filter returned no valid id');
		}

		this.output.appendLine(`[attach] trying docker ps -aq --filter name=${want}`);
		const filterAll = await this.tryDockerCapture(['ps', '-aq', '--filter', `name=${want}`]);
		if (filterAll) {
			const id = firstDockerIdFromPsQOutput(filterAll);
			if (id) {
				this.output.appendLine(`[attach] docker id resolved from docker ps -aq filter: ${id}`);
				return id;
			}
			this.output.appendLine('[attach] docker ps -aq filter returned no valid id');
		}

		this.output.appendLine(`[attach] trying docker inspect for "${want}"`);
		const inspectOut = await this.tryDockerCapture(['inspect', '-f', '{{.Id}}', want]);
		if (inspectOut) {
			const id = normalizeDockerInspectId(inspectOut);
			if (id) {
				this.output.appendLine(`[attach] docker id resolved from docker inspect: ${id}`);
				return id;
			}
			this.output.appendLine('[attach] docker inspect output did not contain a valid id');
		}

		this.output.appendLine('[attach] no docker id resolved from crib status or docker CLI fallbacks');
		return undefined;
	}

	private async tryDockerCapture(args: string[]): Promise<string | undefined> {
		try {
			return await this.runDockerCapture(args);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[docker] docker ${args.join(' ')} failed: ${msg}`);
			return undefined;
		}
	}

	private runDockerCapture(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc = spawn('docker', args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env },
			});
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
			proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
			proc.on('error', err => reject(err));
			proc.on('close', code => {
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(`docker ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
				}
			});
		});
	}

	private runCapture(cwd: vscode.Uri | undefined, args: string[]): Promise<string> {
		const bin = this.binary;
		return new Promise((resolve, reject) => {
			const proc = spawnSafe(bin, args, cwd);
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on('error', err => reject(translateSpawnError(bin, err)));
			proc.on('close', code => {
				if (code === 0) {
					resolve(stdout);
				} else {
					reject(new Error(`crib ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
				}
			});
		});
	}
}

function spawnSafe(bin: string, args: string[], cwd: vscode.Uri | undefined): ChildProcess {
	const cwdStr = workspaceUriToSpawnCwd(cwd);
	return spawn(bin, args, {
		cwd: cwdStr,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env },
	});
}

function translateSpawnError(bin: string, err: NodeJS.ErrnoException): Error {
	if (err.code === 'ENOENT') {
		return new CribNotFoundError(
			`Could not find the crib executable (${bin}). ` +
				`Install it from https://github.com/fgrehm/crib or set the "crib.path" setting.`,
		);
	}
	return err;
}

function interpretStatus(parsed: unknown): CribStatus {
	if (!parsed || typeof parsed !== 'object') {
		return { state: 'unknown', raw: parsed };
	}
	const obj = parsed as Record<string, unknown>;
	const state = readState(obj);
	return {
		state,
		containerName: extractContainerName(parsed),
		image: typeof obj.image === 'string' ? obj.image : undefined,
		raw: parsed,
	};
}

function readState(obj: Record<string, unknown>): CribState {
	const fields = ['state', 'status', 'phase'];
	for (const f of fields) {
		const v = obj[f];
		if (typeof v === 'string') {
			const lower = v.toLowerCase();
			if (lower.includes('run') || lower === 'up' || lower === 'started') {
				return 'up';
			}
			if (lower.includes('stop') || lower === 'down' || lower === 'exited') {
				return 'down';
			}
		}
	}
	if (typeof obj.running === 'boolean') {
		return obj.running ? 'up' : 'down';
	}
	return 'unknown';
}

function heuristicState(text: string): CribState {
	const lower = text.toLowerCase();
	if (lower.includes('running') || lower.includes(' up ')) {
		return 'up';
	}
	if (lower.includes('stopped') || lower.includes('not running') || lower.includes(' down ')) {
		return 'down';
	}
	return 'unknown';
}

function workspacesFromJson(parsed: unknown): CribRuntimeWorkspace[] {
	if (Array.isArray(parsed)) {
		const out: CribRuntimeWorkspace[] = [];
		for (const el of parsed) {
			out.push(...workspacesFromJson(el));
		}
		return normalizeRuntimeList(out);
	}
	if (!parsed || typeof parsed !== 'object') {
		return [];
	}
	const obj = parsed as Record<string, unknown>;
	const keys = ['workspaces', 'items', 'instances', 'containers', 'records', 'data'];
	for (const k of keys) {
		const nested = obj[k];
		if (Array.isArray(nested)) {
			return normalizeRuntimeList(
				nested.flatMap(item => (item && typeof item === 'object' ? [recordFromJson(item)] : [])),
			);
		}
	}
	return normalizeRuntimeList([recordFromJson(obj)]);
}

function recordFromJson(item: unknown): CribRuntimeWorkspace {
	if (!item || typeof item !== 'object') {
		return { raw: item };
	}
	const o = item as Record<string, unknown>;
	const source = extractSourcePath(o);
	const containerName = extractContainerName(o);
	let workspaceKey: string | undefined;
	for (const key of ['workspaceId', 'workspace_key', 'slug', 'id', 'workspaceKey']) {
		const v = o[key];
		if (typeof v === 'string' && v.trim().length > 0) {
			workspaceKey = v.trim();
			break;
		}
	}
	const nestedWs = o.workspace;
	if (
		typeof nestedWs === 'object' &&
		nestedWs !== null &&
		typeof (nestedWs as Record<string, unknown>).id === 'string'
	) {
		workspaceKey = (nestedWs as Record<string, unknown>).id as string;
	}
	return { source, containerName, workspaceKey, raw: item };
}

/** Parse plain `crib ls` table, `docker ps`-like lines, or `crib status` blocks. */
export function parseCribDiscoverText(text: string): CribRuntimeWorkspace[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	const fromTable = parseCribLsTable(trimmed);
	if (fromTable.length > 0) {
		return normalizeRuntimeList(fromTable);
	}
	const fromBlocks = parseCribStatusBlocks(trimmed);
	if (fromBlocks.length > 0) {
		return normalizeRuntimeList(fromBlocks);
	}
	return normalizeRuntimeList([]);
}

function parseCribLsTable(text: string): CribRuntimeWorkspace[] {
	const lines = text.split(/\r?\n/);
	const idx = lines.findIndex(
		l => /\bWORKSPACE\b/i.test(l) && /\bSOURCE\b/i.test(l),
	);
	if (idx < 0 || idx >= lines.length - 1) {
		return [];
	}
	const out: CribRuntimeWorkspace[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		// Trim end only: crib's non-TTY table pads columns with spaces; keep leading pad for alignment.
		const line = lines[i]?.replace(/\s+$/, '') ?? '';
		if (!line.trim() || line.trim().startsWith('-')) {
			continue;
		}
		// fgrehm/crib prints columns with a single space after the padded workspace id when stdout is not a TTY (piped).
		const match = line.match(/^(\S+)\s+(\S.*)$/);
		if (!match) {
			continue;
		}
		const workspaceKey = match[1].trim();
		const sourceCell = match[2].trimEnd();
		const source = sourceCell.split(/\s+/)[0] ?? '';
		if (!source.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(source)) {
			continue;
		}
		out.push({ workspaceKey, source, raw: line.trimEnd() });
	}
	return out;
}

function parseCribStatusBlocks(text: string): CribRuntimeWorkspace[] {
	const chunks = text.split(/\n(?=\s*==>\s+)/).map(c => c.trim()).filter(Boolean);
	if (chunks.length === 0) {
		return [];
	}
	const out: CribRuntimeWorkspace[] = [];
	for (const chunk of chunks) {
		let workspaceKey: string | undefined;
		const wm = chunk.match(/==>\s*(\S+)/);
		if (wm) {
			workspaceKey = wm[1];
		}
		const source = extractSourcePath(chunk) ?? extractSourcePath({ raw: chunk });
		const containerName = extractContainerName(chunk);
		if (!source && !containerName) {
			continue;
		}
		out.push({ workspaceKey, source, containerName, raw: chunk });
	}
	return out;
}

function normalizeRuntimeList(items: readonly CribRuntimeWorkspace[]): CribRuntimeWorkspace[] {
	const seen = new Set<string>();
	const out: CribRuntimeWorkspace[] = [];
	for (const item of items) {
		const key = runtimeDedupeKey(item);
		if (key === '|||' || seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(item);
	}
	return out;
}

function runtimeDedupeKey(item: CribRuntimeWorkspace): string {
	return `${item.source ?? ''}|${item.containerName ?? ''}|${item.workspaceKey ?? ''}`;
}

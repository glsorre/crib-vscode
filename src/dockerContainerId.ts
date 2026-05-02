import { extractContainerName } from './containerName';

/**
 * Best-effort extraction of a Docker container ID from crib/docker CLI text output.
 * Takes the first hex ID (12–64 chars) on a line that references the container name.
 */
export function extractDockerContainerIdFromText(text: string, containerName: string): string | undefined {
	if (!text.trim() || !containerName.trim()) {
		return undefined;
	}
	const name = containerName.trim();
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (!lineReferencesContainerName(line, name)) {
			continue;
		}
		const m = line.match(/\b([a-f0-9]{12,64})\b/i);
		if (m?.[1]) {
			return normalizeDockerId(m[1]);
		}
	}
	return undefined;
}

function lineReferencesContainerName(line: string, containerName: string): boolean {
	const escaped = containerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (new RegExp(`(^|\\s|/)${escaped}(\\s|$)`, 'i').test(line)) {
		return true;
	}
	const looseLine = normalizeLoose(line);
	const looseName = normalizeLoose(containerName);
	return looseName.length >= 8 && looseLine.includes(looseName);
}

function normalizeDockerId(id: string): string {
	return id.toLowerCase();
}

/** Parses `docker ps` `--format '{{.ID}}\t{{.Names}}'` output (with `-a` optional). */
export function resolveDockerContainerIdFromDockerPs(output: string, containerName: string): string | undefined {
	const want = containerName.trim();
	if (!want) {
		return undefined;
	}
	const exact = matchDockerPsRows(output, want, 'exact');
	if (exact) {
		return exact;
	}
	return matchDockerPsRows(output, want, 'substring');
}

type DockerPsMatchMode = 'exact' | 'substring';

function matchDockerPsRows(output: string, containerName: string, mode: DockerPsMatchMode): string | undefined {
	const want = containerName.trim();
	for (const line of output.split(/\r?\n/)) {
		const tab = line.indexOf('\t');
		if (tab < 0) {
			continue;
		}
		const id = line.slice(0, tab).trim();
		const namesCell = line.slice(tab + 1).trim();
		if (!/^[a-f0-9]{12,64}$/i.test(id)) {
			continue;
		}
		const parts = namesCell.split(/\s+/).filter(Boolean);
		for (const p of parts) {
			if (dockerNameMatches(p, want, mode)) {
				return normalizeDockerId(id);
			}
		}
	}
	return undefined;
}

/**
 * `exact`: token equals container name (with optional leading `/`).
 * `substring`: used for Compose-style names (e.g. `proj_crib-x_1`); only when
 * `want` is long enough to reduce accidental collisions.
 */
export function dockerNameMatches(nameToken: string, want: string, mode: DockerPsMatchMode): boolean {
	const w = want.trim();
	if (!w) {
		return false;
	}
	const t = nameToken.startsWith('/') ? nameToken.slice(1) : nameToken;
	if (mode === 'exact') {
		return t === w || nameToken === w || normalizeLoose(t) === normalizeLoose(w);
	}
	if (w.length < 8) {
		return false;
	}
	const looseT = normalizeLoose(t);
	const looseW = normalizeLoose(w);
	return (
		t === w ||
		t.includes(w) ||
		nameToken.includes(w) ||
		(looseW.length >= 8 && (looseT.includes(looseW) || looseT === looseW))
	);
}

function normalizeLoose(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First hex id from `docker ps -q` / `docker ps -aq --filter` output (one id per line). */
export function firstDockerIdFromPsQOutput(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const id = line.trim();
		if (/^[a-f0-9]{12,64}$/i.test(id)) {
			return normalizeDockerId(id);
		}
	}
	return undefined;
}

/** Normalizes `docker inspect -f '{{.Id}}'` output (optional `sha256:` prefix). */
export function normalizeDockerInspectId(output: string): string | undefined {
	const t = output.trim();
	if (!t) {
		return undefined;
	}
	const hex = t.startsWith('sha256:') ? t.slice('sha256:'.length) : t;
	if (/^[a-f0-9]{12,64}$/i.test(hex)) {
		return normalizeDockerId(hex);
	}
	return undefined;
}

/**
 * Reads `containerId` / `container_id` / `dockerId` from crib JSON status when the
 * record matches `containerName` (or carries no conflicting name).
 */
export function extractDockerContainerIdFromStatusJson(parsed: unknown, containerName: string): string | undefined {
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const obj = parsed as Record<string, unknown>;
	const cn = extractContainerName(parsed);
	if (cn !== undefined && cn !== containerName) {
		return undefined;
	}
	for (const key of ['containerId', 'container_id', 'dockerId']) {
		const v = obj[key];
		if (typeof v === 'string') {
			const t = v.trim();
			if (/^[a-f0-9]{12,64}$/i.test(t)) {
				return normalizeDockerId(t);
			}
		}
	}
	return undefined;
}

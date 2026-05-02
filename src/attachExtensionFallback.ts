export type AttachExtensionFallbackRoute = 'direct' | 'uiBridge';

export type AttachExtensionFallbackSummary = {
	readonly ran: boolean;
	readonly requested: number;
	readonly alreadyInstalled: string[];
	readonly installed: string[];
	readonly failed: Array<{ readonly id: string; readonly reason: string }>;
};

export type AttachExtensionFallbackDeps = {
	readonly remoteName: string | undefined;
	readonly route: AttachExtensionFallbackRoute;
	readonly attachSucceeded: boolean;
	readonly nameConfig: unknown;
	readonly installedExtensionIds: readonly string[];
	readonly installExtension: (id: string) => Promise<void>;
	readonly log: (line: string) => void;
	readonly notifyFailure: (line: string) => void;
};

const REMOTE_SSH_NAME = 'ssh-remote';
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

export function shouldRunRemoteAttachExtensionFallback(remoteName: string | undefined): boolean {
	return remoteName === REMOTE_SSH_NAME;
}

export function shouldRunAttachExtensionFallbackForRoute(
	route: AttachExtensionFallbackRoute,
	attachSucceeded: boolean,
): boolean {
	if (!attachSucceeded) {
		return false;
	}
	return route === 'direct' || route === 'uiBridge';
}

export function normalizeExtensionIdsFromNameConfig(nameConfig: unknown): string[] {
	if (!nameConfig || typeof nameConfig !== 'object') {
		return [];
	}
	const raw = (nameConfig as { extensions?: unknown }).extensions;
	if (!Array.isArray(raw)) {
		return [];
	}
	const deduped = new Map<string, string>();
	for (const entry of raw) {
		if (typeof entry !== 'string') {
			continue;
		}
		const id = entry.trim();
		if (!EXTENSION_ID_RE.test(id)) {
			continue;
		}
		const key = id.toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, id);
		}
	}
	return Array.from(deduped.values());
}

export async function installAttachExtensionsFallback(
	deps: AttachExtensionFallbackDeps,
): Promise<AttachExtensionFallbackSummary> {
	const skippedSummary: AttachExtensionFallbackSummary = {
		ran: false,
		requested: 0,
		alreadyInstalled: [],
		installed: [],
		failed: [],
	};
	if (!shouldRunAttachExtensionFallbackForRoute(deps.route, deps.attachSucceeded)) {
		return skippedSummary;
	}
	if (!shouldRunRemoteAttachExtensionFallback(deps.remoteName)) {
		return skippedSummary;
	}
	const requested = normalizeExtensionIdsFromNameConfig(deps.nameConfig);
	if (requested.length === 0) {
		deps.log('[attach.extensions] fallback skipped: no valid extension ids in synced nameConfig');
		return { ...skippedSummary, ran: true, requested: 0 };
	}
	const installedSet = new Set(deps.installedExtensionIds.map(id => id.toLowerCase()));
	const alreadyInstalled: string[] = [];
	const installed: string[] = [];
	const failed: Array<{ id: string; reason: string }> = [];
	for (const id of requested) {
		if (installedSet.has(id.toLowerCase())) {
			alreadyInstalled.push(id);
			continue;
		}
		try {
			await deps.installExtension(id);
			installed.push(id);
			installedSet.add(id.toLowerCase());
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			failed.push({ id, reason });
		}
	}
	deps.log(
		`[attach.extensions] fallback route=${deps.route} requested=${requested.length} ` +
			`alreadyInstalled=${alreadyInstalled.length} installed=${installed.length} failed=${failed.length}`,
	);
	for (const entry of failed) {
		deps.log(`[attach.extensions] failed ${entry.id}: ${entry.reason}`);
	}
	if (failed.length > 0) {
		deps.notifyFailure(
			`Crib: attached, but failed to auto-install ${failed.length} extension(s). Check "Crib" output.`,
		);
	}
	return {
		ran: true,
		requested: requested.length,
		alreadyInstalled,
		installed,
		failed,
	};
}

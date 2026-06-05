import { describe, readUtf8File } from './util';
import * as https from 'https';
import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface FeatureCustomizations {
	extensions: string[];
	settings: Record<string, unknown>;
}

interface FeatureRefParts {
	registry: string;
	repository: string;
	tag: string;
	original: string;
}

const DEFAULT_REGISTRY = 'ghcr.io';
const DEFAULT_TAG = 'latest';
const FEATURE_MANIFEST_MEDIA_TYPE = 'application/vnd.devcontainers';
const OCI_MANIFEST_ACCEPTS = [
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

interface FeatureCacheEntry {
	digest: string;
	customizations: FeatureCustomizations;
}

/**
 * Resolve customizations.vscode.{extensions,settings} contributed by
 * devcontainer features.
 *
 * Two complementary sources, in priority order:
 *
 *   1. **Authoritative, post-build.** If we can identify the built image for
 *      this devcontainer, `docker inspect` returns the `devcontainer.metadata`
 *      label which already contains the merged customizations from every
 *      feature (the spec calls this "image metadata"). This is what the
 *      official Dev Containers CLI itself uses.
 *   2. **Best-effort, pre-build.** Otherwise we fetch each feature's
 *      `devcontainer-feature.json` over the OCI registry HTTPS API and read
 *      its `customizations.vscode.*`. Cached on disk so subsequent syncs
 *      are free.
 *
 * Failures are non-fatal: we log and return whatever we managed to gather.
 */
export class FeatureResolver {
	constructor(
		private readonly cacheRoot: vscode.Uri,
		private readonly logger: (msg: string) => void,
		private readonly allowNetwork: () => boolean,
	) {}

	async fromImageMetadata(image: string | undefined): Promise<FeatureCustomizations | undefined> {
		if (!image) {
			return undefined;
		}
		try {
			const label = await dockerLabel(image, 'devcontainer.metadata');
			if (!label) {
				return undefined;
			}
			const parsed: unknown = JSON.parse(label);
			if (!Array.isArray(parsed)) {
				return undefined;
			}
			const acc: FeatureCustomizations = { extensions: [], settings: {} };
			for (const entry of parsed) {
				mergeInto(acc, extractCustomizations(entry));
			}
			return acc;
		} catch (err) {
			this.logger(`feature image metadata read failed for ${image}: ${describe(err)}`);
			return undefined;
		}
	}

	async fromFeatureRefs(refs: ReadonlyArray<string>): Promise<FeatureCustomizations> {
		const acc: FeatureCustomizations = { extensions: [], settings: {} };
		for (const ref of refs) {
			try {
				const parts = parseFeatureRef(ref);
				if (!parts) {
					continue;
				}
				const cached = await this.readCache(parts);
				if (cached) {
					mergeInto(acc, cached);
					continue;
				}
				if (!this.allowNetwork()) {
					this.logger(`feature manifest fetch skipped (offline mode): ${ref}`);
					continue;
				}
				const fetched = await fetchFeatureCustomizations(parts);
				if (fetched) {
					await this.writeCache(parts, fetched);
					mergeInto(acc, fetched.customizations);
				}
			} catch (err) {
				this.logger(`feature manifest fetch failed for ${ref}: ${describe(err)}`);
			}
		}
		return acc;
	}

	private async readCache(parts: FeatureRefParts): Promise<FeatureCustomizations | undefined> {
		const file = this.cacheUri(parts);
		try {
			const raw = await readUtf8File(file);
			const parsed = JSON.parse(raw) as FeatureCacheEntry;
			if (parsed && parsed.customizations) {
				return parsed.customizations;
			}
		} catch {
			// Cache miss is the normal path; ignore.
		}
		return undefined;
	}

	private async writeCache(parts: FeatureRefParts, entry: FeatureCacheEntry): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.cacheRoot);
			const file = this.cacheUri(parts);
			const payload = Buffer.from(JSON.stringify(entry, null, 2), 'utf8');
			await vscode.workspace.fs.writeFile(file, payload);
		} catch (err) {
			this.logger(`feature cache write failed for ${parts.original}: ${describe(err)}`);
		}
	}

	private cacheUri(parts: FeatureRefParts): vscode.Uri {
		const safe = `${parts.registry}__${parts.repository}__${parts.tag}`.replace(/[^a-zA-Z0-9._-]/g, '_');
		return vscode.Uri.joinPath(this.cacheRoot, `${safe}.json`);
	}
}

function parseFeatureRef(ref: string): FeatureRefParts | undefined {
	if (typeof ref !== 'string' || ref.length === 0) {
		return undefined;
	}
	// Skip non-OCI refs (legacy single-word ids, GitHub tarball refs, etc.).
	// Those would need separate handling we're not implementing here.
	if (!ref.includes('/')) {
		return undefined;
	}
	if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('./') || ref.startsWith('/')) {
		return undefined;
	}
	const [refOnly, tag = DEFAULT_TAG] = ref.split(':', 2);
	const slashIdx = refOnly.indexOf('/');
	const first = refOnly.slice(0, slashIdx);
	const rest = refOnly.slice(slashIdx + 1);
	const registry = first.includes('.') || first === 'localhost' ? first : DEFAULT_REGISTRY;
	const repository = first.includes('.') || first === 'localhost' ? rest : refOnly;
	return { registry, repository, tag, original: ref };
}

async function fetchFeatureCustomizations(parts: FeatureRefParts): Promise<FeatureCacheEntry | undefined> {
	const manifest = await ociFetchManifest(parts);
	if (!manifest) {
		return undefined;
	}
	const featureLayer = manifest.layers?.find(l =>
		typeof l?.mediaType === 'string' && l.mediaType.startsWith(FEATURE_MANIFEST_MEDIA_TYPE),
	) ?? manifest.layers?.[0];
	if (!featureLayer?.digest) {
		return undefined;
	}
	const blob = await ociFetchBlob(parts, featureLayer.digest);
	if (!blob) {
		return undefined;
	}
	const featureJson = await extractFeatureJsonFromTar(blob);
	if (!featureJson) {
		return undefined;
	}
	const customizations = extractCustomizations(featureJson);
	return { digest: manifest.digest ?? featureLayer.digest, customizations };
}

interface OciManifest {
	layers?: Array<{ mediaType?: string; digest?: string }>;
	digest?: string;
}

async function ociFetchManifest(parts: FeatureRefParts): Promise<OciManifest | undefined> {
	const url = `https://${parts.registry}/v2/${parts.repository}/manifests/${parts.tag}`;
	const res = await ociHttpGet(url, parts, OCI_MANIFEST_ACCEPTS);
	if (!res) {
		return undefined;
	}
	return JSON.parse(res.toString('utf8')) as OciManifest;
}

async function ociFetchBlob(parts: FeatureRefParts, digest: string): Promise<Buffer | undefined> {
	const url = `https://${parts.registry}/v2/${parts.repository}/blobs/${digest}`;
	return ociHttpGet(url, parts, '*/*');
}

async function ociHttpGet(
	url: string,
	parts: FeatureRefParts,
	accept: string,
	bearer?: string,
): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { Accept: accept };
		if (bearer) {
			headers.Authorization = `Bearer ${bearer}`;
		}
		const req = https.get(url, { headers, timeout: 8000 }, async res => {
			const chunks: Buffer[] = [];
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', async () => {
				if (res.statusCode === 200) {
					resolve(Buffer.concat(chunks));
					return;
				}
				if (res.statusCode === 401 && !bearer) {
					const challenge = res.headers['www-authenticate'];
					const token = await fetchBearerToken(challenge, parts).catch(() => undefined);
					if (token) {
						resolve(await ociHttpGet(url, parts, accept, token));
						return;
					}
				}
				if (res.statusCode === 307 || res.statusCode === 302) {
					const loc = res.headers.location;
					if (loc) {
						resolve(await ociHttpGet(loc, parts, accept, bearer));
						return;
					}
				}
				resolve(undefined);
			});
		});
		req.on('timeout', () => req.destroy(new Error('OCI request timeout')));
		req.on('error', reject);
	});
}

async function fetchBearerToken(
	challenge: string | undefined,
	parts: FeatureRefParts,
): Promise<string | undefined> {
	if (!challenge || !challenge.toLowerCase().startsWith('bearer ')) {
		return undefined;
	}
	const params = new Map<string, string>();
	for (const piece of challenge.slice('bearer '.length).split(',')) {
		const [k, v] = piece.split('=', 2);
		if (k && v) {
			params.set(k.trim(), v.trim().replace(/^"|"$/g, ''));
		}
	}
	const realm = params.get('realm');
	const service = params.get('service');
	const scope = params.get('scope') ?? `repository:${parts.repository}:pull`;
	if (!realm) {
		return undefined;
	}
	const url = `${realm}?service=${encodeURIComponent(service ?? '')}&scope=${encodeURIComponent(scope)}`;
	const body = await new Promise<Buffer | undefined>((resolve, reject) => {
		https
			.get(url, { timeout: 8000 }, res => {
				if (res.statusCode !== 200) {
					resolve(undefined);
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', c => chunks.push(c));
				res.on('end', () => resolve(Buffer.concat(chunks)));
			})
			.on('error', reject);
	});
	if (!body) {
		return undefined;
	}
	const parsed = JSON.parse(body.toString('utf8')) as { token?: string; access_token?: string };
	return parsed.token ?? parsed.access_token;
}

/**
 * Devcontainer feature blobs are a tarball that contains, at minimum,
 * `devcontainer-feature.json` at the root. We avoid pulling in a full tar
 * library by parsing the (well-defined) USTAR header format directly: it's
 * 512-byte blocks with a 100-byte filename, a 12-byte octal size at offset
 * 124, and the body padded to 512 bytes.
 */
async function extractFeatureJsonFromTar(buf: Buffer): Promise<unknown | undefined> {
	const data = await maybeGunzip(buf);
	let offset = 0;
	while (offset + 512 <= data.length) {
		const header = data.subarray(offset, offset + 512);
		const name = readCString(header, 0, 100);
		if (!name) {
			return undefined;
		}
		const sizeStr = readCString(header, 124, 12).trim();
		const size = sizeStr ? parseInt(sizeStr, 8) : 0;
		const bodyStart = offset + 512;
		const bodyEnd = bodyStart + size;
		if (name === 'devcontainer-feature.json' || name.endsWith('/devcontainer-feature.json')) {
			const text = data.subarray(bodyStart, bodyEnd).toString('utf8');
			try {
				return JSON.parse(text);
			} catch {
				return undefined;
			}
		}
		offset = bodyEnd + ((512 - (size % 512)) % 512);
	}
	return undefined;
}

async function maybeGunzip(buf: Buffer): Promise<Buffer> {
	if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
		const zlib = await import('zlib');
		return new Promise((resolve, reject) => {
			zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)));
		});
	}
	return buf;
}

function readCString(buf: Buffer, start: number, len: number): string {
	const slice = buf.subarray(start, start + len);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function extractCustomizations(entry: unknown): FeatureCustomizations {
	const out: FeatureCustomizations = { extensions: [], settings: {} };
	if (!entry || typeof entry !== 'object') {
		return out;
	}
	const c = (entry as { customizations?: { vscode?: { extensions?: unknown; settings?: unknown } } })
		.customizations?.vscode;
	if (Array.isArray(c?.extensions)) {
		for (const e of c!.extensions as unknown[]) {
			if (typeof e === 'string') {
				out.extensions.push(e);
			}
		}
	}
	if (c?.settings && typeof c.settings === 'object') {
		out.settings = { ...(c.settings as Record<string, unknown>) };
	}
	return out;
}

function mergeInto(acc: FeatureCustomizations, add: FeatureCustomizations): void {
	for (const ext of add.extensions) {
		if (!acc.extensions.includes(ext)) {
			acc.extensions.push(ext);
		}
	}
	acc.settings = { ...acc.settings, ...add.settings };
}

async function dockerLabel(image: string, label: string): Promise<string | undefined> {
	const fmt = `{{ index .Config.Labels "${label}" }}`;
	const out = await runCapture('docker', ['inspect', '--format', fmt, image]);
	const trimmed = out.trim();
	if (!trimmed || trimmed === '<no value>') {
		return undefined;
	}
	return trimmed;
}

function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout?.on('data', chunk => (stdout += chunk.toString()));
		proc.stderr?.on('data', chunk => (stderr += chunk.toString()));
		proc.on('error', reject);
		proc.on('close', code => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
			}
		});
	});
}

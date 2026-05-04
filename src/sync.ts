import * as vscode from 'vscode';
import { CribCli } from './crib';
import {
	DevContainerJson,
	featureRefs,
	readDevContainer,
	workspaceRootFor,
} from './devcontainer';
import { FeatureCustomizations, FeatureResolver } from './features';
import { buildNameConfig, NameConfig, writeImageConfig, writeNameConfig } from './nameConfig';
import { DevContainerStorage, displayPath, imageConfigUri as makeImageConfigUri, nameConfigUri } from './paths';
import { resolveContainerName } from './containerName';

export interface SyncOptions {
	/** Force a re-fetch of feature metadata even if cached. */
	readonly refreshFeatures?: boolean;
	/** Override the container name (used by `crib up` once it knows the real name). */
	readonly containerName?: string;
	/** Where the call came from, for the marker in the written file. */
	readonly source?: SyncSource;
}

export type SyncSource =
	| 'bootstrap'
	| 'watcher.create'
	| 'watcher.change'
	| 'crib.up'
	| 'crib.restart'
	| 'crib.rebuild'
	| 'crib.attach'
	| 'crib.syncNow'
	| 'manual';

export interface SyncResult {
	readonly devcontainerUri: vscode.Uri;
	readonly containerName: string;
	readonly nameConfigUri: vscode.Uri;
	readonly written: boolean;
	readonly extensionsCount: number;
	/** Set when devcontainer.json declares an "image" field; undefined otherwise. */
	readonly imageConfigUri?: vscode.Uri;
	readonly imageConfigWritten?: boolean;
}

export class SyncError extends Error {
	constructor(public readonly devcontainerUri: vscode.Uri, message: string) {
		super(message);
		this.name = 'SyncError';
	}
}

/**
 * The single entry point every trigger funnels through. Idempotent: calling
 * it twice with no changes is a no-op (the writer skips the rename when the
 * payload — modulo timestamp — matches what's on disk).
 */
export class SyncEngine {
	private readonly _onDidSync = new vscode.EventEmitter<SyncResult>();
	readonly onDidSync = this._onDidSync.event;

	constructor(
		private readonly storage: DevContainerStorage,
		private readonly featureResolver: FeatureResolver,
		private readonly crib: CribCli | undefined,
		private readonly output: vscode.OutputChannel,
		private readonly settings: () => SyncSettings,
	) {}

	dispose(): void {
		this._onDidSync.dispose();
	}

	async sync(devcontainerUri: vscode.Uri, opts: SyncOptions = {}): Promise<SyncResult> {
		const parsed = await readDevContainer(devcontainerUri);
		const root = parsed.workspaceFolder?.uri ?? workspaceRootFor(devcontainerUri);
		const containerName =
			opts.containerName ??
			(await resolveContainerName(root, this.crib, msg => this.output.appendLine(msg)));

		const features = await this.collectFeatures(parsed.config, opts.refreshFeatures ?? false);
		const settings = this.settings();
		const nameConfig: NameConfig = buildNameConfig(
			parsed.config,
			settings.includeFeatureExtensions ? features : undefined,
			settings.extraExtensions,
		);
		const target = nameConfigUri(this.storage, containerName);
		const source = opts.source ?? displayPath(devcontainerUri);
		const { written } = await writeNameConfig(target, nameConfig, source);
		const extCount = nameConfig.extensions?.length ?? 0;

		// Also write an imageConfig if the devcontainer.json declares an "image" field.
		let imageConfigWritten = false;
		const imgConfigUri = parsed.config.image ? makeImageConfigUri(this.storage, parsed.config.image) : undefined;
		if (imgConfigUri) {
			const { written: imgWritten } = await writeImageConfig(imgConfigUri, nameConfig, source);
			imageConfigWritten = imgWritten;
			this.output.appendLine(
				`[sync] image ${parsed.config.image}: ${extCount} extension(s) ${imgWritten ? 'written' : 'unchanged'} ` +
					`-> ${displayPath(imgConfigUri)}`,
			);
		}

		const msg = imgConfigUri
			? `[sync] ${containerName}: ${extCount} ext(s) ${written ? 'written' : 'unchanged'} -> ${displayPath(target)}; ` +
				`image ${parsed.config.image}: ${imageConfigWritten ? 'written' : 'unchanged'} -> ${displayPath(imgConfigUri)}`
			: `[sync] ${containerName}: ${extCount} extension(s) ${written ? 'written' : 'unchanged'} ` +
					`-> ${displayPath(target)}`;
		this.output.appendLine(msg);
		const result: SyncResult = {
			devcontainerUri,
			containerName,
			nameConfigUri: target,
			written,
			extensionsCount: extCount,
			imageConfigUri: imgConfigUri,
			imageConfigWritten,
		};
		this._onDidSync.fire(result);
		return result;
	}

	private async collectFeatures(
		config: DevContainerJson,
		refresh: boolean,
	): Promise<FeatureCustomizations | undefined> {
		const refs = featureRefs(config);
		const fromImage = await this.featureResolver.fromImageMetadata(config.image);
		if (fromImage) {
			return fromImage;
		}
		if (refs.length === 0) {
			return undefined;
		}
		if (refresh) {
			// We don't currently have a per-cache invalidation hook; the OCI
			// fetcher always re-validates against the registry on cache miss,
			// so a refresh is more about not trusting a cached blob in the
			// first place. Today this is best-effort.
		}
		return await this.featureResolver.fromFeatureRefs(refs);
	}
}

export interface SyncSettings {
	includeFeatureExtensions: boolean;
	extraExtensions: ReadonlyArray<string>;
}

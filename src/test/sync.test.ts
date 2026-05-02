import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FeatureResolver } from '../features';
import { DevContainerStorage } from '../paths';
import { SyncEngine, SyncSettings } from '../sync';

suite('SyncEngine', () => {
	test('writes a nameConfig from devcontainer customizations', async () => {
		const root = vscode.Uri.file(path.join(os.tmpdir(), `crib-sync-${Date.now()}`));
		const devcontainerDir = vscode.Uri.joinPath(root, '.devcontainer');
		const devcontainerUri = vscode.Uri.joinPath(devcontainerDir, 'devcontainer.json');
		const storageRoot = vscode.Uri.joinPath(root, 'storage');
		await vscode.workspace.fs.createDirectory(devcontainerDir);
		await vscode.workspace.fs.writeFile(
			devcontainerUri,
			Buffer.from(JSON.stringify({
				customizations: {
					vscode: {
						extensions: ['ms-python.python'],
						settings: { 'editor.tabSize': 2 },
					},
				},
			}), 'utf8'),
		);

		const storage: DevContainerStorage = {
			extensionId: 'ms-vscode-remote.remote-containers',
			extensionFound: true,
			globalStorage: storageRoot,
			nameConfigs: vscode.Uri.joinPath(storageRoot, 'nameConfigs'),
			imageConfigs: vscode.Uri.joinPath(storageRoot, 'imageConfigs'),
		};
		const output = vscode.window.createOutputChannel('Crib Sync Test');
		const features = new FeatureResolver(
			vscode.Uri.joinPath(root, 'feature-cache'),
			() => {},
			() => false,
		);
		const settings = (): SyncSettings => ({
			extraExtensions: [],
			includeFeatureExtensions: true,
		});
		const engine = new SyncEngine(storage, features, undefined, output, settings);

		const result = await engine.sync(devcontainerUri, {
			containerName: 'demo-container',
			source: 'manual',
		});

		assert.strictEqual(result.containerName, 'demo-container');
		assert.strictEqual(result.extensionsCount, 1);
		const bytes = await vscode.workspace.fs.readFile(result.nameConfigUri);
		const written = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
		assert.deepStrictEqual(written.extensions, ['ms-python.python']);
		assert.deepStrictEqual(written.settings, { 'editor.tabSize': 2 });

		engine.dispose();
		output.dispose();
		await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
	});
});

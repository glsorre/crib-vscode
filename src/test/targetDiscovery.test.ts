import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	discoveredRuntimeTargetWithoutDevcontainer,
	formatDiscoverySummary,
	mergeUniqueTargets,
} from '../targetDiscovery';

suite('targetDiscovery dedupe', () => {
	test('mergeUniqueTargets ignores duplicate devcontainer URIs', () => {
		const dc = vscode.Uri.file('/proj/.devcontainer/devcontainer.json');
		const ws = vscode.Uri.file('/proj');
		const a = [{ devcontainerUri: dc, workspaceFolderUri: ws, containerName: 'c1', devcontainerOnDisk: true }];
		const b = [{ devcontainerUri: dc, workspaceFolderUri: ws, containerName: 'c2', devcontainerOnDisk: false }];
		const merged = mergeUniqueTargets(a, b);
		assert.strictEqual(merged.length, 1);
		assert.strictEqual(merged[0]?.containerName, 'c1');
	});

	test('formatDiscoverySummary reports counts for visibility logs', () => {
		assert.strictEqual(
			formatDiscoverySummary({
				workspaceCount: 2,
				runtimeReported: 3,
				runtimeUsable: 1,
				totalUnique: 3,
			}),
			'[discover] summary: workspace=2, runtimeReported=3, runtimeUsable=1, merged=3',
		);
	});
});

suite('targetDiscovery runtime-only shape', () => {
	test('discoveredRuntimeTargetWithoutDevcontainer uses nested path and devcontainerOnDisk false', () => {
		const folder = vscode.Uri.file('/abs/proj');
		const t = discoveredRuntimeTargetWithoutDevcontainer(folder, 'my-svc');
		assert.strictEqual(t.devcontainerOnDisk, false);
		assert.strictEqual(t.containerName, 'my-svc');
		assert.strictEqual(t.workspaceFolderUri.toString(), folder.toString());
		assert.strictEqual(
			t.devcontainerUri.toString(),
			vscode.Uri.joinPath(folder, '.devcontainer', 'devcontainer.json').toString(),
		);
	});
});

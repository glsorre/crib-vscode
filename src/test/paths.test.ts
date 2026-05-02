import * as assert from 'assert';
import * as vscode from 'vscode';
import { chooseDevContainerExtensionId, workspaceUriToSpawnCwd } from '../paths';

suite('Dev Containers storage path selection', () => {
	test('prefers Microsoft Dev Containers extension when installed', () => {
		const resolved = chooseDevContainerExtensionId(id =>
			id === 'ms-vscode-remote.remote-containers',
		);
		assert.deepStrictEqual(resolved, {
			extensionId: 'ms-vscode-remote.remote-containers',
			found: true,
		});
	});

	test('falls back to Anysphere Dev Containers extension when installed', () => {
		const resolved = chooseDevContainerExtensionId(id =>
			id === 'anysphere.remote-containers',
		);
		assert.deepStrictEqual(resolved, {
			extensionId: 'anysphere.remote-containers',
			found: true,
		});
	});

	test('uses conventional Microsoft id when no known extension is installed', () => {
		const resolved = chooseDevContainerExtensionId(() => false, 'Visual Studio Code');
		assert.strictEqual(resolved.extensionId, 'ms-vscode-remote.remote-containers');
		assert.strictEqual(resolved.found, false);
		assert.match(resolved.fallbackReason ?? '', /Visual Studio Code/);
	});

	test('uses Anysphere id as the fallback when running in Cursor', () => {
		const resolved = chooseDevContainerExtensionId(() => false, 'Cursor');
		assert.strictEqual(resolved.extensionId, 'anysphere.remote-containers');
		assert.strictEqual(resolved.found, false);
		assert.match(resolved.fallbackReason ?? '', /Cursor/);
	});
});

suite('workspaceUriToSpawnCwd', () => {
	test('returns fsPath for file URIs', () => {
		const u = vscode.Uri.file('/home/user/project');
		assert.strictEqual(workspaceUriToSpawnCwd(u), u.fsPath);
	});

	test('returns a host path for vscode-remote workspace URIs', () => {
		const u = vscode.Uri.parse('vscode-remote://ssh-remote+myhost/home/user/project');
		const cwd = workspaceUriToSpawnCwd(u);
		assert.ok(cwd && cwd.replace(/\\/g, '/').endsWith('/home/user/project'));
	});

	test('returns undefined for unsupported schemes', () => {
		assert.strictEqual(workspaceUriToSpawnCwd(vscode.Uri.parse('https://example.com/foo')), undefined);
	});
});

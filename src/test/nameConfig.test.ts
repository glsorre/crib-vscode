import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildNameConfig, writeNameConfig } from '../nameConfig';
import { DevContainerJson } from '../devcontainer';

function devcontainer(extra: Partial<DevContainerJson> = {}): DevContainerJson {
	return {
		raw: {},
		...extra,
	};
}

suite('buildNameConfig', () => {
	test('lifts customizations.vscode.extensions to root extensions', () => {
		const cfg = devcontainer({
			customizations: {
				vscode: { extensions: ['ms-python.python', 'dbaeumer.vscode-eslint'] },
			},
		});
		const out = buildNameConfig(cfg, undefined, []);
		assert.deepStrictEqual(out.extensions, ['ms-python.python', 'dbaeumer.vscode-eslint']);
	});

	test('merges feature-contributed extensions and dedupes case-insensitively', () => {
		const cfg = devcontainer({
			customizations: { vscode: { extensions: ['ms-python.python'] } },
		});
		const out = buildNameConfig(
			cfg,
			{ extensions: ['MS-Python.Python', 'redhat.vscode-yaml'], settings: {} },
			['extra.one'],
		);
		assert.deepStrictEqual(out.extensions, [
			'ms-python.python',
			'redhat.vscode-yaml',
			'extra.one',
		]);
	});

	test('passes through workspaceFolder, remoteUser, remoteEnv, forwardPorts, postAttachCommand', () => {
		const cfg = devcontainer({
			workspaceFolder: '/code',
			remoteUser: 'vscode',
			remoteEnv: { FOO: 'bar' },
			forwardPorts: [3000, '8080:80'],
			postAttachCommand: 'echo attached',
		});
		const out = buildNameConfig(cfg, undefined, []);
		assert.strictEqual(out.workspaceFolder, '/code');
		assert.strictEqual(out.remoteUser, 'vscode');
		assert.deepStrictEqual(out.remoteEnv, { FOO: 'bar' });
		assert.deepStrictEqual(out.forwardPorts, [3000, '8080:80']);
		assert.strictEqual(out.postAttachCommand, 'echo attached');
	});

	test('user devcontainer settings override feature-provided settings', () => {
		const cfg = devcontainer({
			customizations: {
				vscode: { settings: { 'editor.tabSize': 2 } },
			},
		});
		const out = buildNameConfig(
			cfg,
			{ extensions: [], settings: { 'editor.tabSize': 4, 'editor.formatOnSave': true } },
			[],
		);
		assert.deepStrictEqual(out.settings, {
			'editor.tabSize': 2,
			'editor.formatOnSave': true,
		});
	});

	test('omits empty extensions / settings', () => {
		const out = buildNameConfig(devcontainer(), undefined, []);
		assert.strictEqual(out.extensions, undefined);
		assert.strictEqual(out.settings, undefined);
	});

	test('writeNameConfig preserves unmanaged keys and avoids timestamp-only churn', async () => {
		const dir = vscode.Uri.file(path.join(os.tmpdir(), `crib-name-config-${Date.now()}`));
		const target = vscode.Uri.joinPath(dir, 'nameConfigs', 'demo.json');
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'nameConfigs'));
		await vscode.workspace.fs.writeFile(
			target,
			Buffer.from(JSON.stringify({ custom: true }, null, 2), 'utf8'),
		);

		const first = await writeNameConfig(target, { extensions: ['a.b'] }, 'test');
		assert.strictEqual(first.written, true);
		assert.strictEqual(first.merged.custom, true);
		assert.deepStrictEqual(first.merged.extensions, ['a.b']);

		const second = await writeNameConfig(target, { extensions: ['a.b'] }, 'test');
		assert.strictEqual(second.written, false);
		assert.strictEqual(second.merged.custom, true);

		await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
	});
});

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Extension Test Suite', () => {
	test('workspace extension contributes statusBar/remoteIndicator menu with per-remoteName groups', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			contributes?: {
				menus?: {
					'statusBar/remoteIndicator'?: Array<{
						command?: string;
						group?: string;
						when?: string;
					}>;
				};
			};
		};
		const groupRemote =
			/^remote_[0-9]{2}_(ssh-remote|wsl|dev-container|attached-container)_/;
		const indicator = pkg.contributes?.menus?.['statusBar/remoteIndicator'];
		assert.ok(Array.isArray(indicator) && indicator.length > 0, 'remoteIndicator menu should list Crib');
		for (const entry of indicator ?? []) {
			assert.ok(entry.command, 'each entry should reference a command');
			assert.ok(
				groupRemote.test(entry.group ?? ''),
				`group should follow remote_##_<remoteName>_* pattern, got ${entry.group}`,
			);
			assert.ok(
				entry.when?.includes('workspaceFolderCount'),
				`when should use workspaceFolderCount (workspace host), got ${entry.when}`,
			);
			assert.ok(
				entry.when?.includes('remoteName'),
				`when should scope by remoteName, got ${entry.when}`,
			);
			assert.ok(
				entry.when?.includes('crib.runsOnWorkspaceHost'),
				`when should require workspace extension host, got ${entry.when}`,
			);
		}
	});

	test('operational crib commands are enablement-gated to the workspace extension host', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			contributes?: {
				commands?: Array<{ command?: string; enablement?: string }>;
			};
		};
		const cmds = pkg.contributes?.commands ?? [];
		for (const c of cmds) {
			if (c.command === 'crib.focusOutput') {
				assert.strictEqual(
					c.enablement,
					undefined,
					'focusOutput should stay available on the UI host',
				);
			} else if (c.command?.startsWith('crib.')) {
				assert.strictEqual(
					c.enablement,
					'crib.runsOnWorkspaceHost',
					`${c.command} should be gated to workspace host`,
				);
			}
		}
	});

	test('declares crib commands in the manifest', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			contributes?: { commands?: Array<{ command?: string }> };
		};
		const commands = new Set(
			pkg.contributes?.commands?.map(c => c.command).filter(Boolean),
		);
		for (const command of [
			'crib.up',
			'crib.down',
			'crib.restart',
			'crib.rebuild',
			'crib.remove',
			'crib.attach',
			'crib.syncNow',
			'crib.openConfig',
			'crib.refresh',
			'crib.focusOutput',
		]) {
			assert.ok(commands.has(command), `${command} should be declared`);
		}
	});

	test('keeps workspace extension host-only (no UI fallback)', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			extensionKind?: string[];
		};
		assert.deepStrictEqual(pkg.extensionKind, ['workspace']);
	});

	test('activates when opening Crib Workspaces or invoking any contributed crib command', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			activationEvents?: string[];
			contributes?: { commands?: Array<{ command?: string }> };
		};
		const events = new Set(pkg.activationEvents ?? []);
		assert.ok(events.has('onStartupFinished'), 'should activate after workbench startup on remote/local workspace');
		assert.ok(events.has('onView:cribWorkspaces'), 'should activate when the Workspaces tree is shown');
		for (const cmd of pkg.contributes?.commands?.map(c => c.command).filter(Boolean) ?? []) {
			assert.ok(
				events.has(`onCommand:${cmd}`),
				`activationEvents should include onCommand:${cmd} so the handler exists when the command runs`,
			);
		}
	});

	test('defines UI bridge as a separate UI-only extension with no public commands', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'ui-bridge', 'package.json'), 'utf8'),
		) as {
			extensionKind?: string[];
			activationEvents?: string[];
			contributes?: { commands?: Array<{ command?: string }> };
		};
		assert.deepStrictEqual(pkg.extensionKind, ['ui']);
		assert.ok(
			pkg.activationEvents?.includes('onStartupFinished'),
			'bridge should start with the workbench so Output shows Crib (UI bridge) hints on Remote-SSH',
		);
		assert.ok(pkg.activationEvents?.includes('onCommand:crib.attachViaUiHost'));
		assert.strictEqual(pkg.contributes?.commands, undefined);
	});

	test('view menus require crib.runsOnWorkspaceHost', () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
		) as {
			contributes?: {
				menus?: {
					'view/title'?: Array<{ when?: string }>;
					'view/item/context'?: Array<{ when?: string }>;
				};
			};
		};
		const menus = pkg.contributes?.menus;
		for (const entry of menus?.['view/title'] ?? []) {
			assert.ok(
				entry.when?.includes('crib.runsOnWorkspaceHost'),
				`view/title when should gate workspace host: ${entry.when}`,
			);
		}
		for (const entry of menus?.['view/item/context'] ?? []) {
			assert.ok(
				entry.when?.includes('crib.runsOnWorkspaceHost'),
				`view/item/context when should gate workspace host: ${entry.when}`,
			);
		}
	});
});

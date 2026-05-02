import * as assert from 'assert';
import {
	installAttachExtensionsFallback,
	normalizeExtensionIdsFromNameConfig,
	shouldRunAttachExtensionFallbackForRoute,
	shouldRunRemoteAttachExtensionFallback,
} from '../attachExtensionFallback';

suite('attach extension fallback', () => {
	test('runs only for Remote-SSH sessions', () => {
		assert.strictEqual(shouldRunRemoteAttachExtensionFallback('ssh-remote'), true);
		assert.strictEqual(shouldRunRemoteAttachExtensionFallback('attached-container'), false);
		assert.strictEqual(shouldRunRemoteAttachExtensionFallback(undefined), false);
	});

	test('runs only after successful direct/uiBridge attach routes', () => {
		assert.strictEqual(shouldRunAttachExtensionFallbackForRoute('direct', true), true);
		assert.strictEqual(shouldRunAttachExtensionFallbackForRoute('uiBridge', true), true);
		assert.strictEqual(shouldRunAttachExtensionFallbackForRoute('direct', false), false);
		assert.strictEqual(shouldRunAttachExtensionFallbackForRoute('uiBridge', false), false);
	});

	test('normalizes, validates, and dedupes extension ids', () => {
		assert.deepStrictEqual(
			normalizeExtensionIdsFromNameConfig({
				extensions: [
					' rust-lang.rust-analyzer ',
					'Rust-Lang.Rust-Analyzer',
					'bad id',
					'',
					42,
					'ms-vscode.cpptools',
				],
			}),
			['rust-lang.rust-analyzer', 'ms-vscode.cpptools'],
		);
	});

	test('best effort install continues on partial failures', async () => {
		const attempts: string[] = [];
		const notifications: string[] = [];
		const logs: string[] = [];
		const result = await installAttachExtensionsFallback({
			remoteName: 'ssh-remote',
			route: 'direct',
			attachSucceeded: true,
			nameConfig: { extensions: ['a.one', 'b.two', 'c.three'] },
			installedExtensionIds: ['a.one'],
			installExtension: async id => {
				attempts.push(id);
				if (id === 'b.two') {
					throw new Error('simulated failure');
				}
			},
			log: line => logs.push(line),
			notifyFailure: line => notifications.push(line),
		});
		assert.strictEqual(result.ran, true);
		assert.strictEqual(result.requested, 3);
		assert.deepStrictEqual(result.alreadyInstalled, ['a.one']);
		assert.deepStrictEqual(result.installed, ['c.three']);
		assert.strictEqual(result.failed.length, 1);
		assert.strictEqual(result.failed[0].id, 'b.two');
		assert.deepStrictEqual(attempts, ['b.two', 'c.three']);
		assert.strictEqual(notifications.length, 1);
		assert.ok(logs.some(line => line.includes('failed=1')));
	});

	test('integration style: remote direct attach installs missing and skips duplicates', async () => {
		const notifications: string[] = [];
		const logs: string[] = [];
		const installedIds: string[] = ['rust-lang.rust-analyzer'];
		const installCalls: string[] = [];
		const nameConfig = {
			extensions: [
				' rust-lang.rust-analyzer ',
				'ms-vscode.cpptools',
				'MS-VSCODE.CPPTOOLS',
				'bad id',
				'serayuzgur.crates',
			],
		};
		const summary = await installAttachExtensionsFallback({
			remoteName: 'ssh-remote',
			route: 'direct',
			attachSucceeded: true,
			nameConfig,
			installedExtensionIds: installedIds,
			installExtension: async id => {
				installCalls.push(id);
				installedIds.push(id);
			},
			log: line => logs.push(line),
			notifyFailure: line => notifications.push(line),
		});

		assert.strictEqual(summary.ran, true);
		assert.strictEqual(summary.requested, 3);
		assert.deepStrictEqual(summary.alreadyInstalled, ['rust-lang.rust-analyzer']);
		assert.deepStrictEqual(summary.installed, ['ms-vscode.cpptools', 'serayuzgur.crates']);
		assert.deepStrictEqual(summary.failed, []);
		assert.deepStrictEqual(installCalls, ['ms-vscode.cpptools', 'serayuzgur.crates']);
		assert.strictEqual(notifications.length, 0);
		assert.ok(logs.some(line => line.includes('requested=3')));
		assert.ok(logs.some(line => line.includes('installed=2')));
	});
});

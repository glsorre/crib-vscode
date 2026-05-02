import * as assert from 'assert';
import {
	hasContainerName,
	resolveAttachTarget,
	resolveDirectAttachCommand,
	resolveUiAttachCommand,
	UI_ATTACH_BRIDGE_COMMAND,
} from '../attach';

suite('attach resolution', () => {
	test('resolves the canonical direct attach command', () => {
		const commands = [
			'some.other',
			'remote-containers.attachToRunningContainer',
		];
		assert.strictEqual(
			resolveDirectAttachCommand(commands),
			'remote-containers.attachToRunningContainer',
		);
	});

	test('resolves the Anysphere direct attach command', () => {
		assert.strictEqual(
			resolveDirectAttachCommand(['anysphere.remote-containers.attachToRunningContainer']),
			'anysphere.remote-containers.attachToRunningContainer',
		);
	});

	test('returns undefined when no direct attach command exists', () => {
		const commands = ['unrelated.cmd'];
		assert.strictEqual(resolveDirectAttachCommand(commands), undefined);
	});

	test('resolves the UI bridge when direct attach is missing', () => {
		assert.deepStrictEqual(resolveAttachTarget([UI_ATTACH_BRIDGE_COMMAND]), {
			kind: 'uiBridge',
			command: UI_ATTACH_BRIDGE_COMMAND,
			registered: true,
		});
	});

	test('direct attach wins over the UI bridge', () => {
		assert.deepStrictEqual(
			resolveAttachTarget([
				UI_ATTACH_BRIDGE_COMMAND,
				'remote-containers.attachToRunningContainer',
			]),
			{ kind: 'direct', command: 'remote-containers.attachToRunningContainer' },
		);
	});

	test('can optimistically target the UI bridge for command activation', () => {
		assert.deepStrictEqual(
			resolveAttachTarget([], { allowUiBridgeFallback: true }),
			{
				kind: 'uiBridge',
				command: UI_ATTACH_BRIDGE_COMMAND,
				registered: false,
			},
		);
	});

	test('reports unavailable when no direct attach or bridge exists', () => {
		const target = resolveAttachTarget(['unrelated.cmd']);
		assert.strictEqual(target.kind, 'unavailable');
		if (target.kind === 'unavailable') {
			assert.match(target.reason, /No Dev Containers attach command/);
		}
	});

	test('resolves UI attach direct command before picker fallback', () => {
		assert.deepStrictEqual(
			resolveUiAttachCommand([
				'remote-containers.attachToRunningContainerFromViewlet',
				'anysphere.remote-containers.attachToRunningContainer',
			]),
			{
				kind: 'direct',
				command: 'anysphere.remote-containers.attachToRunningContainer',
			},
		);
	});

	test('resolves UI attach picker when no direct command exists', () => {
		assert.deepStrictEqual(
			resolveUiAttachCommand(['remote-containers.attachToRunningContainerFromViewlet']),
			{
				kind: 'picker',
				command: 'remote-containers.attachToRunningContainerFromViewlet',
			},
		);
	});

	test('accepts only non-empty container names for attach', () => {
		assert.strictEqual(hasContainerName('crib-workspace'), true);
		assert.strictEqual(hasContainerName('  crib-workspace  '), true);
		assert.strictEqual(hasContainerName(''), false);
		assert.strictEqual(hasContainerName('   '), false);
		assert.strictEqual(hasContainerName(undefined), false);
	});
});

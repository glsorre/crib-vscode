import * as assert from 'assert';
import { devContainersAttachArgument } from '../attachPayload';

suite('attachPayload', () => {
	test('anysphere uses object with containerId when id is present', () => {
		assert.deepStrictEqual(
			devContainersAttachArgument('anysphere.remote-containers.attachToRunningContainer', 'crib-x', 'abc123'),
			{ containerId: 'abc123' },
		);
	});

	test('anysphere falls back to name string when id is missing', () => {
		assert.strictEqual(
			devContainersAttachArgument('anysphere.remote-containers.attachToRunningContainer', 'crib-x', undefined),
			'crib-x',
		);
	});

	test('Microsoft-style command uses object with containerId when id is present', () => {
		assert.deepStrictEqual(
			devContainersAttachArgument('remote-containers.attachToRunningContainer', 'crib-x', 'abc123def456'),
			{ containerId: 'abc123def456' },
		);
	});

	test('unknown attach commands still prefer containerId object when present', () => {
		assert.deepStrictEqual(
			devContainersAttachArgument('custom.attachCommand', 'crib-x', 'abc123def456'),
			{ containerId: 'abc123def456' },
		);
	});

	test('all commands fall back to container name when id is missing', () => {
		assert.strictEqual(
			devContainersAttachArgument('remote-containers.attachToRunningContainer', 'crib-x', undefined),
			'crib-x',
		);
	});
});

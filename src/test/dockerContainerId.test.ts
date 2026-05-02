import * as assert from 'assert';
import {
	dockerNameMatches,
	extractDockerContainerIdFromStatusJson,
	extractDockerContainerIdFromText,
	firstDockerIdFromPsQOutput,
	normalizeDockerInspectId,
	resolveDockerContainerIdFromDockerPs,
} from '../dockerContainerId';

suite('dockerContainerId', () => {
	test('extractDockerContainerIdFromText finds id on crib status line', () => {
		const text = [
			'==> yal4-8a78bea',
			'source      /home/me/repo/yal4',
			'container   crib-yal4-8a78bea',
			'27c8863db831 crib-yal4-8a78bea',
			'status      running',
		].join('\n');
		assert.strictEqual(
			extractDockerContainerIdFromText(text, 'crib-yal4-8a78bea'),
			'27c8863db831',
		);
	});

	test('extractDockerContainerIdFromText ignores unrelated ids', () => {
		const text = 'deadbeef1234 other-container-name';
		assert.strictEqual(extractDockerContainerIdFromText(text, 'crib-yal4-8a78bea'), undefined);
	});

	test('extractDockerContainerIdFromStatusJson reads containerId field', () => {
		assert.strictEqual(
			extractDockerContainerIdFromStatusJson(
				{ containerName: 'crib-x', containerId: 'AbCdEf123456' },
				'crib-x',
			),
			'abcdef123456',
		);
	});

	test('extractDockerContainerIdFromStatusJson rejects conflicting container name', () => {
		assert.strictEqual(
			extractDockerContainerIdFromStatusJson(
				{ containerName: 'other', containerId: 'aaaaaaaaaaaa' },
				'crib-x',
			),
			undefined,
		);
	});

	test('resolveDockerContainerIdFromDockerPs matches slash-prefixed Docker name', () => {
		const ps = '27c8863db831\t/crib-yal4-8a78bea\n';
		assert.strictEqual(resolveDockerContainerIdFromDockerPs(ps, 'crib-yal4-8a78bea'), '27c8863db831');
	});

	test('resolveDockerContainerIdFromDockerPs matches composed NAMES column', () => {
		const ps = 'aaaaaaaaaaaa\tfoo crib-bar\n';
		assert.strictEqual(resolveDockerContainerIdFromDockerPs(ps, 'crib-bar'), 'aaaaaaaaaaaa');
	});

	test('resolveDockerContainerIdFromDockerPs matches compose-style name via substring', () => {
		const ps = 'bbbbbbbbbbbb\tproject_crib-yal4-8a78bea_1\n';
		assert.strictEqual(
			resolveDockerContainerIdFromDockerPs(ps, 'crib-yal4-8a78bea'),
			'bbbbbbbbbbbb',
		);
	});

	test('resolveDockerContainerIdFromDockerPs matches delimiter-variant names', () => {
		const ps = 'cccccccccccc\tproject_crib_yal4_8a78bea_1\n';
		assert.strictEqual(
			resolveDockerContainerIdFromDockerPs(ps, 'crib-yal4-8a78bea'),
			'cccccccccccc',
		);
	});

	test('dockerNameMatches substring requires minimum name length', () => {
		assert.strictEqual(dockerNameMatches('prefix_short_suffix', 'short', 'substring'), false);
	});

	test('dockerNameMatches exact mode accepts normalized delimiter variants', () => {
		assert.strictEqual(
			dockerNameMatches('/crib_yal4_8a78bea', 'crib-yal4-8a78bea', 'exact'),
			true,
		);
	});

	test('firstDockerIdFromPsQOutput reads docker ps -q lines', () => {
		assert.strictEqual(firstDockerIdFromPsQOutput('cccccccccccc\n'), 'cccccccccccc');
		assert.strictEqual(firstDockerIdFromPsQOutput('no\n'), undefined);
	});

	test('normalizeDockerInspectId strips sha256 prefix', () => {
		assert.strictEqual(
			normalizeDockerInspectId('sha256:dddddddddddd'),
			'dddddddddddd',
		);
		assert.strictEqual(
			normalizeDockerInspectId('eeeeeeeeeeee'),
			'eeeeeeeeeeee',
		);
	});
});

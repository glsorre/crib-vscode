import * as assert from 'assert';
import * as vscode from 'vscode';
import { deriveContainerName, extractContainerName, extractSourcePath, isSafeContainerName } from '../containerName';

suite('containerName', () => {
	test('lowercases and sanitises path basename', () => {
		assert.strictEqual(
			deriveContainerName(vscode.Uri.file('/Users/me/Some Project Name')),
			'some-project-name',
		);
	});

	test('keeps allowed characters', () => {
		assert.strictEqual(
			deriveContainerName(vscode.Uri.file('/tmp/my-app_v2.0')),
			'my-app_v2.0',
		);
	});

	test('falls back to "workspace" for empty/exotic basenames', () => {
		assert.strictEqual(deriveContainerName(vscode.Uri.file('/')), 'workspace');
		assert.strictEqual(deriveContainerName(vscode.Uri.file('/!!!')), 'workspace');
	});

	test('extractContainerName picks well-known shapes', () => {
		assert.strictEqual(extractContainerName({ containerName: 'foo' }), 'foo');
		assert.strictEqual(extractContainerName({ name: 'bar' }), 'bar');
		assert.strictEqual(extractContainerName({ workspace: { name: 'baz' } }), 'baz');
		assert.strictEqual(extractContainerName({}), undefined);
		assert.strictEqual(extractContainerName(null), undefined);
	});

	test('extractContainerName parses crib 0.9 plain status output', () => {
		const status = [
			'crib 0.9.0',
			'==> yal4-8a78bea',
			'source      /home/glsorre/repo/yal4',
			'container   crib-yal4-8a78bea',
			'status      running',
		].join('\n');
		assert.strictEqual(extractContainerName(status), 'crib-yal4-8a78bea');
	});

	test('extractContainerName parses raw text from CribStatus fallback', () => {
		const status = {
			state: 'up',
			raw: 'container   crib-yal4-8a78bea\nstatus      running\n',
		};
		assert.strictEqual(extractContainerName(status), 'crib-yal4-8a78bea');
	});

	test('extractSourcePath reads source line from crib 0.9 text', () => {
		const text = [
			'source      /home/glsorre/repo/yal4',
			'container   crib-yal4-8a78bea',
		].join('\n');
		assert.strictEqual(extractSourcePath(text), '/home/glsorre/repo/yal4');
	});

	test('extractSourcePath reads structured fields', () => {
		assert.strictEqual(extractSourcePath({ source: '/data/proj' }), '/data/proj');
		assert.strictEqual(
			extractSourcePath({ workspace: { path: '/srv/w' } }),
			'/srv/w',
		);
	});

	test('extractSourcePath reads nested raw string', () => {
		assert.strictEqual(
			extractSourcePath({ raw: 'source      /tmp/a\n' }),
			'/tmp/a',
		);
	});

	test('isSafeContainerName accepts allowed characters and rejects path traversal', () => {
		assert.strictEqual(isSafeContainerName('crib-yal4-8a78bea'), true);
		assert.strictEqual(isSafeContainerName('My_Project.v2'), true);
		assert.strictEqual(isSafeContainerName('../../etc/passwd'), false);
		assert.strictEqual(isSafeContainerName('foo/bar'), false);
		assert.strictEqual(isSafeContainerName('foo bar'), false);
		assert.strictEqual(isSafeContainerName(''), false);
		assert.strictEqual(isSafeContainerName(undefined), false);
	});

	test('extractContainerName rejects unsafe values from status payload', () => {
		assert.strictEqual(extractContainerName({ containerName: '../escape' }), undefined);
		assert.strictEqual(extractContainerName({ workspace: { name: 'foo/bar' } }), undefined);
		assert.strictEqual(
			extractContainerName('container   ../escape\n'),
			undefined,
		);
	});
});

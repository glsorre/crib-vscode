import * as assert from 'assert';
import { parseCribDiscoverText } from '../crib';

suite('crib runtime discovery text', () => {
	test('parses crib ls WORKSPACE SOURCE table', () => {
		const text = [
			'WORKSPACE     SOURCE',
			'yal4-8a78bea  /home/glsorre/repo/yal4',
		].join('\n');
		const w = parseCribDiscoverText(text);
		assert.strictEqual(w.length, 1);
		assert.strictEqual(w[0]?.workspaceKey, 'yal4-8a78bea');
		assert.strictEqual(w[0]?.source, '/home/glsorre/repo/yal4');
	});

	test('parses crib ls table with single space between columns (non-TTY piped output)', () => {
		const text = [
			'WORKSPACE SOURCE',
			'yal4-8a78bea /home/glsorre/repo/yal4',
		].join('\n');
		const w = parseCribDiscoverText(text);
		assert.strictEqual(w.length, 1);
		assert.strictEqual(w[0]?.workspaceKey, 'yal4-8a78bea');
		assert.strictEqual(w[0]?.source, '/home/glsorre/repo/yal4');
	});

	test('parses padded column table as printed by crib when stdout is not a TTY', () => {
		const text = [
			'WORKSPACE    SOURCE',
			'yal4-8a78bea /home/glsorre/repo/yal4',
		].join('\n');
		const w = parseCribDiscoverText(text);
		assert.strictEqual(w.length, 1);
		assert.strictEqual(w[0]?.source, '/home/glsorre/repo/yal4');
	});

	test('parses crib status blocks with ==>', () => {
		const text = [
			'crib 0.9.0',
			'',
			'==> yal4-8a78bea',
			'source      /home/glsorre/repo/yal4',
			'container   crib-yal4-8a78bea',
			'status      running',
		].join('\n');
		const w = parseCribDiscoverText(text);
		assert.strictEqual(w.length, 1);
		assert.strictEqual(w[0]?.workspaceKey, 'yal4-8a78bea');
		assert.strictEqual(w[0]?.source, '/home/glsorre/repo/yal4');
		assert.strictEqual(w[0]?.containerName, 'crib-yal4-8a78bea');
	});

	test('returns empty for unrecognized output', () => {
		assert.deepStrictEqual(parseCribDiscoverText('nothing here'), []);
	});
});

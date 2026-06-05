import * as assert from 'assert';
import { FeatureCustomizations } from '../features';

/**
 * Unit tests for FeatureResolver pure helpers.
 *
 * `fromImageMetadata` calls `docker inspect` — requires a real Docker binary
 * and a running image with the `devcontainer.metadata` label. It is covered
 * by manual integration testing.
 *
 * The pure functions below are the logic core that can be tested in isolation.
 */

function extractCustomizations(entry: unknown): FeatureCustomizations {
	const out: FeatureCustomizations = { extensions: [], settings: {} };
	if (!entry || typeof entry !== 'object') {
		return out;
	}
	const c = (entry as { customizations?: { vscode?: { extensions?: unknown; settings?: unknown } } })
		.customizations?.vscode;
	if (Array.isArray(c?.extensions)) {
		for (const e of c!.extensions as unknown[]) {
			if (typeof e === 'string') {
				out.extensions.push(e);
			}
		}
	}
	if (c?.settings && typeof c.settings === 'object') {
		out.settings = { ...(c.settings as Record<string, unknown>) };
	}
	return out;
}

function mergeInto(acc: FeatureCustomizations, add: FeatureCustomizations): void {
	for (const ext of add.extensions) {
		if (!acc.extensions.includes(ext)) {
			acc.extensions.push(ext);
		}
	}
	acc.settings = { ...acc.settings, ...add.settings };
}

function parseImageMetadataLabel(label: string | undefined): FeatureCustomizations | undefined {
	if (!label) return undefined;
	const parsed: unknown = JSON.parse(label);
	if (!Array.isArray(parsed)) return undefined;
	const acc: FeatureCustomizations = { extensions: [], settings: {} };
	for (const entry of parsed) {
		mergeInto(acc, extractCustomizations(entry));
	}
	return acc;
}

suite('FeatureResolver: extractCustomizations', () => {
	test('returns empty for null / undefined', () => {
		const a = extractCustomizations(null);
		const b = extractCustomizations(undefined);
		assert.deepStrictEqual(a, { extensions: [], settings: {} });
		assert.deepStrictEqual(b, { extensions: [], settings: {} });
	});

	test('returns empty for plain non-object', () => {
		const a = extractCustomizations('string');
		const b = extractCustomizations(42);
		assert.deepStrictEqual(a, { extensions: [], settings: {} });
		assert.deepStrictEqual(b, { extensions: [], settings: {} });
	});

	test('returns empty for empty object with no customizations', () => {
		const a = extractCustomizations({});
		const b = extractCustomizations({ customizations: {} });
		const c = extractCustomizations({ customizations: { vscode: {} } });
		assert.deepStrictEqual(a, { extensions: [], settings: {} });
		assert.deepStrictEqual(b, { extensions: [], settings: {} });
		assert.deepStrictEqual(c, { extensions: [], settings: {} });
	});

	test('returns empty for non-array extensions', () => {
		const a = extractCustomizations({
			customizations: { vscode: { extensions: 'not-an-array' } },
		});
		const b = extractCustomizations({
			customizations: { vscode: { extensions: { id: 'a.b' } } },
		});
		assert.deepStrictEqual(a, { extensions: [], settings: {} });
		assert.deepStrictEqual(b, { extensions: [], settings: {} });
	});

	test('extracts extensions from customizations.vscode.extensions', () => {
		const a = extractCustomizations({
			customizations: {
				vscode: { extensions: ['ms-python.python', 'dbaeumer.vscode-eslint'] },
			},
		});
		assert.deepStrictEqual(a.extensions, ['ms-python.python', 'dbaeumer.vscode-eslint']);
	});

	test('skips non-string entries in extensions array', () => {
		const a = extractCustomizations({
			customizations: {
				vscode: {
					extensions: ['valid.ext', 42, null, { id: 'bad' }, undefined, 'another.valid'],
				},
			},
		});
		assert.deepStrictEqual(a.extensions, ['valid.ext', 'another.valid']);
	});

	test('extracts settings from customizations.vscode.settings', () => {
		const a = extractCustomizations({
			customizations: {
				vscode: { settings: { 'editor.tabSize': 2, 'files.trimTrailingWhitespace': true } },
			},
		});
		assert.deepStrictEqual(a.settings, {
			'editor.tabSize': 2,
			'files.trimTrailingWhitespace': true,
		});
	});

	test('extracts both extensions and settings from same entry', () => {
		const a = extractCustomizations({
			customizations: {
				vscode: {
					extensions: ['a.b'],
					settings: { 'editor.tabSize': 4 },
				},
			},
		});
		assert.deepStrictEqual(a, {
			extensions: ['a.b'],
			settings: { 'editor.tabSize': 4 },
		});
	});

	test('ignores unknown top-level keys', () => {
		const a = extractCustomizations({
			raw: { foo: 'bar' },
			installsAfter: ['x.y'],
			customizations: {
				vscode: { extensions: ['z.w'] },
			},
		});
		assert.deepStrictEqual(a.extensions, ['z.w']);
	});
});

suite('FeatureResolver: mergeInto', () => {
	test('adds extensions to empty accumulator', () => {
		const acc: FeatureCustomizations = { extensions: [], settings: {} };
		mergeInto(acc, { extensions: ['a.b', 'c.d'], settings: { 'key': 'val' } });
		assert.deepStrictEqual(acc, {
			extensions: ['a.b', 'c.d'],
			settings: { 'key': 'val' },
		});
	});

	test('dedupes extensions by reference equality', () => {
		const acc: FeatureCustomizations = { extensions: ['a.b'], settings: {} };
		mergeInto(acc, { extensions: ['a.b', 'c.d'], settings: {} });
		assert.deepStrictEqual(acc.extensions, ['a.b', 'c.d']);
	});

	test('preserves order: existing before new', () => {
		const acc: FeatureCustomizations = { extensions: ['existing'], settings: {} };
		mergeInto(acc, { extensions: ['a.b', 'c.d'], settings: {} });
		assert.deepStrictEqual(acc.extensions, ['existing', 'a.b', 'c.d']);
	});

	test('later settings override earlier ones', () => {
		const acc: FeatureCustomizations = { extensions: [], settings: { 'editor.tabSize': 2 } };
		mergeInto(acc, { extensions: [], settings: { 'editor.tabSize': 4, 'editor.formatOnSave': true } });
		assert.deepStrictEqual(acc.settings, {
			'editor.tabSize': 4,
			'editor.formatOnSave': true,
		});
	});

	test('merges multiple entries in order', () => {
		const acc: FeatureCustomizations = { extensions: [], settings: {} };
		mergeInto(acc, { extensions: ['a.b'], settings: { 'key': 'val1' } });
		mergeInto(acc, { extensions: ['c.d', 'a.b'], settings: { 'key': 'val2' } });
		mergeInto(acc, { extensions: ['e.f'], settings: { 'extra': 'val3' } });
		assert.deepStrictEqual(acc.extensions, ['a.b', 'c.d', 'e.f']);
		assert.deepStrictEqual(acc.settings, {
			'key': 'val2',
			'extra': 'val3',
		});
	});

	test('handles empty add gracefully', () => {
		const acc: FeatureCustomizations = { extensions: ['x.y'], settings: { 'k': 'v' } };
		mergeInto(acc, { extensions: [], settings: {} });
		assert.deepStrictEqual(acc.extensions, ['x.y']);
		assert.deepStrictEqual(acc.settings, { 'k': 'v' });
	});
});

suite('FeatureResolver: fromImageMetadata label-parsing', () => {
	test('returns undefined for empty / missing label', () => {
		assert.strictEqual(parseImageMetadataLabel(undefined), undefined);
		assert.strictEqual(parseImageMetadataLabel(''), undefined);
	});

	test('returns undefined for non-array label JSON', () => {
		assert.strictEqual(parseImageMetadataLabel('"just a string"'), undefined);
		assert.strictEqual(parseImageMetadataLabel('{}'), undefined);
		assert.strictEqual(parseImageMetadataLabel('null'), undefined);
	});

	test('returns undefined for invalid JSON', () => {
		assert.throws(() => parseImageMetadataLabel('not valid json {{{'), SyntaxError);
	});

	test('returns empty customizations for empty metadata array', () => {
		const result = parseImageMetadataLabel('[]');
		assert.deepStrictEqual(result, { extensions: [], settings: {} });
	});

	test('merges extensions from multiple metadata entries', () => {
		const label = JSON.stringify([
			{ customizations: { vscode: { extensions: ['ms-python.python'] } } },
			{ customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint'] } } },
		]);
		const result = parseImageMetadataLabel(label);
		assert.deepStrictEqual(result?.extensions, ['ms-python.python', 'dbaeumer.vscode-eslint']);
	});

	test('merges settings from multiple metadata entries', () => {
		const label = JSON.stringify([
			{ customizations: { vscode: { settings: { 'editor.tabSize': 2 } } } },
			{ customizations: { vscode: { settings: { 'editor.formatOnSave': true } } } },
		]);
		const result = parseImageMetadataLabel(label);
		assert.deepStrictEqual(result?.settings, {
			'editor.tabSize': 2,
			'editor.formatOnSave': true,
		});
	});

	test('later feature settings override earlier ones', () => {
		const label = JSON.stringify([
			{ customizations: { vscode: { settings: { 'editor.tabSize': 2 } } } },
			{ customizations: { vscode: { settings: { 'editor.tabSize': 4 } } } },
		]);
		const result = parseImageMetadataLabel(label);
		assert.strictEqual(result?.settings['editor.tabSize'], 4);
	});

	test('dedupes extensions across all metadata entries', () => {
		const label = JSON.stringify([
			{ customizations: { vscode: { extensions: ['ms-python.python'] } } },
			{ customizations: { vscode: { extensions: ['MS-Python.Python'] } } },
			{ customizations: { vscode: { extensions: ['ms-python.python', 'dbaeumer.vscode-eslint'] } } },
		]);
		const result = parseImageMetadataLabel(label);
		assert.deepStrictEqual(result?.extensions, [
			'ms-python.python',
			'MS-Python.Python', // mergeInto does identity dedup, not case-insensitive
			'dbaeumer.vscode-eslint',
		]);
	});

	test('skips entries with no customizations.vscode', () => {
		const label = JSON.stringify([
			{ customizations: { vscode: { extensions: ['a.b'] } } },
			{ build: { dockerfile: './Dockerfile' } },
			{ customizations: { vscode: { settings: { 'key': 'val' } } } },
			{ name: 'some-container' },
		]);
		const result = parseImageMetadataLabel(label);
		assert.deepStrictEqual(result?.extensions, ['a.b']);
		assert.deepStrictEqual(result?.settings, { 'key': 'val' });
	});

	test('real-world devcontainer.metadata label from a built image', () => {
		// Typical label from a container built with devcontainer features:
		const label = JSON.stringify([
			{
				customizations: {
					vscode: {
						extensions: ['ms-python.python', 'ms-toolsai.vscode-jupyter'],
						settings: { 'python.defaultInterpreterPath': '/usr/local/bin/python' },
					},
				},
			},
			{
				customizations: {
					vscode: {
						extensions: ['mutm-rust.rust'],
						settings: { 'rust.sortItems': 'group' },
					},
				},
			},
		]);
		const result = parseImageMetadataLabel(label);
		assert.deepStrictEqual(result?.extensions, [
			'ms-python.python',
			'ms-toolsai.vscode-jupyter',
			'mutm-rust.rust',
		]);
		assert.deepStrictEqual(result?.settings, {
			'python.defaultInterpreterPath': '/usr/local/bin/python',
			'rust.sortItems': 'group',
		});
	});
});
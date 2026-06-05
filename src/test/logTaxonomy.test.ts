import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Static regression: every literal-string log line emitted via the shared
 * OutputChannel must start with a canonical tag from the taxonomy documented
 * above activate() in src/extension.ts. Calls that forward a variable (e.g.
 * appendLine(msg)) are passthroughs and skipped.
 */

const CANONICAL_TAG = /^\[(crib(\.[a-z]+)?|attach(\.[a-z]+)?|features|discover|poll|watcher(\.[a-z]+)?|container|sync|docker|debug|info|warn|error|hint)\] /;

const EMITTER_CALL = /\b(?:appendLine|appendLog|log|append)\s*\(\s*([`'"])/;

function srcFiles(): string[] {
	const dir = path.join(process.cwd(), 'src');
	const out: string[] = [];
	for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
		if (name.isFile() && name.name.endsWith('.ts')) {
			out.push(path.join(dir, name.name));
		}
	}
	return out;
}

/**
 * Extract the literal first-segment text from an emitter call that starts at
 * `from` in `source`. Returns undefined if the call uses a variable argument
 * or the literal spans constructs we cannot statically read.
 */
function extractLiteralHead(source: string, from: number): string | undefined {
	const quote = source[from];
	if (quote !== '`' && quote !== "'" && quote !== '"') {
		return undefined;
	}
	let i = from + 1;
	let out = '';
	while (i < source.length) {
		const ch = source[i];
		if (ch === '\\') {
			out += source[i + 1] ?? '';
			i += 2;
			continue;
		}
		if (ch === quote) {
			return out;
		}
		// Template-literal interpolation ends the static head.
		if (quote === '`' && ch === '$' && source[i + 1] === '{') {
			return out;
		}
		out += ch;
		i++;
	}
	return undefined;
}

suite('Log taxonomy', () => {
	test('every literal emitter call uses a canonical tag', () => {
		const offenders: Array<{ file: string; line: number; text: string }> = [];
		for (const file of srcFiles()) {
			const text = fs.readFileSync(file, 'utf8');
			const lines = text.split('\n');
			for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
				const line = lines[lineIdx];
				const match = EMITTER_CALL.exec(line);
				if (!match) {
					continue;
				}
				const callIdx = match.index + match[0].length - 1;
				const head = extractLiteralHead(line, callIdx);
				if (head === undefined) {
					continue;
				}
				if (head.length === 0) {
					continue;
				}
				if (!CANONICAL_TAG.test(head)) {
					offenders.push({
						file: path.relative(process.cwd(), file),
						line: lineIdx + 1,
						text: head.slice(0, 80),
					});
				}
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`Found ${offenders.length} log site(s) without a canonical tag:\n` +
				offenders.map(o => `  ${o.file}:${o.line}: "${o.text}"`).join('\n'),
		);
	});
});

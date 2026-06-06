const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		// Prefer ESM builds of dependencies (e.g. jsonc-parser) so esbuild can
		// statically bundle their submodules. The default node `mainFields`
		// (`['main', 'module']`) picks jsonc-parser's UMD entry, which hides its
		// `require('./impl/format')` calls behind a factory parameter named
		// `require` that esbuild cannot follow — leaving a bare runtime require
		// that fails to resolve relative to dist/extension.js.
		mainFields: ['module', 'main'],
		// VS Code 1.105 ships a Node 20 extension-host runtime.
		target: 'node20',
		outfile: 'dist/extension.js',
		// `vscode` is provided by the host and must stay external; everything else
		// (jsonc-parser, etc.) is inlined so the VSIX needs no node_modules.
		external: ['vscode'],
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'info',
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
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

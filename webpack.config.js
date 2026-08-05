/**
 * Joplin plugin webpack config.
 *
 * This handles three build phases (passed via --env joplin-plugin-config):
 *   1. buildMain      — compile src/index.ts → dist/index.js
 *   2. buildExtraScripts — compile webview scripts (declared in plugin.config.json)
 *   3. createArchive  — bundle dist/ + manifest into a .jpl file
 *
 * For development, just run: npx webpack (builds main only)
 */

const path = require('path');
const fs = require('fs-extra');
const tar = require('tar');
const glob = require('glob');
const CopyPlugin = require('copy-webpack-plugin');

const rootDir = __dirname;
const distDir = path.resolve(rootDir, 'dist');
const srcDir = path.resolve(rootDir, 'src');
const publishDir = path.resolve(rootDir, 'publish');

const manifest = require('./src/manifest.json');
const pluginConfig = require('./plugin.config.json');

function readExtraScripts() {
	return (pluginConfig.extraScripts || []).map(s =>
		s.startsWith('src/') ? s : `src/${s}`,
	);
}

const ortDir = path.resolve(rootDir, 'node_modules/onnxruntime-web/dist');

// Embedding runtime assets that must ship inside the .jpl so that indexing
// works with no network access. ORT_WASM_FILE is the CPU-only build; the
// WebGPU-capable "jsep" variant is twice the size and we do not use it.
const ORT_WASM_FILE = 'ort-wasm-simd-threaded.wasm';

/**
 * Aliases that force the embedding stack down its browser code path.
 *
 * Both transformers.js and onnxruntime-web publish a "node" export condition,
 * which webpack picks under `target: 'node'`. Those node builds statically
 * require `onnxruntime-node` (a native module that cannot ship in a .jpl) and
 * load WASM through `fs`, which the plugin sandbox does not provide. Pointing
 * at the web/bundled builds explicitly sidesteps the condition resolution
 * entirely — the alternative is a fragile `conditionNames` override.
 */
function embeddingAliases() {
	return {
		'@huggingface/transformers': path.resolve(
			rootDir, 'node_modules/@huggingface/transformers/dist/transformers.web.js',
		),
		// transformers.js imports the WebGPU entry point; give it the CPU-only
		// bundle instead. Same module surface, half the WASM payload, and the
		// "bundle" build inlines its WASM glue so nothing is fetched at runtime.
		'onnxruntime-web/webgpu': path.resolve(ortDir, 'ort.wasm.bundle.min.mjs'),
		'onnxruntime-node': false,
	};
}

function embeddingAssetPatterns() {
	return [
		{ from: 'assets/models', to: path.resolve(distDir, 'assets/models') },
		{
			from: path.resolve(ortDir, ORT_WASM_FILE),
			to: path.resolve(distDir, 'assets/ort', ORT_WASM_FILE),
		},
	];
}

// Main plugin bundle
function buildMainConfig() {
	return {
		mode: 'production',
		entry: './src/index.ts',
		target: 'node',
		resolve: {
			alias: {
				api: path.resolve(rootDir, 'api'),
				...embeddingAliases(),
			},
			extensions: ['.ts', '.js'],
		},
		module: {
			// onnxruntime-web refers to its WASM binaries via `new URL(...)`, which
			// webpack would resolve and copy into the bundle — an extra 36MB of
			// binaries we never load, since the runtime is handed `wasmBinary`
			// directly. Leaving these URLs as plain code keeps them out.
			parser: { javascript: { url: false } },
			rules: [
				{
					test: /\.ts$/,
					use: 'ts-loader',
					exclude: [/node_modules/, /src\/webview/],
				},
			],
		},
		output: {
			filename: 'index.js',
			path: distDir,
		},
		plugins: [
			new CopyPlugin({
				patterns: [
					{ from: 'src/manifest.json', to: path.resolve(distDir, 'manifest.json') },
					...embeddingAssetPatterns(),
				],
			}),
		],
	};
}

// Webview/extra scripts bundle (each gets its own file)
function buildExtraScriptsConfig() {
	const extraScripts = readExtraScripts();
	if (extraScripts.length === 0) return { mode: 'production', entry: {} };

	const entry = {};
	for (const script of extraScripts) {
		const parsed = path.parse(script);
		// Output path preserves directory structure relative to src/
		const relativePath = path.relative('src', script);
		const outName = relativePath.replace(/\.ts$/, '');
		entry[outName] = `./${script}`;
	}

	return {
		mode: 'production',
		entry,
		target: 'web',
		resolve: {
			extensions: ['.ts', '.js'],
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					use: [{
						loader: 'ts-loader',
						options: {
							compilerOptions: {
								target: 'ES2020',
								module: 'ES2020',
								lib: ['ES2020', 'DOM'],
								moduleResolution: 'node',
								declaration: false,
							},
						},
					}],
					exclude: /node_modules/,
				},
			],
		},
		output: {
			filename: '[name].js',
			path: distDir,
			iife: true,
			library: {
				type: 'window',
			},
		},
	};
}

// Archive: create .jpl (tar.gz of dist/) and publish metadata
function createArchiveConfig() {
	return {
		mode: 'production',
		entry: './src/index.ts',
		resolve: {
			// Same aliases as the main build: this stub compiles src/index.ts too,
			// so without them it would resolve the native onnxruntime-node path.
			alias: {
				api: path.resolve(rootDir, 'api'),
				...embeddingAliases(),
			},
			extensions: ['.ts', '.js'],
		},
		module: {
			// As in buildMainConfig: keep onnxruntime-web's `new URL()` references
			// from dragging duplicate WASM binaries into dist.
			parser: { javascript: { url: false } },
			rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
		},
		output: { filename: '_archive_stub.js', path: distDir },
		plugins: [{
			apply(compiler) {
				compiler.hooks.done.tapPromise('CreateJplArchive', async () => {
					// Copy CSS files to dist
					const cssFiles = glob.sync('src/**/*.css', { cwd: rootDir });
					for (const cssFile of cssFiles) {
						const dest = path.resolve(distDir, path.relative('src', cssFile));
						await fs.ensureDir(path.dirname(dest));
						await fs.copy(path.resolve(rootDir, cssFile), dest);
					}

					// Create .jpl archive
					await fs.ensureDir(publishDir);
					const jplPath = path.resolve(publishDir, `${manifest.id}.jpl`);

					const files = glob.sync('**/*', { cwd: distDir, nodir: true })
						.filter(f => f !== '_archive_stub.js');

					await tar.create(
						{ gzip: true, file: jplPath, cwd: distDir },
						files,
					);

					// Write publish metadata
					const metaPath = path.resolve(publishDir, `${manifest.id}.json`);
					await fs.writeJson(metaPath, manifest, { spaces: '\t' });

					// Clean up stub
					const stubPath = path.resolve(distDir, '_archive_stub.js');
					if (await fs.pathExists(stubPath)) await fs.remove(stubPath);

					console.log(`\nPlugin archive created: ${jplPath}`);
				});
			},
		}],
	};
}

module.exports = (env) => {
	const config = env['joplin-plugin-config'];
	if (config === 'buildMain') return buildMainConfig();
	if (config === 'buildExtraScripts') return buildExtraScriptsConfig();
	if (config === 'createArchive') return createArchiveConfig();

	// Default: build main only (for dev)
	return buildMainConfig();
};

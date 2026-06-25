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

// Main plugin bundle
function buildMainConfig() {
	return {
		mode: 'production',
		entry: './src/index.ts',
		target: 'node',
		resolve: {
			alias: {
				api: path.resolve(rootDir, 'api'),
			},
			extensions: ['.ts', '.js'],
		},
		module: {
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
			libraryTarget: 'commonjs',
		},
		plugins: [
			new CopyPlugin({
				patterns: [
					{ from: 'src/manifest.json', to: path.resolve(distDir, 'manifest.json') },
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
			alias: { api: path.resolve(rootDir, 'api') },
			extensions: ['.ts', '.js'],
		},
		module: {
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

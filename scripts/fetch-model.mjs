/**
 * Downloads the embedding model into assets/ at build time.
 *
 * The model is ~23MB, so it is fetched rather than committed, but it is then
 * bundled into the .jpl — the plugin itself never touches the network. This is
 * the one point in the whole pipeline that does.
 *
 * Idempotent: files already present with the expected size are left alone.
 */

import { mkdir, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const TARGET_DIR = resolve(import.meta.dirname, '..', 'assets', 'models', MODEL_ID);

const FILES = [
	'config.json',
	'tokenizer.json',
	'tokenizer_config.json',
	'special_tokens_map.json',
	'onnx/model_quantized.onnx',
];

/** Smallest plausible size, to catch truncated or error-page downloads. */
const MIN_BYTES = {
	'onnx/model_quantized.onnx': 20_000_000,
	'tokenizer.json': 100_000,
};

async function alreadyPresent(path, file) {
	try {
		const info = await stat(path);
		return info.size >= (MIN_BYTES[file] ?? 1);
	} catch {
		return false;
	}
}

async function fetchFile(file) {
	const target = join(TARGET_DIR, file);

	if (await alreadyPresent(target, file)) {
		console.log(`  have ${file}`);
		return;
	}

	const url = `${BASE_URL}/${file}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} responded ${response.status} ${response.statusText}`);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	const minimum = MIN_BYTES[file] ?? 1;
	if (bytes.byteLength < minimum) {
		throw new Error(
			`${file} is only ${bytes.byteLength} bytes, expected at least ${minimum}`,
		);
	}

	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, bytes);
	console.log(`  got  ${file} (${(bytes.byteLength / 1e6).toFixed(1)}MB)`);
}

console.log(`Fetching ${MODEL_ID} into assets/models/`);
for (const file of FILES) await fetchFile(file);
console.log('Model assets ready.');

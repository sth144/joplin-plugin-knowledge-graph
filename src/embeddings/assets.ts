/**
 * Points transformers.js at the model files bundled inside the plugin, so
 * embedding never touches the network.
 *
 * transformers.js normally auto-detects its environment to decide how to load
 * files, and that detection does not survive the Joplin plugin sandbox: the
 * bundled web build stubs out `node:fs` (so its FileSystem path is dead), while
 * the sandbox is not enough of a browser for the fetch path to reach local
 * files either. Rather than fight the detection, we drive it explicitly —
 * `env.fetch` is overridden with a reader backed by whatever file access the
 * host has, and the ONNX Runtime WASM binary is handed over as bytes so the
 * runtime never resolves a path of its own.
 */

import { loadTransformers } from './runtime';

/** Reads a file by absolute path. Rejects if it does not exist. */
export type FileReader = (absPath: string) => Promise<Uint8Array>;

export interface AssetPaths {
	/** Directory containing `<org>/<model>/...` model trees. */
	modelsDir: string;
	/** Absolute path to the onnxruntime-web WASM binary. */
	ortWasmFile: string;
	/**
	 * WASM threads to use. Values above 1 need SharedArrayBuffer, and fall back
	 * to single-threaded on their own if it is unavailable.
	 */
	numThreads?: number;
}

const HTTP_PATTERN = /^https?:/i;
const FILE_URL_PREFIX = 'file://';

let configured: Promise<void> | null = null;

/**
 * Configure transformers.js for fully-offline, bundled-asset operation.
 * Safe to call repeatedly; the work happens once.
 */
export function configureTransformers(
	paths: AssetPaths,
	readFile: FileReader,
): Promise<void> {
	if (!configured) configured = applyConfig(paths, readFile);
	return configured;
}

async function applyConfig(
	paths: AssetPaths,
	readFile: FileReader,
): Promise<void> {
	const { env } = await loadTransformers();

	// Model resolution: bundled files only, never the Hugging Face Hub.
	env.allowRemoteModels = false;
	env.allowLocalModels = true;
	env.localModelPath = paths.modelsDir;

	// Every caching layer is off. The "cache" is the bundled model itself, so
	// caching would only duplicate ~23MB somewhere else on disk.
	env.useFS = false;
	env.useFSCache = false;
	env.useBrowserCache = false;
	env.useCustomCache = false;

	env.fetch = createFileFetch(readFile) as typeof env.fetch;

	// Hand ONNX Runtime the WASM bytes directly. Its loader uses its own fetch
	// (not env.fetch) and resolves `wasmPaths` against a document base URL that
	// does not exist here, so passing a path instead of bytes fails.
	const wasm = env.backends.onnx.wasm;
	if (!wasm) {
		throw new Error(
			'knowledge-graph: the ONNX WASM backend is missing. The embedding ' +
			'bundle resolved to a build without it.',
		);
	}
	// transformers.js defaults wasmPaths to a jsdelivr CDN URL when it loads.
	// Clearing it is what actually keeps this offline: the ONNX build we bundle
	// has its JS glue inlined, so with no paths set the runtime uses the glue it
	// already has and takes the binary from wasmBinary below. Leaving wasmPaths
	// in place makes ORT fetch the glue over the network and fail.
	wasm.wasmPaths = undefined;
	wasm.wasmBinary = await readAsArrayBuffer(readFile, paths.ortWasmFile);
	// Threading needs SharedArrayBuffer, which requires cross-origin isolation
	// we do not control from inside a plugin. Default to 1 so the runtime never
	// depends on it; callers can raise this where it is known to work.
	wasm.numThreads = paths.numThreads ?? 1;
}

/**
 * An `env.fetch` replacement that resolves local paths through `readFile` and
 * refuses anything remote, so an unbundled asset fails loudly instead of
 * silently reaching the network.
 */
function createFileFetch(readFile: FileReader) {
	return async (input: unknown): Promise<Response> => {
		const target = requestPath(input);

		if (HTTP_PATTERN.test(target)) {
			throw new Error(
				`knowledge-graph: blocked a network request for ${target}. ` +
				'Embedding assets must be bundled with the plugin.',
			);
		}

		let bytes: Uint8Array;
		try {
			bytes = await readFile(localPath(target));
		} catch {
			// Some model files are optional; transformers.js probes for them and
			// expects a 404 rather than a thrown error.
			return new Response(null, { status: 404, statusText: 'Not Found' });
		}

		// Pass a standalone ArrayBuffer rather than the view — see toArrayBuffer.
		return new Response(toArrayBuffer(bytes), {
			status: 200,
			headers: { 'Content-Length': String(bytes.byteLength) },
		});
	};
}

function requestPath(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	const url = (input as { url?: unknown } | null)?.url;
	return typeof url === 'string' ? url : String(input);
}

function localPath(target: string): string {
	if (!target.startsWith(FILE_URL_PREFIX)) return target;
	return decodeURIComponent(target.slice(FILE_URL_PREFIX.length));
}

async function readAsArrayBuffer(
	readFile: FileReader,
	absPath: string,
): Promise<ArrayBuffer> {
	return toArrayBuffer(await readFile(absPath));
}

/**
 * Copy out of the view's backing buffer. Node `Buffer`s are slices of a shared
 * pool, so handing `.buffer` straight to a consumer would expose unrelated
 * memory and a wrong length.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

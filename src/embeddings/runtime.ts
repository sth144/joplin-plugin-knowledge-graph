/**
 * Loads transformers.js so that it selects its *web* runtime.
 *
 * transformers.js picks its ONNX backend once, at module-evaluation time:
 *
 *     if (apis.IS_NODE_ENV) ONNX = ONNX_NODE; else ONNX = ONNX_WEB;
 *
 * where `IS_NODE_ENV` is `process?.release?.name === 'node'`. The Joplin plugin
 * process satisfies that test, but `onnxruntime-node` is a native module that
 * cannot ship inside a .jpl, so the build aliases it away to an empty stub. The
 * result is a runtime with no backend at all — `env.backends.onnx.wasm` comes
 * back undefined, and model construction fails with a confusing
 * "Cannot read properties of undefined (reading 'wasm')".
 *
 * So we make the detection see a non-node runtime for exactly as long as it
 * takes transformers.js to evaluate, then put `process.release` back. The
 * library then wires up onnxruntime-web, registers `wasm` as a supported and
 * default device, and populates `env.backends.onnx.wasm` — the state it would
 * have in a browser, which matches the web build and WASM binary we ship.
 *
 * The obvious-looking alternative, `globalThis[Symbol.for('onnxruntime')]`, is a
 * trap: it short-circuits the branch above but skips the device registration
 * inside it, leaving `defaultDevices` undefined and every explicit device name
 * rejected as unsupported.
 */

type TransformersModule = typeof import('@huggingface/transformers');

let loading: Promise<TransformersModule> | null = null;

/** Load transformers.js once, with its environment detection corrected. */
export function loadTransformers(): Promise<TransformersModule> {
	if (!loading) loading = evaluateAsWebRuntime();
	return loading;
}

async function evaluateAsWebRuntime(): Promise<TransformersModule> {
	const restore = maskNodeRuntime();
	try {
		// webpackMode "eager" keeps this in the single index.js bundle that
		// Joplin expects (no split chunks) while still deferring evaluation to
		// this call, which is what lets the mask above take effect.
		return await import(
			/* webpackMode: "eager" */ '@huggingface/transformers'
		);
	} finally {
		restore();
	}
}

/**
 * Temporarily make `process.release.name` report something other than 'node'.
 * Returns a function that restores the original state.
 *
 * Note that `process.release` is a non-writable but configurable property, so
 * plain assignment silently does nothing — it has to be redefined.
 */
function maskNodeRuntime(): () => void {
	const proc = (globalThis as { process?: object }).process;
	if (!proc) return () => {};

	const original = Object.getOwnPropertyDescriptor(proc, 'release');
	if (original && !original.configurable && !original.writable) {
		// Nothing we can do; model loading will fail with a clear message.
		return () => {};
	}

	const release = (proc as { release?: object }).release;
	Object.defineProperty(proc, 'release', {
		value: { ...release, name: 'joplin-plugin' },
		writable: false,
		enumerable: true,
		configurable: true,
	});

	return () => {
		if (original) Object.defineProperty(proc, 'release', original);
		else delete (proc as { release?: unknown }).release;
	};
}

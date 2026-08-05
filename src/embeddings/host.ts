/**
 * Bridges the embedding stack to Joplin's filesystem access.
 *
 * Everything below `assets.ts` takes an injected `FileReader` and asset paths
 * rather than reaching for Joplin directly, which keeps the model runtime
 * testable outside the plugin sandbox — see spike/harness.ts.
 */

import joplin from 'api';
import { AssetPaths, FileReader } from './assets';

const ORT_WASM_FILE = 'ort-wasm-simd-threaded.wasm';

let fsExtra: any = null;

/**
 * `fs-extra` as bundled with Joplin. A bare `require` is not available in the
 * plugin sandbox, so it has to come through `joplin.require`.
 */
function fs(): any {
	if (!fsExtra) fsExtra = joplin.require('fs-extra');
	return fsExtra;
}

/** Read a file as bytes, for handing bundled assets to the model runtime. */
export const readFile: FileReader = async (absPath: string) => {
	return new Uint8Array(await fs().readFile(absPath));
};

/** Locate the model and WASM assets bundled inside the installed plugin. */
export async function assetPaths(): Promise<AssetPaths> {
	const installDir = await joplin.plugins.installationDir();
	return {
		modelsDir: `${installDir}/assets/models`,
		ortWasmFile: `${installDir}/assets/ort/${ORT_WASM_FILE}`,
	};
}

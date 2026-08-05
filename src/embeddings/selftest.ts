/**
 * Self-test for the embedding runtime, run from inside Joplin.
 *
 * The node harness (spike/harness.ts) proves the bundling and asset-loading
 * strategy, but only this can prove the plugin sandbox itself: whether
 * `joplin.require('fs-extra')` reads the bundled assets, whether WASM
 * instantiates there, and what the throughput actually is on real hardware.
 */

import { createBackend, dot } from './backend';
import { assetPaths, readFile } from './host';

export interface SelfTestResult {
	ok: boolean;
	lines: string[];
}

const SAMPLE = 'Meeting notes about the deployment pipeline. '.repeat(20);

export async function runSelfTest(): Promise<SelfTestResult> {
	const lines: string[] = [];

	try {
		const paths = await assetPaths();
		lines.push(`assets: ${paths.modelsDir}`);

		const loadStart = Date.now();
		const backend = await createBackend(paths, readFile);
		lines.push(`model loaded in ${Date.now() - loadStart}ms`);

		const [vector] = await backend.embed(['a note about knowledge graphs']);
		const norm = Math.sqrt(dot(vector, vector));
		lines.push(`dims=${vector.length}, norm=${norm.toFixed(4)}`);

		// A runtime can load and still emit garbage; check that related text
		// scores higher than unrelated text.
		const [cat, kitten, mortgage] = await backend.embed([
			'cat', 'kitten', 'mortgage refinancing',
		]);
		const near = dot(cat, kitten);
		const far = dot(cat, mortgage);
		lines.push(`cos(cat,kitten)=${near.toFixed(3)} vs cos(cat,mortgage)=${far.toFixed(3)}`);

		const start = Date.now();
		await backend.embed(new Array(8).fill(SAMPLE));
		const elapsed = Date.now() - start;
		const charsPerSec = Math.round((SAMPLE.length * 8) / (elapsed / 1000));
		lines.push(`throughput: ~${charsPerSec.toLocaleString()} chars/sec`);

		const ok = vector.length === backend.dims
			&& Math.abs(norm - 1) < 1e-3
			&& near > far;
		lines.push(ok ? 'RESULT: PASS' : 'RESULT: FAIL (vectors look wrong)');
		return { ok, lines };
	} catch (err) {
		lines.push(`RESULT: FAIL — ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, lines };
	}
}

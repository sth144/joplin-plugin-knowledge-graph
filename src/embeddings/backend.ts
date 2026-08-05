/**
 * The embedding model itself: turns text into normalised vectors.
 *
 * Vectors are L2-normalised at this boundary, which makes cosine similarity a
 * plain dot product everywhere downstream (storage, kNN, search).
 */

import { AssetPaths, FileReader, configureTransformers } from './assets';
import { loadTransformers } from './runtime';

/** Model tree bundled under the assets directory. */
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

/** Model input limit, in word-piece tokens. Chunking must respect this. */
export const MODEL_MAX_TOKENS = 256;

export interface EmbeddingBackend {
	readonly modelId: string;
	readonly dims: number;
	/** Embed a batch of texts, returning one normalised vector per input. */
	embed(texts: string[]): Promise<Float32Array[]>;
	/**
	 * Token count for a text, as the model will see it. Needed because the model
	 * silently truncates anything past MODEL_MAX_TOKENS, and token count cannot
	 * be predicted from character count — code, URLs and tables run far denser
	 * than prose.
	 */
	countTokens(text: string): number;
}

type ExtractorOptions = { pooling: 'mean'; normalize: boolean };
type Extractor = ((
	texts: string[],
	options: ExtractorOptions,
) => Promise<{ data: ArrayLike<number>; dims: number[] }>) & {
	tokenizer: { encode(text: string): unknown[] };
};

/**
 * Load the bundled model. Expensive (tens of MB of WASM plus weights), so the
 * caller should hold on to the result rather than reloading per batch.
 */
export async function createBackend(
	paths: AssetPaths,
	readFile: FileReader,
): Promise<EmbeddingBackend> {
	await configureTransformers(paths, readFile);
	const { pipeline } = await loadTransformers();

	const extractor = (await pipeline('feature-extraction', MODEL_ID, {
		dtype: 'q8',
	})) as unknown as Extractor;

	return {
		modelId: MODEL_ID,
		dims: EMBEDDING_DIMS,
		countTokens(text: string): number {
			return extractor.tokenizer.encode(text).length;
		},
		async embed(texts: string[]): Promise<Float32Array[]> {
			if (texts.length === 0) return [];

			const output = await extractor(texts, {
				pooling: 'mean',
				normalize: true,
			});

			return unpack(output.data, texts.length, EMBEDDING_DIMS);
		},
	};
}

/** Split a flat [batch × dims] tensor into per-input vectors. */
function unpack(
	data: ArrayLike<number>,
	count: number,
	dims: number,
): Float32Array[] {
	if (data.length !== count * dims) {
		throw new Error(
			`knowledge-graph: expected ${count * dims} values from the embedding ` +
			`model but got ${data.length}`,
		);
	}

	const vectors: Float32Array[] = [];
	for (let i = 0; i < count; i++) {
		const vector = new Float32Array(dims);
		const offset = i * dims;
		for (let d = 0; d < dims; d++) vector[d] = data[offset + d];
		vectors.push(vector);
	}
	return vectors;
}

/** Cosine similarity for vectors that are already L2-normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

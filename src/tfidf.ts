/**
 * Pure TypeScript TF-IDF + cosine similarity implementation.
 * No external dependencies.
 */

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
	'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
	'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
	'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'this',
	'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
	'he', 'she', 'him', 'her', 'his', 'they', 'them', 'their', 'what',
	'which', 'who', 'whom', 'where', 'when', 'why', 'how', 'not', 'no',
	'nor', 'if', 'then', 'else', 'so', 'as', 'up', 'out', 'about', 'into',
	'than', 'too', 'very', 'just', 'also', 'all', 'each', 'every', 'any',
	'some', 'such', 'only', 'own', 'same', 'other', 'more', 'most', 'one',
	'two', 'new', 'now', 'way', 'use', 'used', 'using',
]);

/** Tokenize text into lowercase word tokens, filtering stop words and short tokens. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/** Strip markdown formatting for cleaner tokenization. */
export function stripMarkdown(text: string): string {
	let result = text;
	result = result.replace(/!\[.*?\]\(.*?\)/g, '');           // images
	result = result.replace(/\[([^\]]*)\]\(.*?\)/g, '$1');     // links → text
	result = result.replace(/[#*_`~>|]/g, ' ');                // formatting
	result = result.replace(/\s+/g, ' ');                       // collapse whitespace
	return result.trim();
}

/** A sparse vector represented as a Map from term index to value. */
type SparseVector = Map<number, number>;

export interface SimilarityEdge {
	i: number;
	j: number;
	score: number;
}

/**
 * Compute TF-IDF vectors for a corpus and return edges above the similarity threshold.
 */
export function computeSimilarityEdges(
	documents: string[],
	threshold: number,
): SimilarityEdge[] {
	const n = documents.length;
	if (n < 2) return [];

	// Build vocabulary and document frequency
	const vocab = new Map<string, number>();    // term → index
	const df = new Map<number, number>();        // term_index → doc count
	const docTokens: string[][] = [];

	for (const doc of documents) {
		const tokens = tokenize(stripMarkdown(doc));
		docTokens.push(tokens);
		const seen = new Set<string>();
		for (const token of tokens) {
			if (!vocab.has(token)) {
				vocab.set(token, vocab.size);
			}
			seen.add(token);
		}
		for (const token of seen) {
			const idx = vocab.get(token)!;
			df.set(idx, (df.get(idx) || 0) + 1);
		}
	}

	// Filter terms: must appear in >= 2 docs and <= 80% of docs
	const minDf = 2;
	const maxDf = Math.floor(n * 0.8);
	const validTerms = new Set<number>();
	for (const [termIdx, count] of df) {
		if (count >= minDf && count <= maxDf) {
			validTerms.add(termIdx);
		}
	}

	// Compute TF-IDF vectors
	const vectors: SparseVector[] = [];
	for (let d = 0; d < n; d++) {
		const vec: SparseVector = new Map();
		const tokens = docTokens[d];
		const tf = new Map<number, number>();

		for (const token of tokens) {
			const idx = vocab.get(token)!;
			if (validTerms.has(idx)) {
				tf.set(idx, (tf.get(idx) || 0) + 1);
			}
		}

		let norm = 0;
		for (const [termIdx, count] of tf) {
			const idf = Math.log(n / (df.get(termIdx)! + 1));
			const tfidf = count * idf;
			vec.set(termIdx, tfidf);
			norm += tfidf * tfidf;
		}

		// Normalize
		norm = Math.sqrt(norm);
		if (norm > 0) {
			for (const [termIdx, val] of vec) {
				vec.set(termIdx, val / norm);
			}
		}

		vectors.push(vec);
	}

	// Compute pairwise cosine similarity
	const edges: SimilarityEdge[] = [];
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const score = cosineSimilarity(vectors[i], vectors[j]);
			if (score >= threshold) {
				edges.push({ i, j, score });
			}
		}
	}

	return edges;
}

/** Cosine similarity between two sparse vectors (already normalized). */
function cosineSimilarity(a: SparseVector, b: SparseVector): number {
	let dot = 0;
	// Iterate over the smaller vector for efficiency
	const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
	for (const [idx, val] of smaller) {
		const otherVal = larger.get(idx);
		if (otherVal !== undefined) {
			dot += val * otherVal;
		}
	}
	return dot;
}

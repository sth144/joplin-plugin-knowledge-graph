/**
 * k-means clustering over note embeddings.
 *
 * Spherical k-means: the vectors are L2-normalised, so similarity is a dot
 * product and a centroid is the mean of its members renormalised back onto the
 * unit sphere. Using plain Euclidean k-means on normalised vectors would
 * optimise a subtly different objective than the cosine similarity everything
 * else in the plugin uses.
 *
 * This complements the mutual-kNN edges rather than replacing them: those edges
 * describe which notes are near each other, while k-means partitions the whole
 * library so that every note lands in a group. Connectivity-based labelling gave
 * a long tail of singletons and pairs, which does not read as clusters.
 */

/** Deterministic, so the same library always yields the same colours. */
const SEED = 0x9e3779b9;

const MAX_ITERATIONS = 40;
const CONVERGENCE_RATIO = 0.001;

/** Candidate cluster counts tried in auto mode. */
const AUTO_K_CANDIDATES = [4, 6, 8, 12, 16, 24];

export interface KMeansResult {
	/** Cluster id per note, in 0..k-1. */
	assignments: Int32Array;
	k: number;
	/** Unit-length cluster centroids, k x dims. */
	centroids: Float32Array;
}

/**
 * Partition notes into `k` clusters. Pass k <= 0 to choose it automatically.
 */
export function clusterVectors(
	vectors: Float32Array,
	count: number,
	dims: number,
	k: number,
): KMeansResult {
	if (count === 0) {
		return { assignments: new Int32Array(0), k: 0, centroids: new Float32Array(0) };
	}

	if (k > 0) return runKMeans(vectors, count, dims, clampK(k, count));
	return autoCluster(vectors, count, dims);
}

/**
 * Try several cluster counts and keep the best-scoring partition.
 *
 * Scored with the simplified silhouette — each note compared against its own
 * centroid versus the nearest rival centroid. The textbook silhouette compares
 * every pair of notes, which is quadratic and far too slow for a large library;
 * the centroid form is O(n·k) and good enough to pick between candidates.
 */
function autoCluster(
	vectors: Float32Array,
	count: number,
	dims: number,
): KMeansResult {
	let best: KMeansResult | null = null;
	let bestScore = -Infinity;

	for (const candidate of AUTO_K_CANDIDATES) {
		const k = clampK(candidate, count);
		if (k < 2) continue;

		const result = runKMeans(vectors, count, dims, k);
		const score = simplifiedSilhouette(vectors, count, dims, result);

		if (score > bestScore) {
			bestScore = score;
			best = result;
		}

		// Stop widening once k reaches what the library can support.
		if (k === count) break;
	}

	return best ?? runKMeans(vectors, count, dims, clampK(2, count));
}

function clampK(k: number, count: number): number {
	return Math.max(1, Math.min(Math.round(k), count));
}

function runKMeans(
	vectors: Float32Array,
	count: number,
	dims: number,
	k: number,
): KMeansResult {
	const centroids = seedCentroids(vectors, count, dims, k);
	const assignments = new Int32Array(count).fill(-1);

	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
		const moved = assignAll(vectors, count, dims, centroids, k, assignments);
		recomputeCentroids(vectors, count, dims, assignments, k, centroids);
		if (moved <= count * CONVERGENCE_RATIO) break;
	}

	return { assignments, k, centroids };
}

/**
 * k-means++ seeding: pick spread-out starting centroids so the result does not
 * depend on a lucky initial draw. Uses a fixed-seed generator for determinism.
 */
function seedCentroids(
	vectors: Float32Array,
	count: number,
	dims: number,
	k: number,
): Float32Array {
	const random = makeRandom(SEED);
	const centroids = new Float32Array(k * dims);

	const first = Math.floor(random() * count);
	copyVector(vectors, first, centroids, 0, dims);

	// Distance of each note to the nearest centroid chosen so far.
	const nearest = new Float32Array(count).fill(Infinity);

	for (let chosen = 1; chosen < k; chosen++) {
		let total = 0;
		for (let i = 0; i < count; i++) {
			const similarity = dotAt(vectors, i, centroids, chosen - 1, dims);
			// Cosine distance, floored at zero for opposing vectors.
			const distance = Math.max(0, 1 - similarity);
			if (distance < nearest[i]) nearest[i] = distance;
			total += nearest[i] * nearest[i];
		}

		let target = random() * total;
		let pick = count - 1;
		for (let i = 0; i < count; i++) {
			target -= nearest[i] * nearest[i];
			if (target <= 0) {
				pick = i;
				break;
			}
		}

		copyVector(vectors, pick, centroids, chosen, dims);
	}

	return centroids;
}

/** Assign every note to its nearest centroid; returns how many changed. */
function assignAll(
	vectors: Float32Array,
	count: number,
	dims: number,
	centroids: Float32Array,
	k: number,
	assignments: Int32Array,
): number {
	let moved = 0;

	for (let i = 0; i < count; i++) {
		let best = 0;
		let bestSimilarity = -Infinity;

		for (let c = 0; c < k; c++) {
			const similarity = dotAt(vectors, i, centroids, c, dims);
			if (similarity > bestSimilarity) {
				bestSimilarity = similarity;
				best = c;
			}
		}

		if (assignments[i] !== best) {
			assignments[i] = best;
			moved++;
		}
	}

	return moved;
}

/**
 * Move each centroid to the mean of its members, renormalised. Empty clusters
 * are left where they are rather than reseeded — reseeding would break
 * determinism for a case that resolves itself on the next pass.
 */
function recomputeCentroids(
	vectors: Float32Array,
	count: number,
	dims: number,
	assignments: Int32Array,
	k: number,
	centroids: Float32Array,
): void {
	const sums = new Float32Array(k * dims);
	const members = new Int32Array(k);

	for (let i = 0; i < count; i++) {
		const cluster = assignments[i];
		members[cluster]++;
		const from = i * dims;
		const to = cluster * dims;
		for (let d = 0; d < dims; d++) sums[to + d] += vectors[from + d];
	}

	for (let c = 0; c < k; c++) {
		if (members[c] === 0) continue;
		const at = c * dims;

		let norm = 0;
		for (let d = 0; d < dims; d++) norm += sums[at + d] * sums[at + d];
		norm = Math.sqrt(norm) || 1;

		for (let d = 0; d < dims; d++) centroids[at + d] = sums[at + d] / norm;
	}
}

/**
 * Mean over notes of (own-centroid similarity - best rival similarity), scaled.
 * Higher means tighter, better-separated clusters.
 */
function simplifiedSilhouette(
	vectors: Float32Array,
	count: number,
	dims: number,
	result: KMeansResult,
): number {
	const { assignments, centroids, k } = result;
	if (k < 2) return -Infinity;

	let total = 0;

	for (let i = 0; i < count; i++) {
		const own = dotAt(vectors, i, centroids, assignments[i], dims);
		let rival = -Infinity;

		for (let c = 0; c < k; c++) {
			if (c === assignments[i]) continue;
			const similarity = dotAt(vectors, i, centroids, c, dims);
			if (similarity > rival) rival = similarity;
		}

		// Both terms are cosine distances, so this matches the usual
		// (b - a) / max(a, b) definition.
		const a = Math.max(0, 1 - own);
		const b = Math.max(0, 1 - rival);
		const denominator = Math.max(a, b);
		total += denominator > 0 ? (b - a) / denominator : 0;
	}

	return total / count;
}

function dotAt(
	left: Float32Array,
	leftIndex: number,
	right: Float32Array,
	rightIndex: number,
	dims: number,
): number {
	const a = leftIndex * dims;
	const b = rightIndex * dims;
	let sum = 0;
	for (let d = 0; d < dims; d++) sum += left[a + d] * right[b + d];
	return sum;
}

function copyVector(
	source: Float32Array,
	sourceIndex: number,
	target: Float32Array,
	targetIndex: number,
	dims: number,
): void {
	target.set(
		source.subarray(sourceIndex * dims, (sourceIndex + 1) * dims),
		targetIndex * dims,
	);
}

/** Small deterministic PRNG (mulberry32). */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

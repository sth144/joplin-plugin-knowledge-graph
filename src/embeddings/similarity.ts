/**
 * Turns stored vectors into graph structure: which notes connect, and which
 * cluster each belongs to.
 *
 * Three choices matter here.
 *
 * Edges come from *mutual* nearest neighbours rather than a similarity
 * threshold. Embedding cosines bunch up in a narrow band, so any fixed cutoff
 * either connects almost nothing or produces a hairball, whereas "each note
 * keeps its k closest, and the edge survives if the feeling is mutual" adapts to
 * local density.
 *
 * Scoring is two-stage. Comparing every chunk against every other is quadratic
 * in *chunk* count, which is brutal in practice: a single long note can hold a
 * thousand chunks and dominate the entire computation. So whole-note averages
 * (quadratic in note count, which is far smaller) propose candidate pairs, and
 * only those candidates are rescored chunk-by-chunk. The tradeoff is recall —
 * two notes whose overall gists differ but which share one strong passage may
 * not be proposed — so the candidate list is deliberately much longer than the
 * number of edges we intend to keep.
 *
 * Clusters come from k-means over the note vectors, not from the edge structure.
 * Label propagation over sparse mutual-kNN edges was tried first and produced
 * connected components rather than clusters: on a real 305-note library it gave
 * 101 groups, half of them singletons, because a note with no surviving edge can
 * never join a group. k-means partitions the whole vector space instead, so every
 * note lands somewhere and the count is controllable.
 */

import { ClusterSettings } from '../settings';
import { clusterVectors } from './kmeans';
import { VectorIndex } from './store';

export interface SemanticEdge {
	/** Note ordinals, indexing into VectorIndex.noteIds. */
	i: number;
	j: number;
	score: number;
}

export interface SemanticGraph {
	edges: SemanticEdge[];
	/** Cluster id per note ordinal, or -1 throughout when clustering is off. */
	clusters: Int32Array;
	/** Unit-length centroid per cluster, k x dims. Empty when clustering is off. */
	centroids: Float32Array;
	clusterCount: number;
	notes: number;
}

/**
 * Candidate pairs kept per note before rescoring, as a multiple of the final
 * neighbour count. Generous, because mean-pooled similarity is only a proxy for
 * the chunk-level score that decides the final ranking.
 */
const CANDIDATE_FACTOR = 8;
const MIN_CANDIDATES = 40;

export function buildSemanticGraph(
	index: VectorIndex,
	settings: ClusterSettings,
	report: (message: string) => void = () => {},
): SemanticGraph {
	const noteCount = index.noteIds.length;
	if (noteCount === 0) {
		return {
			edges: [],
			clusters: new Int32Array(0),
			centroids: new Float32Array(0),
			clusterCount: 0,
			notes: 0,
		};
	}

	const noteVectors = meanPooledNotes(index);
	const candidateCount = Math.max(
		MIN_CANDIDATES, settings.neighbours * CANDIDATE_FACTOR,
	);

	// Stage 1: propose pairs using whole-note averages.
	const candidates = proposeCandidates(
		noteVectors, index.dims, noteCount, candidateCount, settings.minCosine,
	);

	// Stage 2: score the proposals, chunk-by-chunk if that is what was asked for.
	const rescore = settings.pooling === 'mean'
		? null
		: maxChunkScorer(index);
	const neighbours = rankNeighbours(candidates, rescore, settings);

	const edges = collectEdges(neighbours, settings.mutualOnly);

	if (!settings.clustering) {
		report(`Semantic graph: ${edges.length} edges over ${noteCount} notes`);
		return {
			edges,
			clusters: new Int32Array(noteCount).fill(-1),
			centroids: new Float32Array(0),
			clusterCount: 0,
			notes: noteCount,
		};
	}

	const grouped = clusterVectors(
		noteVectors, noteCount, index.dims, settings.clusterCount,
	);

	report(
		`Semantic graph: ${edges.length} edges, ${grouped.k} clusters ` +
		`over ${noteCount} notes (pooling=${settings.pooling}` +
		`${settings.clusterCount > 0 ? '' : ', k chosen automatically'})`,
	);

	return {
		edges,
		clusters: grouped.assignments,
		centroids: grouped.centroids,
		clusterCount: grouped.k,
		notes: noteCount,
	};
}

interface Candidate {
	other: number;
	score: number;
}

/** Mean of a note's chunk vectors, re-normalised so dot product is cosine. */
function meanPooledNotes(index: VectorIndex): Float32Array {
	const { dims, matrix, chunkNote, noteIds } = index;
	const notes = new Float32Array(noteIds.length * dims);

	for (let chunk = 0; chunk < chunkNote.length; chunk++) {
		const from = chunk * dims;
		const to = chunkNote[chunk] * dims;
		for (let d = 0; d < dims; d++) notes[to + d] += matrix[from + d];
	}

	for (let note = 0; note < noteIds.length; note++) {
		const at = note * dims;
		let norm = 0;
		for (let d = 0; d < dims; d++) norm += notes[at + d] * notes[at + d];
		norm = Math.sqrt(norm) || 1;
		for (let d = 0; d < dims; d++) notes[at + d] /= norm;
	}

	return notes;
}

/** Top candidate pairs per note by whole-note similarity. */
function proposeCandidates(
	noteVectors: Float32Array,
	dims: number,
	noteCount: number,
	perNote: number,
	minCosine: number,
): Candidate[][] {
	const candidates: Candidate[][] = [];
	for (let i = 0; i < noteCount; i++) candidates.push([]);

	for (let i = 0; i < noteCount; i++) {
		const iv = i * dims;
		for (let j = i + 1; j < noteCount; j++) {
			const jv = j * dims;
			let sum = 0;
			for (let d = 0; d < dims; d++) sum += noteVectors[iv + d] * noteVectors[jv + d];

			// The floor applies to the final score, and chunk-level rescoring can
			// only raise it, so filtering here would discard valid pairs. Keep a
			// fraction of the floor as a cheap sanity bound instead.
			if (sum < minCosine * 0.5) continue;

			offer(candidates[i], { other: j, score: sum }, perNote);
			offer(candidates[j], { other: i, score: sum }, perNote);
		}
	}

	return candidates;
}

/**
 * Score a note pair by their single best-matching pair of chunks, so two notes
 * sharing one strong theme connect even when the rest is unrelated.
 */
function maxChunkScorer(index: VectorIndex): (a: number, b: number) => number {
	const { dims, matrix, chunkNote, noteIds } = index;
	const ranges = chunkRanges(chunkNote, noteIds.length);

	return (a, b) => {
		let best = -1;
		for (let x = ranges[a]; x < ranges[a + 1]; x++) {
			const xv = x * dims;
			for (let y = ranges[b]; y < ranges[b + 1]; y++) {
				const yv = y * dims;
				let sum = 0;
				for (let d = 0; d < dims; d++) sum += matrix[xv + d] * matrix[yv + d];
				if (sum > best) best = sum;
			}
		}
		return best;
	};
}

/**
 * Start offset of each note's chunks, plus a terminator. Relies on the index
 * being grouped by note, which `VectorStore.loadIndex` guarantees.
 */
function chunkRanges(chunkNote: Int32Array, noteCount: number): Int32Array {
	const ranges = new Int32Array(noteCount + 1);
	for (let chunk = 0; chunk < chunkNote.length; chunk++) {
		ranges[chunkNote[chunk] + 1]++;
	}
	for (let note = 0; note < noteCount; note++) {
		ranges[note + 1] += ranges[note];
	}
	return ranges;
}

/**
 * Reduce candidates to each note's final k neighbours, rescoring first when
 * chunk-level pooling was requested. Rescoring is memoised per pair, since every
 * pair appears in both notes' candidate lists.
 */
function rankNeighbours(
	candidates: Candidate[][],
	rescore: ((a: number, b: number) => number) | null,
	settings: ClusterSettings,
): Candidate[][] {
	const k = Math.max(1, settings.neighbours);
	const noteCount = candidates.length;
	const cache = new Map<number, number>();

	const scoreOf = (i: number, j: number, fallback: number): number => {
		if (!rescore) return fallback;
		const key = i < j ? i * noteCount + j : j * noteCount + i;
		let value = cache.get(key);
		if (value === undefined) {
			value = rescore(Math.min(i, j), Math.max(i, j));
			cache.set(key, value);
		}
		return value;
	};

	const ranked: Candidate[][] = [];
	for (let i = 0; i < noteCount; i++) {
		const list: Candidate[] = [];
		for (const candidate of candidates[i]) {
			const score = scoreOf(i, candidate.other, candidate.score);
			if (score < settings.minCosine) continue;
			offer(list, { other: candidate.other, score }, k);
		}
		ranked.push(list);
	}

	return ranked;
}

/** Turn per-note neighbour lists into a deduplicated edge list. */
function collectEdges(
	neighbours: Candidate[][],
	mutualOnly: boolean,
): SemanticEdge[] {
	const edges: SemanticEdge[] = [];
	const seen = new Set<number>();
	const noteCount = neighbours.length;

	for (let i = 0; i < noteCount; i++) {
		for (const candidate of neighbours[i]) {
			const j = candidate.other;
			if (mutualOnly && !neighbours[j].some(n => n.other === i)) continue;

			const key = i < j ? i * noteCount + j : j * noteCount + i;
			if (seen.has(key)) continue;
			seen.add(key);

			edges.push({
				i: Math.min(i, j),
				j: Math.max(i, j),
				score: candidate.score,
			});
		}
	}

	return edges;
}

/** Insert into a descending top-k list, dropping the weakest when full. */
function offer(list: Candidate[], entry: Candidate, k: number): void {
	if (list.length < k) {
		list.push(entry);
		list.sort((a, b) => b.score - a.score);
		return;
	}
	if (entry.score <= list[list.length - 1].score) return;
	list[list.length - 1] = entry;
	list.sort((a, b) => b.score - a.score);
}


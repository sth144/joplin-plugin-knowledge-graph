/**
 * Semantic search over the stored vectors.
 *
 * Scoring is brute force over one contiguous matrix. For libraries of this size
 * that is a few milliseconds, so an approximate index would add moving parts and
 * recall loss for no measurable gain.
 *
 * Pure vector search has one well-known weakness: exact strings. A query like
 * "APPS-1234" is a near-meaningless token to an embedding model, and notes
 * mentioning it will not rank first. So results are optionally fused with
 * Joplin's own keyword search using reciprocal rank fusion, which combines
 * rankings without needing the two scoring scales to be comparable.
 */

import { SearchSettings } from '../settings';
import { VectorIndex } from './store';

export interface SearchHit {
	noteId: string;
	title: string;
	score: number;
	/** The passage that matched best, for display. */
	snippet: string;
}

/**
 * Rank-fusion constant.
 *
 * The RRF paper's 60 is tuned for TREC runs of thousands of results. Over a list
 * of a few dozen it flattens the spread between first and last place to about
 * 1.2x, which the keyword/semantic weight ratio then swamps: no keyword-only hit
 * can outscore even the worst semantic one, so blending quietly does nothing and
 * the search is purely semantic whatever the blend is set to. A small constant
 * keeps the spread wide enough for the weight to behave as documented.
 */
const RRF_K = 1;

const SNIPPET_CHARS = 220;

/**
 * Rank notes by similarity to a query vector.
 *
 * A note scores as its best-matching chunk rather than its average: a long note
 * with one highly relevant paragraph should beat a note that is vaguely on-topic
 * throughout.
 */
export function rankBySimilarity(
	index: VectorIndex,
	query: Float32Array,
	limit: number,
): SearchHit[] {
	const { dims, matrix, chunkNote, noteIds, noteTitles, chunkTexts } = index;
	const bestScore = new Float32Array(noteIds.length).fill(-1);
	const bestChunk = new Int32Array(noteIds.length).fill(-1);

	const chunkCount = chunkNote.length;
	for (let chunk = 0; chunk < chunkCount; chunk++) {
		const at = chunk * dims;
		let sum = 0;
		for (let d = 0; d < dims; d++) sum += matrix[at + d] * query[d];

		const note = chunkNote[chunk];
		if (sum > bestScore[note]) {
			bestScore[note] = sum;
			bestChunk[note] = chunk;
		}
	}

	const hits: SearchHit[] = [];
	for (let note = 0; note < noteIds.length; note++) {
		if (bestChunk[note] < 0) continue;
		hits.push({
			noteId: noteIds[note],
			title: noteTitles[note] || '(untitled)',
			score: bestScore[note],
			snippet: makeSnippet(chunkTexts[bestChunk[note]], noteTitles[note]),
		});
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

/**
 * Blend semantic hits with a keyword-ranked list of note ids.
 *
 * `weight` is how much the keyword ranking counts: 0 returns the semantic
 * ranking untouched, 1 leans almost entirely on keywords.
 */
export function fuseWithKeywords(
	semantic: SearchHit[],
	keywordNoteIds: string[],
	weight: number,
	limit: number,
): SearchHit[] {
	if (weight <= 0 || keywordNoteIds.length === 0) return semantic.slice(0, limit);

	const fused = new Map<string, { hit: SearchHit; score: number }>();

	semantic.forEach((hit, rank) => {
		fused.set(hit.noteId, {
			hit,
			score: (1 - weight) / (RRF_K + rank + 1),
		});
	});

	keywordNoteIds.forEach((noteId, rank) => {
		const contribution = weight / (RRF_K + rank + 1);
		const existing = fused.get(noteId);
		if (existing) {
			existing.score += contribution;
			return;
		}
		// A keyword-only match has no vector score to show; surface it with the
		// rank-fusion score so it can still appear.
		fused.set(noteId, {
			hit: { noteId, title: '', score: 0, snippet: '' },
			score: contribution,
		});
	});

	return [...fused.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(entry => entry.hit);
}

export function applyMinScore(
	hits: SearchHit[],
	settings: SearchSettings,
): SearchHit[] {
	// With keyword blending on, a keyword-only hit legitimately has no vector
	// score, so the floor would drop exactly the results blending added.
	if (settings.keywordBlend > 0) return hits;
	return hits.filter(hit => hit.score >= settings.minScore);
}

/**
 * Trim a chunk down for display, dropping the title prefix the chunker added
 * so the snippet does not just repeat the result's own heading.
 */
function makeSnippet(chunkText: string, title: string): string {
	let text = chunkText;
	const prefix = title.trim() ? `${title.trim()}\n\n` : '';
	if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);

	text = text.replace(/\s+/g, ' ').trim();
	if (text.length <= SNIPPET_CHARS) return text;
	return `${text.slice(0, SNIPPET_CHARS).trimEnd()}…`;
}

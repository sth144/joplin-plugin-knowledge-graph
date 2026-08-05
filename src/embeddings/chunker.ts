/**
 * Splits notes into chunks small enough for the embedding model to read whole.
 *
 * The model truncates at a fixed token count, so a whole note embedded as one
 * string would silently lose everything past the first few hundred characters.
 * Chunking also improves retrieval: a long note about six topics produces six
 * focused vectors rather than one averaged, blurry one.
 *
 * Chunk size is configured in characters because that is what a user can reason
 * about, but characters do not bound tokens: measured against a real library,
 * 42% of 800-character chunks exceeded the model's 256-token window, because
 * code, URLs and tables tokenize at roughly three times the density of prose.
 * Everything past the window is dropped without warning. So a token budget is
 * enforced as a hard cap on top of the character target, splitting any chunk
 * that would not fit. Without it, a large share of the library is never indexed
 * and nothing surfaces the loss.
 */

import { stripMarkdown } from '../tfidf';
import { IndexSettings } from '../settings';
import { MODEL_MAX_TOKENS } from './backend';

export interface Chunk {
	index: number;
	text: string;
}

/** Counts tokens as the embedding model would. */
export type TokenCounter = (text: string) => number;

/**
 * Leave room for the two special tokens the model adds around every input, plus
 * a small margin so a borderline chunk is not lost to an off-by-one.
 */
const TOKEN_BUDGET = MODEL_MAX_TOKENS - 4;

/** Guard against pathological input defeating the recursive split. */
const MAX_SPLIT_DEPTH = 12;

/** Markdown ATX headings, used as preferred split points. */
const HEADING_PATTERN = /^#{1,6}\s+\S/;
const CODE_FENCE_PATTERN = /^\s*(```|~~~)/;

/**
 * Split a note into embeddable chunks.
 *
 * The title is prepended to every chunk: chunks are retrieved individually, and
 * a bare paragraph often loses the subject it was about ("it shipped Tuesday"
 * is far more useful attached to "Release 3.6 planning").
 */
export function chunkNote(
	title: string,
	body: string,
	settings: IndexSettings,
	countTokens?: TokenCounter,
): Chunk[] {
	const budget = Math.max(100, settings.chunkChars);
	const overlap = Math.max(0, Math.min(settings.chunkOverlap, budget - 50));

	// A single very long note can dominate a whole indexing run, so allow it to
	// be bounded. Truncation is at the end, keeping the note's opening.
	const source = settings.maxNoteChars > 0
		? body.slice(0, settings.maxNoteChars)
		: body;

	const prefix = title.trim() ? `${title.trim()}\n\n` : '';
	// The title is spent from the same budget, so reserve room for it rather
	// than letting long titles push the actual content past the token limit.
	const textBudget = Math.max(100, budget - prefix.length);

	const chunks: Chunk[] = [];
	for (const section of splitIntoSections(source)) {
		for (const piece of packSection(section, textBudget, overlap)) {
			if (piece.length < settings.minChunkChars) continue;
			for (const fitted of fitToTokenBudget(piece, prefix, countTokens)) {
				chunks.push({ index: chunks.length, text: `${prefix}${fitted}` });
			}
		}
	}

	// A note too short to produce a chunk still deserves a vector, so it can be
	// found and clustered. Fall back to the title plus whatever body exists.
	if (chunks.length === 0) {
		const tail = cleanText(source).slice(0, textBudget);
		for (const fitted of fitToTokenBudget(tail, prefix, countTokens)) {
			const fallback = `${prefix}${fitted}`.trim();
			if (fallback) chunks.push({ index: chunks.length, text: fallback });
		}
	}

	return chunks;
}

/**
 * Split a piece until every part fits the model's token window, prefix included.
 *
 * Splitting halfway on a word boundary rather than re-packing: by this point the
 * text has already resisted the structural split points, so there is no better
 * boundary available, and halving converges quickly.
 */
function fitToTokenBudget(
	piece: string,
	prefix: string,
	countTokens: TokenCounter | undefined,
	depth = 0,
): string[] {
	if (!countTokens || !piece) return piece ? [piece] : [];

	if (countTokens(`${prefix}${piece}`) <= TOKEN_BUDGET) return [piece];

	// Out of room to subdivide: hand back what we have rather than looping. The
	// model will truncate it, which is the same outcome as having no budget.
	if (depth >= MAX_SPLIT_DEPTH || piece.length < 40) return [piece];

	const [head, tail] = splitInHalf(piece);
	return [
		...fitToTokenBudget(head, prefix, countTokens, depth + 1),
		...fitToTokenBudget(tail, prefix, countTokens, depth + 1),
	];
}

/** Split near the midpoint, preferring a nearby word boundary. */
function splitInHalf(text: string): [string, string] {
	const middle = Math.floor(text.length / 2);
	const space = text.lastIndexOf(' ', middle);
	const at = space > text.length * 0.25 ? space : middle;
	return [text.slice(0, at).trim(), text.slice(at).trim()];
}

/**
 * Break the body at markdown headings, so chunks follow the note's own
 * structure instead of arbitrary character offsets where possible.
 */
function splitIntoSections(body: string): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	let inCodeFence = false;

	for (const line of body.split(/\r?\n/)) {
		if (CODE_FENCE_PATTERN.test(line)) inCodeFence = !inCodeFence;

		// A "#" inside a fenced block is a comment or a shell prompt, not a heading.
		if (!inCodeFence && HEADING_PATTERN.test(line) && current.length > 0) {
			sections.push(current.join('\n'));
			current = [];
		}
		current.push(line);
	}

	if (current.length > 0) sections.push(current.join('\n'));
	return sections;
}

/**
 * Pack one section into chunks of at most `budget` characters, preferring
 * paragraph boundaries and carrying `overlap` characters between chunks.
 */
function packSection(
	section: string,
	budget: number,
	overlap: number,
): string[] {
	const cleaned = cleanText(section);
	if (!cleaned) return [];
	if (cleaned.length <= budget) return [cleaned];

	const pieces: string[] = [];
	const paragraphs = cleaned.split(/\n{2,}/).filter(p => p.trim());
	let buffer = '';

	const flush = () => {
		if (!buffer.trim()) return;
		pieces.push(buffer.trim());
		buffer = overlap > 0 ? tailOf(buffer, overlap) : '';
	};

	for (const paragraph of paragraphs) {
		// A single paragraph over budget cannot be packed; split it directly.
		if (paragraph.length > budget) {
			flush();
			for (const slice of splitLongText(paragraph, budget, overlap)) {
				pieces.push(slice);
			}
			buffer = '';
			continue;
		}

		if (buffer && buffer.length + paragraph.length + 2 > budget) flush();
		buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
	}

	flush();
	return pieces.filter(p => p.length > 0);
}

/** Hard-split text that has no usable internal boundaries, on word edges. */
function splitLongText(
	text: string,
	budget: number,
	overlap: number,
): string[] {
	const pieces: string[] = [];
	const step = Math.max(1, budget - overlap);

	for (let start = 0; start < text.length; start += step) {
		let end = Math.min(text.length, start + budget);

		// Prefer a word boundary, but only if it does not shed too much text.
		if (end < text.length) {
			const space = text.lastIndexOf(' ', end);
			if (space > start + budget * 0.6) end = space;
		}

		const piece = text.slice(start, end).trim();
		if (piece) pieces.push(piece);
		if (end >= text.length) break;
	}

	return pieces;
}

/** Last `count` characters, resumed from a word boundary where possible. */
function tailOf(text: string, count: number): string {
	if (text.length <= count) return text;
	const tail = text.slice(text.length - count);
	const space = tail.indexOf(' ');
	return space > 0 ? tail.slice(space + 1) : tail;
}

/**
 * Strip markdown noise so the model sees prose. Reuses the graph's existing
 * stripper, then normalises whitespace while keeping paragraph breaks, which
 * `packSection` relies on as split points.
 */
function cleanText(text: string): string {
	return text
		.split(/\n{2,}/)
		.map(block => stripMarkdown(block).replace(/\s+/g, ' ').trim())
		.filter(block => block.length > 0)
		.join('\n\n');
}

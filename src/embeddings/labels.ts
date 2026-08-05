/**
 * Names clusters using the vocabulary of the notes inside them.
 *
 * No language model is involved — the plugin only ships an embedding model,
 * which turns text into vectors and cannot generate any. Instead a term is a
 * good name for a cluster when it is common *inside* that cluster and rare
 * outside it, which is the same intuition as TF-IDF applied with clusters in
 * place of documents. This is cheap, deterministic, and needs no extra data.
 */

import { tokenize } from '../tfidf';

/** Terms per label. Two or three reads as a topic; more reads as noise. */
const TERMS_PER_LABEL = 3;

/**
 * Progressively looser thresholds, tried in order until a cluster gets a name.
 *
 * `minNoteFraction` is how much of a cluster must use a term, so one verbose note
 * cannot name the whole group. `maxClusterFraction` rejects terms spread across
 * most clusters, which describe the library rather than any one cluster. Strict
 * values give the best names but leave broad clusters unnamed, so we relax rather
 * than fall back to "Cluster 4".
 */
const TIERS = [
	{ minNoteFraction: 0.25, maxClusterFraction: 0.5 },
	{ minNoteFraction: 0.12, maxClusterFraction: 0.65 },
	{ minNoteFraction: 0.05, maxClusterFraction: 0.8 },
];

/**
 * Dates and times dominate any library with a journal or meeting-notes habit,
 * and name a cluster no better than "note" would.
 */
const UNINFORMATIVE = new Set([
	'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept',
	'oct', 'nov', 'dec',
	'january', 'february', 'march', 'april', 'june', 'july', 'august',
	'september', 'october', 'november', 'december',
	'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
	'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
	'am', 'pm', 'today', 'yesterday', 'tomorrow',
	'note', 'notes', 'untitled',
]);

export interface LabelInput {
	/** Cluster id per note. */
	clusters: Int32Array;
	/** Text per note, already concatenated from title and body. */
	texts: string[];
}

/**
 * Derive a short label per cluster id. Clusters with no distinctive vocabulary
 * are omitted, and the caller falls back to a generic name.
 */
export function labelClusters(input: LabelInput): Record<string, string> {
	const { clusters, texts } = input;

	// Term -> cluster -> number of notes in that cluster containing the term.
	const noteCounts = new Map<string, Map<number, number>>();
	const clusterSizes = new Map<number, number>();

	for (let note = 0; note < texts.length; note++) {
		const cluster = clusters[note];
		if (cluster < 0) continue;

		clusterSizes.set(cluster, (clusterSizes.get(cluster) ?? 0) + 1);

		// Count each term once per note, so repetition within one note does not
		// let it outweigh a term used across many notes.
		for (const term of distinctTerms(texts[note])) {
			let perCluster = noteCounts.get(term);
			if (!perCluster) {
				perCluster = new Map<number, number>();
				noteCounts.set(term, perCluster);
			}
			perCluster.set(cluster, (perCluster.get(cluster) ?? 0) + 1);
		}
	}

	const clusterCount = clusterSizes.size;
	if (clusterCount === 0) return {};

	const labels: Record<string, string> = {};

	for (const tier of TIERS) {
		const remaining = [...clusterSizes.keys()].filter(id => !labels[String(id)]);
		if (remaining.length === 0) break;

		const scores = scoreTerms(
			noteCounts, clusterSizes, clusterCount, tier, new Set(remaining),
		);

		for (const [cluster, candidates] of scores) {
			candidates.sort((a, b) => (
				// Alphabetical tie-break keeps labels stable across runs.
				b.score - a.score || a.term.localeCompare(b.term)
			));

			const terms = candidates.slice(0, TERMS_PER_LABEL).map(c => c.term);
			if (terms.length === 0) continue;
			labels[String(cluster)] = terms.map(titleCase).join(' · ');
		}
	}

	return labels;
}

function scoreTerms(
	noteCounts: Map<string, Map<number, number>>,
	clusterSizes: Map<number, number>,
	clusterCount: number,
	tier: { minNoteFraction: number; maxClusterFraction: number },
	wanted: Set<number>,
): Map<number, Array<{ term: string; score: number }>> {
	const scores = new Map<number, Array<{ term: string; score: number }>>();

	for (const [term, perCluster] of noteCounts) {
		if (perCluster.size > Math.max(1, clusterCount * tier.maxClusterFraction)) {
			continue;
		}

		const inverseClusterFrequency = Math.log(clusterCount / perCluster.size);

		for (const [cluster, notes] of perCluster) {
			if (!wanted.has(cluster)) continue;

			const size = clusterSizes.get(cluster) ?? 1;
			const coverage = notes / size;
			if (coverage < tier.minNoteFraction) continue;

			if (!scores.has(cluster)) scores.set(cluster, []);
			scores.get(cluster)!.push({
				term,
				score: coverage * inverseClusterFrequency,
			});
		}
	}

	return scores;
}

function distinctTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const token of tokenize(text)) {
		if (UNINFORMATIVE.has(token) || !isWordLike(token)) continue;
		terms.add(token);
	}
	return terms;
}

/**
 * Reject fragments that read as noise in a label. The shared tokenizer keeps
 * hyphens, which is right for content but lets command-line flags and measurement
 * fragments through — real libraries produced labels like "-dart · --port ·
 * 8-30ms". Product names with a digit or two ("l7synapse") must still pass, so the
 * test is on the balance of letters to digits rather than on digits at all.
 */
function isWordLike(token: string): boolean {
	if (token.startsWith('-') || token.endsWith('-') || token.includes('--')) {
		return false;
	}

	let letters = 0;
	let digits = 0;
	for (const character of token) {
		if (character >= 'a' && character <= 'z') letters++;
		else if (character >= '0' && character <= '9') digits++;
	}

	return letters >= 3 && letters > digits;
}

function titleCase(term: string): string {
	return term.charAt(0).toUpperCase() + term.slice(1);
}

/**
 * Produces the semantic view of the graph from the stored index.
 *
 * Sits between the indexer (which knows about vectors) and the graph builder
 * (which knows about notes and nodes), converting note ordinals back into note
 * ids so neither has to know about the other's representation.
 */

import { SemanticOverlay } from '../graph-builder';
import { clusterSettings } from '../settings';
import { Indexer } from './indexer';
import { labelClusters } from './labels';
import { buildSemanticGraph } from './similarity';

/**
 * Build the overlay, or return null when there is no usable index — in which
 * case the graph falls back to exactly its previous behaviour.
 */
export async function buildOverlay(
	indexer: Indexer,
	report: (message: string) => void = () => {},
): Promise<SemanticOverlay | null> {
	const index = await indexer.vectorIndex();
	if (index.noteIds.length < 2) return null;

	const settings = await clusterSettings();
	const graph = buildSemanticGraph(index, settings, report);

	const clusters: Record<string, number> = {};
	for (let note = 0; note < index.noteIds.length; note++) {
		clusters[index.noteIds[note]] = graph.clusters[note];
	}

	return {
		edges: graph.edges.map(edge => ({
			a: index.noteIds[edge.i],
			b: index.noteIds[edge.j],
			score: edge.score,
		})),
		clusters,
		clusterLabels: graph.clusterCount > 0
			? namesFor(index, graph.clusters)
			: {},
		separation: settings.separation,
	};
}

/**
 * Name each cluster from its notes' text. Titles are repeated so they weigh more
 * than body text — a title is the closest thing a note has to a topic label.
 */
function namesFor(
	index: { noteIds: string[]; noteTitles: string[]; chunkTexts: string[]; chunkNote: Int32Array },
	clusters: Int32Array,
): Record<string, string> {
	const texts = index.noteIds.map((_, note) => {
		const title = index.noteTitles[note] ?? '';
		return `${title} ${title} `;
	});

	for (let chunk = 0; chunk < index.chunkNote.length; chunk++) {
		texts[index.chunkNote[chunk]] += `${index.chunkTexts[chunk]} `;
	}

	const labels = labelClusters({ clusters, texts });

	// Give every cluster a name, so the legend never shows a blank entry.
	for (let i = 0; i < clusters.length; i++) {
		const key = String(clusters[i]);
		if (clusters[i] >= 0 && !labels[key]) labels[key] = `Cluster ${clusters[i] + 1}`;
	}

	return labels;
}

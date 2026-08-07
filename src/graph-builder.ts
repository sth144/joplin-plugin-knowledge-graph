/**
 * Fetches all notes/folders from Joplin and builds the graph data structure.
 * Runs in the plugin process (has access to joplin.data).
 */

import joplin from 'api';
import { PALETTE } from './palette';
import { computeSimilarityEdges, stripMarkdown } from './tfidf';

const SIMILARITY_THRESHOLD = 0.15;
// Cap the raw markdown embedded per node so the dialog payload stays bounded.
// The pinned popup shows this; the "Open note" link reaches the full note.
const MAX_BODY_CHARS = 4000;
const JIRA_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;
const INTERNAL_LINK_PATTERN = /\[.*?\]\(:\/([a-f0-9]{32})\)/g;


interface JoplinNote {
	id: string;
	title: string;
	body: string;
	parent_id: string;
	user_created_time: number;
	user_updated_time: number;
}

interface JoplinFolder {
	id: string;
	title: string;
	parent_id: string;
}

export interface GraphNode {
	id: number;
	label: string;
	group: string;
	color: string;
	size: number;
	notebook: string;
	preview: string;
	noteId: string;
	body: string;
	/** Epoch ms, as set by the user rather than by sync. */
	created: number;
	updated: number;
}

export interface GraphEdge {
	from: number;
	to: number;
	weight: number;
	color: string;
	title?: string;
	reasons: EdgeReason[];
}

export type EdgeReasonType = 'similarity' | 'ticket' | 'link' | 'semantic';

export interface EdgeReason {
	type: EdgeReasonType;
	label: string;
	detail?: string;
	weight: number;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	folderColors: Record<string, string>;
	/**
	 * Edges from embedding similarity, kept separate from `edges` so the webview
	 * can switch between the two views without another round trip. Empty when no
	 * semantic index has been built.
	 */
	semanticEdges: GraphEdge[];
	/** Cluster id per node, parallel to `nodes`. -1 when unclustered. */
	clusters: number[];
	clusterColors: Record<string, string>;
	clusterLabels: Record<string, string>;
	separation: number;
}

/**
 * Semantic relationships supplied by the embedding index, keyed by note id so
 * this module stays independent of how vectors are stored.
 */
export interface SemanticOverlay {
	edges: Array<{ a: string; b: string; score: number }>;
	clusters: Record<string, number>;
	/** Inferred name per cluster id. Empty when clustering is off. */
	clusterLabels: Record<string, string>;
	/** Layout separation strength, passed through to the webview. */
	separation: number;
}

const EDGE_COLORS: Record<EdgeReasonType, string> = {
	similarity: 'rgba(150,150,150,0.3)',
	ticket: 'rgba(255,165,0,0.5)',
	link: 'rgba(100,100,255,0.6)',
	semantic: 'rgba(118,183,178,0.45)',
};

const EDGE_PRIORITY: Record<EdgeReasonType, number> = {
	similarity: 1,
	semantic: 2,
	ticket: 3,
	link: 4,
};

/** Fetch all items from a paginated Joplin data endpoint. */
export async function fetchAll<T>(path: string[], fields: string[]): Promise<T[]> {
	const items: T[] = [];
	let page = 1;
	let hasMore = true;

	while (hasMore) {
		const result = await joplin.data.get(path, { fields, page, limit: 100 });
		items.push(...result.items);
		hasMore = result.has_more;
		page++;
	}

	return items;
}

/** Build a breadcrumb path like "Areas / Daybook" for a folder. */
function resolveFolderPath(
	folderId: string,
	folderMap: Map<string, JoplinFolder>,
): string {
	const parts: string[] = [];
	let current = folderId;
	const seen = new Set<string>();

	while (current && folderMap.has(current) && !seen.has(current)) {
		seen.add(current);
		const folder = folderMap.get(current)!;
		parts.push(folder.title);
		current = folder.parent_id;
	}

	return parts.length > 0 ? parts.reverse().join(' / ') : 'Uncategorized';
}

/** Extract Jira-style ticket keys from text. */
function extractJiraKeys(text: string): Set<string> {
	const keys = new Set<string>();
	let match: RegExpExecArray | null;
	JIRA_PATTERN.lastIndex = 0;
	while ((match = JIRA_PATTERN.exec(text)) !== null) {
		keys.add(match[1]);
	}
	return keys;
}

/** Extract internal Joplin link target IDs. */
function extractInternalLinks(text: string): Set<string> {
	const ids = new Set<string>();
	let match: RegExpExecArray | null;
	INTERNAL_LINK_PATTERN.lastIndex = 0;
	while ((match = INTERNAL_LINK_PATTERN.exec(text)) !== null) {
		ids.add(match[1]);
	}
	return ids;
}

/** Add an edge or strengthen an existing one. */
function addOrMergeEdge(
	edgeMap: Map<string, GraphEdge>,
	from: number,
	to: number,
	reason: EdgeReason,
): void {
	const key = `${Math.min(from, to)}-${Math.max(from, to)}`;
	const existing = edgeMap.get(key);
	if (existing) {
		existing.weight += reason.weight;
		const existingReason = existing.reasons.find(
			item => item.type === reason.type && item.detail === reason.detail,
		);
		if (existingReason) {
			existingReason.weight += reason.weight;
		} else {
			existing.reasons.push(reason);
		}
		existing.color = pickEdgeColor(existing.reasons);
		existing.title = summarizeReasons(existing.reasons);
	} else {
		edgeMap.set(key, {
			from,
			to,
			weight: reason.weight,
			color: EDGE_COLORS[reason.type],
			title: summarizeReasons([reason]),
			reasons: [reason],
		});
	}
}

function pickEdgeColor(reasons: EdgeReason[]): string {
	let strongest = reasons[0];
	for (const reason of reasons) {
		if (EDGE_PRIORITY[reason.type] > EDGE_PRIORITY[strongest.type]) {
			strongest = reason;
		}
	}
	return EDGE_COLORS[strongest.type];
}

function summarizeReasons(reasons: EdgeReason[]): string {
	const groups = new Map<EdgeReasonType, EdgeReason[]>();
	for (const reason of reasons) {
		if (!groups.has(reason.type)) groups.set(reason.type, []);
		groups.get(reason.type)!.push(reason);
	}

	const parts: string[] = [];
	const similarity = groups.get('similarity')?.[0];
	if (similarity) parts.push(`Content similarity ${similarity.weight.toFixed(2)}`);

	const semantic = groups.get('semantic')?.[0];
	if (semantic) parts.push(`Semantic similarity ${semantic.weight.toFixed(2)}`);

	const tickets = groups.get('ticket') || [];
	if (tickets.length) {
		parts.push(`Shared tickets: ${tickets.map(item => item.detail).join(', ')}`);
	}

	const links = groups.get('link') || [];
	if (links.length) parts.push('Internal Joplin link');

	return parts.join(' + ');
}

/**
 * Fetch all notes and folders, compute similarities, and return graph data.
 * Sends progress messages via the provided callback.
 */
export async function buildGraphData(
	onProgress?: (msg: string) => void,
	semantic?: SemanticOverlay | null,
): Promise<GraphData> {
	const report = onProgress || (() => {});

	report('Fetching folders...');
	const folders = await fetchAll<JoplinFolder>(
		['folders'],
		['id', 'title', 'parent_id'],
	);
	const folderMap = new Map(folders.map(f => [f.id, f]));

	report('Fetching notes...');
	const notes = await fetchAll<JoplinNote>(
		['notes'],
		['id', 'title', 'body', 'parent_id', 'user_created_time', 'user_updated_time'],
	);
	report(`Loaded ${notes.length} notes in ${folders.length} folders`);

	// Assign folder colors
	const folderPaths = [
		...new Set(notes.map(n => resolveFolderPath(n.parent_id, folderMap))),
	].sort();
	const folderColors: Record<string, string> = {};
	folderPaths.forEach((path, i) => {
		folderColors[path] = PALETTE[i % PALETTE.length];
	});

	// Build nodes
	const graphNodes: GraphNode[] = notes.map((note, idx) => {
		const folderPath = resolveFolderPath(note.parent_id, folderMap);
		const rawBody = note.body || '';
		const preview = stripMarkdown(rawBody.slice(0, 300));
		const body =
			rawBody.length > MAX_BODY_CHARS
				? `${rawBody.slice(0, MAX_BODY_CHARS)}\n\n…`
				: rawBody;
		return {
			id: idx,
			label: note.title || '(untitled)',
			group: folderPath,
			color: folderColors[folderPath],
			size: Math.max(8, Math.min(25, rawBody.length / 500)),
			notebook: folderPath,
			preview,
			noteId: note.id,
			body,
			created: note.user_created_time ?? 0,
			updated: note.user_updated_time ?? 0,
		};
	});

	// Build edges
	const edgeMap = new Map<string, GraphEdge>();

	// 1. Content similarity
	report('Computing content similarity...');
	const documents = notes.map(n => n.body || '');
	const simEdges = computeSimilarityEdges(documents, SIMILARITY_THRESHOLD);
	for (const { i, j, score } of simEdges) {
		addOrMergeEdge(edgeMap, i, j, {
			type: 'similarity',
			label: 'Content similarity',
			detail: score.toFixed(2),
			weight: score,
		});
	}
	report(`Found ${simEdges.length} similarity edges`);

	// 2. Shared Jira ticket references
	report('Extracting shared references...');
	const ticketToNotes = new Map<string, number[]>();
	notes.forEach((note, idx) => {
		for (const key of extractJiraKeys(note.body || '')) {
			if (!ticketToNotes.has(key)) ticketToNotes.set(key, []);
			ticketToNotes.get(key)!.push(idx);
		}
	});
	for (const [key, indices] of ticketToNotes) {
		for (let a = 0; a < indices.length; a++) {
			for (let b = a + 1; b < indices.length; b++) {
				addOrMergeEdge(
					edgeMap, indices[a], indices[b], {
						type: 'ticket',
						label: 'Shared ticket',
						detail: key,
						weight: 0.3,
					},
				);
			}
		}
	}

	// 3. Internal links
	const idToIdx = new Map(notes.map((n, idx) => [n.id, idx]));
	for (let idx = 0; idx < notes.length; idx++) {
		for (const targetId of extractInternalLinks(notes[idx].body || '')) {
			const targetIdx = idToIdx.get(targetId);
			if (targetIdx !== undefined) {
				addOrMergeEdge(edgeMap, idx, targetIdx, {
					type: 'link',
					label: 'Internal link',
					weight: 0.5,
				});
			}
		}
	}

	const graphEdges = [...edgeMap.values()];

	// 4. Semantic view, when an embedding index exists. Built as a separate edge
	// set rather than merged in, so the two views stay independently selectable.
	const overlay = buildSemanticView(idToIdx, graphNodes.length, semantic);
	report(
		`Graph complete: ${graphNodes.length} nodes, ${graphEdges.length} edges` +
		(overlay.semanticEdges.length
			? `, ${overlay.semanticEdges.length} semantic edges`
			: ''),
	);

	return {
		nodes: graphNodes,
		edges: graphEdges,
		folderColors,
		...overlay,
	};
}

/** Map a note-id-keyed semantic overlay onto node indices. */
function buildSemanticView(
	idToIdx: Map<string, number>,
	nodeCount: number,
	semantic: SemanticOverlay | null | undefined,
): Pick<GraphData, 'semanticEdges' | 'clusters' | 'clusterColors' | 'clusterLabels' | 'separation'> {
	const clusters = new Array<number>(nodeCount).fill(-1);
	if (!semantic) {
		return {
			semanticEdges: [],
			clusters,
			clusterColors: {},
			clusterLabels: {},
			separation: 0.6,
		};
	}

	const semanticMap = new Map<string, GraphEdge>();
	for (const edge of semantic.edges) {
		const from = idToIdx.get(edge.a);
		const to = idToIdx.get(edge.b);
		// A note indexed earlier may have been deleted since.
		if (from === undefined || to === undefined) continue;

		addOrMergeEdge(semanticMap, from, to, {
			type: 'semantic',
			label: 'Semantic similarity',
			detail: edge.score.toFixed(2),
			weight: edge.score,
		});
	}

	const clusterColors: Record<string, string> = {};
	for (const [noteId, cluster] of Object.entries(semantic.clusters)) {
		const idx = idToIdx.get(noteId);
		if (idx === undefined) continue;
		clusters[idx] = cluster;
		clusterColors[String(cluster)] = PALETTE[cluster % PALETTE.length];
	}

	return {
		semanticEdges: [...semanticMap.values()],
		clusters,
		clusterColors,
		clusterLabels: semantic.clusterLabels,
		separation: semantic.separation,
	};
}

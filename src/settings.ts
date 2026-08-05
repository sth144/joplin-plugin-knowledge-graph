/**
 * Plugin settings for the embedding index, graph clustering, and search.
 *
 * Split into three groups by when they take effect: changing an *indexing*
 * setting invalidates stored vectors and requires a rebuild (see
 * `indexFingerprint`), whereas clustering and search settings are applied at
 * query time and are free to change.
 */

import joplin from 'api';
import { SettingItemType } from 'api/types';
import { MODEL_MAX_TOKENS } from './embeddings/backend';

const SECTION = 'knowledgeGraph';

export const KEYS = {
	chunkChars: 'kg.chunkChars',
	chunkOverlap: 'kg.chunkOverlap',
	minChunkChars: 'kg.minChunkChars',
	maxNoteChars: 'kg.maxNoteChars',
	batchSize: 'kg.batchSize',
	neighbours: 'kg.neighbours',
	minCosine: 'kg.minCosine',
	mutualOnly: 'kg.mutualOnly',
	pooling: 'kg.pooling',
	clustering: 'kg.clustering',
	clusterCount: 'kg.clusterCount',
	separation: 'kg.separation',
	searchLimit: 'kg.searchLimit',
	searchMinScore: 'kg.searchMinScore',
	keywordBlend: 'kg.keywordBlend',
} as const;

/** Settings that affect the stored vectors themselves. */
export interface IndexSettings {
	chunkChars: number;
	chunkOverlap: number;
	minChunkChars: number;
	maxNoteChars: number;
	batchSize: number;
}

export type Pooling = 'max-chunk' | 'mean';

/** Settings applied when building graph edges from stored vectors. */
export interface ClusterSettings {
	neighbours: number;
	minCosine: number;
	mutualOnly: boolean;
	pooling: Pooling;
	/** Group notes with k-means, colouring and separating them by cluster. */
	clustering: boolean;
	/** Number of clusters; 0 chooses automatically. */
	clusterCount: number;
	/** How strongly the layout pulls clusters apart, 0..1. */
	separation: number;
}

/** Settings applied per search query. */
export interface SearchSettings {
	limit: number;
	minScore: number;
	keywordBlend: number;
}

export async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SECTION, {
		label: 'Knowledge Graph',
		iconName: 'fas fa-sitemap',
		description:
			'Semantic search and clustering run entirely on this machine, using an ' +
			'embedding model bundled with the plugin. Nothing is sent anywhere.',
	});

	await joplin.settings.registerSettings({
		[KEYS.chunkChars]: {
			value: 500,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 200,
			maximum: 4000,
			label: 'Chunk size (characters)',
			description:
				'Target size for each indexed passage. This is only a target: the ' +
				`model reads at most ${MODEL_MAX_TOKENS} tokens per passage, and ` +
				'anything longer is split again so no text is lost. Dense content ' +
				'like code and URLs uses far more tokens per character than prose, ' +
				'so a larger value mostly means more splitting rather than larger ' +
				'passages. Changing it requires rebuilding the index.',
		},
		[KEYS.chunkOverlap]: {
			value: 80,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 0,
			maximum: 1000,
			label: 'Chunk overlap (characters)',
			description:
				'How much text consecutive chunks share, so an idea spanning a chunk ' +
				'boundary is still captured whole somewhere. Requires a rebuild.',
		},
		[KEYS.minChunkChars]: {
			value: 80,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 0,
			maximum: 2000,
			label: 'Minimum chunk size (characters)',
			description:
				'Chunks shorter than this are skipped. Very short fragments tend to ' +
				'match everything and add noise. Requires a rebuild.',
		},
		[KEYS.maxNoteChars]: {
			value: 0,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 0,
			maximum: 2000000,
			label: 'Maximum characters indexed per note (0 = no limit)',
			description:
				'Indexing time is driven by total text, and a single very long note ' +
				'can account for most of it. Capping the amount read from each note ' +
				'trades completeness on your longest notes for a much faster build. ' +
				'Requires a rebuild.',
		},
		[KEYS.batchSize]: {
			value: 16,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 1,
			maximum: 128,
			label: 'Indexing batch size',
			description:
				'Chunks embedded per batch while indexing. Larger batches are ' +
				'slightly more efficient but make cancelling less responsive.',
		},

		[KEYS.neighbours]: {
			value: 6,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 1,
			maximum: 50,
			label: 'Semantic neighbours per note',
			description:
				'How many nearest notes each note may connect to in the semantic ' +
				'graph view. Higher values make a denser, harder-to-read graph.',
		},
		[KEYS.minCosine]: {
			value: 0.35,
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			label: 'Minimum similarity for a semantic edge',
			description:
				'Between 0 and 1. Embedding similarities bunch up in the 0.3-0.6 ' +
				'range, so small changes here noticeably change the graph.',
		},
		[KEYS.mutualOnly]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION,
			label: 'Only connect mutual neighbours',
			description:
				'Keep an edge only when both notes count each other among their ' +
				'nearest neighbours. Turning this off produces many more edges, ' +
				'often dominated by a few notes that are vaguely similar to everything.',
		},
		[KEYS.pooling]: {
			value: 'max-chunk',
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			isEnum: true,
			options: {
				'max-chunk': 'Best matching section',
				mean: 'Whole-note average',
			},
			label: 'How to compare notes',
			description:
				'"Best matching section" links notes that share any one strong theme, ' +
				'which works better for long or wide-ranging notes. "Whole-note ' +
				'average" compares overall gist and is blurrier for long notes.',
		},

		[KEYS.clustering]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION,
			label: 'Group notes into clusters',
			description:
				'Partition the library with k-means, then colour and separate notes ' +
				'by cluster in the semantic view. With this off, the view still shows ' +
				'semantic distance but keeps notebook colours.',
		},
		[KEYS.clusterCount]: {
			value: 0,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 0,
			maximum: 200,
			label: 'Number of clusters (0 = choose automatically)',
			description:
				'Automatic mode tries several counts and keeps the one with the ' +
				'tightest, best-separated grouping.',
		},
		[KEYS.separation]: {
			value: 0.6,
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			label: 'Cluster separation',
			description:
				'Between 0 and 1. How strongly the layout pulls clusters apart. At 0 ' +
				'the graph settles into a single ball; higher values spread clusters ' +
				'into visibly distinct groups.',
		},

		[KEYS.searchLimit]: {
			value: 20,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 1,
			maximum: 200,
			label: 'Search results shown',
		},
		[KEYS.searchMinScore]: {
			value: 0.25,
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			label: 'Minimum search score',
			description: 'Between 0 and 1. Results scoring below this are hidden.',
		},
		[KEYS.keywordBlend]: {
			value: 0.3,
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			label: 'Keyword search blend',
			description:
				'Between 0 and 1. How much to mix in Joplin\'s own keyword search. ' +
				'0 is pure meaning-based search, which is weaker at exact strings ' +
				'like ticket numbers. 1 leans mostly on keywords.',
		},
	});
}

export async function indexSettings(): Promise<IndexSettings> {
	return {
		chunkChars: await intValue(KEYS.chunkChars, 500),
		chunkOverlap: await intValue(KEYS.chunkOverlap, 80),
		minChunkChars: await intValue(KEYS.minChunkChars, 80),
		maxNoteChars: await intValue(KEYS.maxNoteChars, 0),
		batchSize: await intValue(KEYS.batchSize, 16),
	};
}

export async function clusterSettings(): Promise<ClusterSettings> {
	const pooling = await joplin.settings.value(KEYS.pooling);
	return {
		neighbours: await intValue(KEYS.neighbours, 6),
		minCosine: await unitValue(KEYS.minCosine, 0.35),
		mutualOnly: (await joplin.settings.value(KEYS.mutualOnly)) !== false,
		pooling: pooling === 'mean' ? 'mean' : 'max-chunk',
		clustering: (await joplin.settings.value(KEYS.clustering)) !== false,
		clusterCount: await intValue(KEYS.clusterCount, 0),
		separation: await unitValue(KEYS.separation, 0.6),
	};
}

export async function searchSettings(): Promise<SearchSettings> {
	return {
		limit: await intValue(KEYS.searchLimit, 20),
		minScore: await unitValue(KEYS.searchMinScore, 0.25),
		keywordBlend: await unitValue(KEYS.keywordBlend, 0.3),
	};
}

/**
 * Identifies the vectors currently in storage. When this changes, stored
 * vectors were produced by different settings and cannot be compared with new
 * ones, so the index needs rebuilding.
 */
export function indexFingerprint(
	modelId: string,
	settings: IndexSettings,
): string {
	return [
		modelId,
		`chunk=${settings.chunkChars}`,
		`overlap=${settings.chunkOverlap}`,
		`min=${settings.minChunkChars}`,
		`maxNote=${settings.maxNoteChars}`,
	].join('|');
}

async function intValue(key: string, fallback: number): Promise<number> {
	const raw = Number(await joplin.settings.value(key));
	return Number.isFinite(raw) ? Math.round(raw) : fallback;
}

/** Read a 0..1 setting, clamped. Stored as a string so users can type decimals. */
async function unitValue(key: string, fallback: number): Promise<number> {
	const raw = Number(await joplin.settings.value(key));
	if (!Number.isFinite(raw)) return fallback;
	return Math.min(1, Math.max(0, raw));
}

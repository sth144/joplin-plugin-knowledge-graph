/**
 * Serves the graph dialog's requests: reading and writing settings, driving the
 * indexer, recomputing the semantic view, and running searches.
 *
 * Everything the dialog can change is a real plugin setting, so a value set from
 * the graph shows up in Joplin's settings screen and in the search panel too.
 */

import joplin from 'api';
import { Indexer } from './embeddings/indexer';
import { buildOverlay } from './embeddings/overlay';
import {
	applyMinScore,
	fuseWithKeywords,
	rankBySimilarity,
} from './embeddings/search';
import {
	ConfigResponse,
	ConfigValues,
	GraphRequest,
	IndexStatusReport,
	SearchResponse,
	SemanticResponse,
} from './graph-messages';
import { KEYS, searchSettings } from './settings';
import { PALETTE } from './palette';

/** Extra candidates fetched before keyword fusion. */
const CANDIDATE_MULTIPLIER = 3;

export class GraphController {
	constructor(
		private indexer: Indexer,
		private reveal: () => Promise<void>,
		private log: (message: string) => void,
	) {}

	/** Returns the response the dialog webview receives, or null if unhandled. */
	async handle(request: GraphRequest): Promise<unknown> {
		switch (request?.type) {
			case 'link':
				await joplin.commands.execute('openItem', request.link);
				return null;
			case 'getConfig':
				return this.config();
			case 'setConfig':
				return this.setConfig(request.values);
			case 'indexStatus':
				return this.status();
			case 'buildIndex':
				return this.startBuild(Boolean(request.rebuild));
			case 'cancelIndex':
				this.indexer.cancel();
				return this.status();
			case 'refreshSemantic':
				return this.semantic();
			case 'semanticSearch':
				return this.search(request.text);
			default:
				return null;
		}
	}

	private async config(): Promise<ConfigResponse> {
		const values: ConfigValues = {};
		for (const key of Object.values(KEYS)) {
			values[key] = await joplin.settings.value(key);
		}
		return { values, status: await this.status() };
	}

	private async setConfig(values: ConfigValues): Promise<ConfigResponse> {
		const known = new Set<string>(Object.values(KEYS));

		for (const [key, value] of Object.entries(values ?? {})) {
			// Only write keys we own; a malformed message must not reach arbitrary
			// Joplin settings.
			if (!known.has(key)) continue;
			await joplin.settings.setValue(key, value);
		}

		// Chunking changes make stored vectors incomparable with new ones, so the
		// panel needs to know a rebuild is now pending.
		await this.indexer.checkFingerprint();
		return this.config();
	}

	private async status(): Promise<IndexStatusReport> {
		const status = await this.indexer.status();
		return {
			notes: status.notes,
			chunks: status.chunks,
			building: status.progress !== null,
			done: status.progress?.done ?? 0,
			total: status.progress?.total ?? 0,
			etaSeconds: status.progress?.etaSeconds ?? null,
			stale: status.stale,
		};
	}

	private async startBuild(rebuild: boolean): Promise<IndexStatusReport> {
		if (this.indexer.isRunning) return this.status();

		// The dialog is modal, so the panel cannot be seen while it is open; reveal
		// it anyway so progress is already visible once the dialog is closed.
		await this.reveal();

		this.indexer.buildAll({ rebuild }).catch(err => {
			this.log(`Indexing failed: ${describeError(err)}`);
		});

		return this.status();
	}

	private async semantic(): Promise<SemanticResponse> {
		try {
			const overlay = await buildOverlay(this.indexer, this.log);
			if (!overlay) return { payload: null, status: await this.status() };

			const clusterColors: Record<string, string> = {};
			for (const cluster of Object.values(overlay.clusters)) {
				if (cluster < 0) continue;
				clusterColors[String(cluster)] = PALETTE[cluster % PALETTE.length];
			}

			return {
				payload: { ...overlay, clusterColors },
				status: await this.status(),
			};
		} catch (err) {
			return {
				payload: null,
				status: await this.status(),
				error: describeError(err),
			};
		}
	}

	private async search(text: string): Promise<SearchResponse> {
		const query = (text ?? '').trim();
		if (!query) return { results: [] };

		try {
			const settings = await searchSettings();
			const index = await this.indexer.vectorIndex();
			if (index.noteIds.length === 0) return { results: [] };

			const vector = await this.indexer.embedQuery(query);
			const semantic = rankBySimilarity(
				index, vector, settings.limit * CANDIDATE_MULTIPLIER,
			);

			const keywordIds = settings.keywordBlend > 0
				? await keywordSearch(query, settings.limit * CANDIDATE_MULTIPLIER)
				: [];

			const fused = fuseWithKeywords(
				semantic, keywordIds, settings.keywordBlend, settings.limit,
			);

			return {
				results: applyMinScore(fused, settings).map(hit => ({
					noteId: hit.noteId,
					score: hit.score,
				})),
			};
		} catch (err) {
			return { results: [], error: describeError(err) };
		}
	}
}

async function keywordSearch(query: string, limit: number): Promise<string[]> {
	try {
		const result = await joplin.data.get(['search'], {
			query, fields: ['id'], limit,
		});
		return (result?.items ?? []).map((item: { id: string }) => item.id);
	} catch {
		return [];
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

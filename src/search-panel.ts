/**
 * The semantic search panel: a sidebar view with a query box, ranked results,
 * and a "related to this note" section.
 *
 * A panel rather than a dialog because search needs a live round trip per
 * keystroke, and because it should stay available while you read and edit.
 */

import joplin from 'api';
import { Indexer } from './embeddings/indexer';
import {
	SearchHit,
	applyMinScore,
	fuseWithKeywords,
	rankBySimilarity,
} from './embeddings/search';
import { searchSettings } from './settings';
import { PANEL_CSS } from './search-panel-css';

/** Extra candidates fetched before fusion, so keyword hits have room to rank. */
const CANDIDATE_MULTIPLIER = 3;

interface PanelMessage {
	type: string;
	text?: string;
	noteId?: string;
}

export class SearchPanel {
	private handle = '';
	private lastQuery = '';
	/**
	 * The webview announces itself once its script runs. Messages sent before
	 * that are silently dropped by Joplin (with a warning in the log), and the
	 * panel starts hidden so its webview may not be mounted for some time.
	 */
	private webviewReady = false;

	private constructor(private indexer: Indexer) {}

	static async create(indexer: Indexer): Promise<SearchPanel> {
		const panel = new SearchPanel(indexer);
		panel.handle = await joplin.views.panels.create('knowledge-graph-search');

		await joplin.views.panels.setHtml(panel.handle, initialHtml());
		await joplin.views.panels.addScript(
			panel.handle, './webview/search-panel.js',
		);
		await joplin.views.panels.onMessage(
			panel.handle, (message: PanelMessage) => panel.onMessage(message),
		);

		// Start hidden. A panel that opens itself on install is intrusive, and the
		// indexing commands reveal it when there is progress worth showing.
		await joplin.views.panels.show(panel.handle, false);

		// Push indexing progress as it happens rather than having the webview poll.
		indexer.onStatusChange(status => panel.send({ type: 'status', status }));

		await joplin.workspace.onNoteSelectionChange(() => {
			void panel.pushRelated();
		});

		return panel;
	}

	async toggle(): Promise<void> {
		const visible = await joplin.views.panels.visible(this.handle);
		await joplin.views.panels.show(this.handle, !visible);
		if (!visible) {
			await this.pushStatus();
			await this.pushRelated();
		}
	}

	/** Make the panel visible, so indexing progress has somewhere to appear. */
	async reveal(): Promise<void> {
		if (await joplin.views.panels.visible(this.handle)) return;
		await joplin.views.panels.show(this.handle, true);
		await this.pushStatus();
	}

	private async onMessage(message: PanelMessage): Promise<unknown> {
		switch (message.type) {
			case 'ready':
				this.webviewReady = true;
				await this.pushStatus();
				await this.pushRelated();
				return null;
			case 'query':
				await this.runQuery(message.text ?? '');
				return null;
			case 'open':
				if (message.noteId) {
					await joplin.commands.execute('openItem', `:/${message.noteId}`);
				}
				return null;
			case 'build':
				void this.build({ rebuild: false });
				return null;
			case 'rebuild':
				void this.build({ rebuild: true });
				return null;
			case 'cancel':
				this.indexer.cancel();
				return null;
			default:
				return null;
		}
	}

	private async build(options: { rebuild: boolean }): Promise<void> {
		try {
			await this.indexer.buildAll(options);
		} catch (err) {
			this.send({ type: 'error', message: describeError(err) });
		}
	}

	private async runQuery(text: string): Promise<void> {
		const query = text.trim();
		this.lastQuery = query;

		if (!query) {
			this.send({ type: 'results', results: [], query: '' });
			return;
		}

		try {
			const hits = await this.search(query);
			// A slower earlier query must not overwrite a newer one's results.
			if (this.lastQuery !== query) return;
			this.send({ type: 'results', results: hits, query });
		} catch (err) {
			this.send({ type: 'error', message: describeError(err) });
		}
	}

	private async search(query: string): Promise<SearchHit[]> {
		const settings = await searchSettings();
		const index = await this.indexer.vectorIndex();
		if (index.noteIds.length === 0) return [];

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

		return applyMinScore(
			await this.fillMissingTitles(fused, index), settings,
		);
	}

	/**
	 * Keyword-only hits arrive with no title, since they were never in the
	 * vector index. Look them up so results render consistently.
	 */
	private async fillMissingTitles(
		hits: SearchHit[],
		index: { noteIds: string[]; noteTitles: string[] },
	): Promise<SearchHit[]> {
		const titles = new Map(
			index.noteIds.map((id, i) => [id, index.noteTitles[i]]),
		);

		const resolved: SearchHit[] = [];
		for (const hit of hits) {
			if (hit.title) {
				resolved.push(hit);
				continue;
			}
			const known = titles.get(hit.noteId);
			resolved.push({
				...hit,
				title: known || await noteTitle(hit.noteId),
			});
		}
		return resolved;
	}

	/** Rank notes similar to the one currently open. */
	private async pushRelated(): Promise<void> {
		try {
			const note = await joplin.workspace.selectedNote();
			if (!note) {
				this.send({ type: 'related', results: [] });
				return;
			}

			const index = await this.indexer.vectorIndex();
			if (index.noteIds.length === 0) {
				this.send({ type: 'related', results: [] });
				return;
			}

			const settings = await searchSettings();
			const vector = await this.indexer.embedQuery(
				`${note.title ?? ''}\n\n${(note.body ?? '').slice(0, 1500)}`,
			);

			// Ask for one extra, since the open note matches itself perfectly.
			const hits = rankBySimilarity(index, vector, settings.limit + 1)
				.filter(hit => hit.noteId !== note.id)
				.slice(0, settings.limit);

			this.send({ type: 'related', results: hits, title: note.title ?? '' });
		} catch (err) {
			this.send({ type: 'error', message: describeError(err) });
		}
	}

	private async pushStatus(): Promise<void> {
		this.send({ type: 'status', status: await this.indexer.status() });
	}

	private send(message: unknown): void {
		if (!this.handle || !this.webviewReady) return;
		joplin.views.panels.postMessage(this.handle, message);
	}
}

async function keywordSearch(query: string, limit: number): Promise<string[]> {
	try {
		const result = await joplin.data.get(['search'], {
			query,
			fields: ['id'],
			limit,
		});
		return (result?.items ?? []).map((item: { id: string }) => item.id);
	} catch {
		// Joplin's search rejects some punctuation outright; a failed keyword
		// pass should just mean "no keyword signal", not a failed search.
		return [];
	}
}

async function noteTitle(noteId: string): Promise<string> {
	try {
		const note = await joplin.data.get(['notes', noteId], { fields: ['title'] });
		return note?.title || '(untitled)';
	} catch {
		return '(untitled)';
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function initialHtml(): string {
	return `
		<style>${PANEL_CSS}</style>
		<div id="kg-search">
			<div id="kg-index-status">
				<div id="kg-status-text">Loading…</div>
				<div id="kg-progress-track"><div id="kg-progress-bar"></div></div>
				<div id="kg-status-actions">
					<button type="button" id="kg-build">Build index</button>
					<button type="button" id="kg-rebuild">Rebuild</button>
					<button type="button" id="kg-cancel">Cancel</button>
				</div>
			</div>
			<input type="search" id="kg-query" placeholder="Search by meaning…" />
			<div id="kg-error"></div>
			<div id="kg-results-section">
				<div class="kg-heading" id="kg-results-heading">Results</div>
				<div id="kg-results"></div>
			</div>
			<div id="kg-related-section">
				<div class="kg-heading">Related to this note</div>
				<div id="kg-related"></div>
			</div>
			<div id="kg-settings-hint">
				Tune chunking, clustering and search under
				<b>Settings &rarr; Knowledge Graph</b>.
			</div>
		</div>
	`;
}

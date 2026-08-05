/**
 * Builds and maintains the embedding index in the background.
 *
 * The first build is the expensive part (minutes, for a large library), so it is
 * explicitly requested, reports progress, can be cancelled, and resumes where it
 * left off. After that, notes are re-embedded individually as they change.
 *
 * Indexing runs in the plugin process, which is separate from Joplin's UI
 * process — a batch of inference stalls only this plugin. Even so, we yield
 * between notes so note-change events and commands are serviced promptly.
 */

import joplin from 'api';
import { fetchAll } from '../graph-builder';
import {
	IndexSettings,
	indexFingerprint,
	indexSettings,
} from '../settings';
import { EmbeddingBackend, EMBEDDING_DIMS, MODEL_ID, createBackend } from './backend';
import { chunkNote } from './chunker';
import { assetPaths, readFile } from './host';
import { StoredChunk, VectorIndex, VectorStore } from './store';

interface IndexableNote {
	id: string;
	title: string;
	body: string;
	updated_time: number;
}

export interface IndexProgress {
	/** Notes embedded so far in this run. */
	done: number;
	total: number;
	etaSeconds: number | null;
}

export interface IndexStatus {
	notes: number;
	chunks: number;
	/** Non-null while a build is running. */
	progress: IndexProgress | null;
	stale: boolean;
}

export type StatusListener = (status: IndexStatus) => void;

const NOTE_FIELDS = ['id', 'title', 'body', 'updated_time'];

/** Notes re-embedded per drain pass before yielding, so edits stay responsive. */
const DIRTY_BATCH = 25;

export class Indexer {
	private backend: EmbeddingBackend | null = null;
	private cancelled = false;
	private running = false;
	private progress: IndexProgress | null = null;
	private stale = false;
	private listeners: StatusListener[] = [];
	private draining: Promise<void> | null = null;
	/** Vectors are loaded once and reused; invalidated on any write. */
	private cachedIndex: VectorIndex | null = null;

	private constructor(private store: VectorStore) {}

	static async create(): Promise<Indexer> {
		const store = await VectorStore.open(EMBEDDING_DIMS);
		const indexer = new Indexer(store);
		await indexer.checkFingerprint();
		return indexer;
	}

	onStatusChange(listener: StatusListener): void {
		this.listeners.push(listener);
	}

	get isRunning(): boolean {
		return this.running;
	}

	async status(): Promise<IndexStatus> {
		return {
			notes: await this.store.countNotes(),
			chunks: await this.store.countChunks(),
			progress: this.progress,
			stale: this.stale,
		};
	}

	cancel(): void {
		this.cancelled = true;
	}

	/**
	 * Note that chunking settings changed, so stored vectors no longer match
	 * what a new query would produce. Reported to the user rather than acted on
	 * — silently discarding a long build's output would be worse.
	 */
	async checkFingerprint(): Promise<void> {
		const settings = await indexSettings();
		const expected = indexFingerprint(MODEL_ID, settings);
		const stored = await this.store.getMeta('fingerprint');
		this.stale = stored !== null && stored !== expected;
		await this.notify();
	}

	/** Embed every note that is missing or out of date. */
	async buildAll(options: { rebuild?: boolean } = {}): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.cancelled = false;

		try {
			const settings = await indexSettings();
			this.cachedIndex = null;
			if (options.rebuild) {
				await this.store.clear();
				await this.store.setMeta(
					'fingerprint', indexFingerprint(MODEL_ID, settings),
				);
			} else {
				await this.store.reconcileFingerprint(
					indexFingerprint(MODEL_ID, settings),
				);
			}
			this.stale = false;

			const notes = await fetchAll<IndexableNote>(['notes'], NOTE_FIELDS);
			await this.removeDeleted(notes);

			const indexed = await this.store.indexedNotes();
			const pending = notes.filter(
				note => indexed.get(note.id) !== Number(note.updated_time),
			);

			await this.embedNotes(pending, settings);
		} finally {
			this.running = false;
			this.progress = null;
			await this.notify();
		}
	}

	/** Re-embed notes queued by change events. Safe to call at any time. */
	async drainDirty(): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = this.drainDirtyOnce().finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	async markDirty(noteId: string): Promise<void> {
		await this.store.markDirty(noteId);
	}

	/**
	 * All stored vectors, ready for scoring. Cached, because loading and
	 * unpacking them on every keystroke of a search would dominate the cost of
	 * the search itself.
	 */
	async vectorIndex(): Promise<VectorIndex> {
		if (!this.cachedIndex) this.cachedIndex = await this.store.loadIndex();
		return this.cachedIndex;
	}

	/** Embed a search query with the same model used for the index. */
	async embedQuery(text: string): Promise<Float32Array> {
		const backend = await this.ensureBackend();
		const [vector] = await backend.embed([text]);
		return vector;
	}

	async close(): Promise<void> {
		await this.store.close();
	}

	private async drainDirtyOnce(): Promise<void> {
		// A full build already walks every note; running both would double work.
		if (this.running) return;

		const settings = await indexSettings();
		let drained = 0;

		// Loop rather than handling a single batch: a sync can dirty hundreds of
		// notes at once, and stopping after one batch would leave the rest queued
		// until some unrelated event happened to trigger another pass.
		for (;;) {
			const ids = await this.store.dirtyNotes(DIRTY_BATCH);
			if (ids.length === 0) break;

			for (const id of ids) {
				const note = await this.fetchNote(id);
				if (!note) {
					// Deleted, or no longer readable.
					await this.store.deleteNote(id);
					this.cachedIndex = null;
					continue;
				}
				await this.embedNote(note, settings);
				drained++;
			}

			await yieldToEventLoop();
		}

		if (drained > 0) await this.notify();
	}

	/**
	 * Reconcile stored vectors against the library.
	 *
	 * Change events only arrive while the plugin is running, so notes edited on
	 * another device, or while this plugin was disabled, are invisible to the
	 * dirty queue and would never be indexed. This compares timestamps to find
	 * them. It fetches only ids and timestamps, not note bodies, so it is cheap
	 * enough to run at startup.
	 *
	 * Does nothing when no index exists — the first build is the user's decision,
	 * not something to start behind their back.
	 */
	async reconcile(): Promise<void> {
		if (this.running) return;

		const indexed = await this.store.indexedNotes();
		if (indexed.size === 0) return;

		const notes = await fetchAll<{ id: string; updated_time: number }>(
			['notes'], ['id', 'updated_time'],
		);

		const live = new Set<string>();
		let queued = 0;

		for (const note of notes) {
			live.add(note.id);
			if (indexed.get(note.id) !== Number(note.updated_time)) {
				await this.store.markDirty(note.id);
				queued++;
			}
		}

		for (const id of indexed.keys()) {
			if (!live.has(id)) {
				await this.store.deleteNote(id);
				this.cachedIndex = null;
			}
		}

		if (queued > 0) await this.drainDirty();
	}

	private async embedNotes(
		notes: IndexableNote[],
		settings: IndexSettings,
	): Promise<void> {
		this.progress = { done: 0, total: notes.length, etaSeconds: null };
		await this.notify();
		if (notes.length === 0) return;

		const startedAt = Date.now();
		let charsDone = 0;
		const charsTotal = notes.reduce((sum, n) => sum + (n.body?.length ?? 0), 0);

		for (let i = 0; i < notes.length; i++) {
			if (this.cancelled) break;

			await this.embedNote(notes[i], settings);
			charsDone += notes[i].body?.length ?? 0;

			this.progress = {
				done: i + 1,
				total: notes.length,
				etaSeconds: estimateEta(startedAt, charsDone, charsTotal),
			};

			// Report every note but only wake the UI periodically; the panel does
			// not need 60 updates a second.
			if (i % 5 === 0 || i === notes.length - 1) await this.notify();
			await yieldToEventLoop();
		}
	}

	private async embedNote(
		note: IndexableNote,
		settings: IndexSettings,
	): Promise<void> {
		// The backend is needed before chunking, not just to embed: the chunker
		// uses its tokenizer to guarantee no chunk exceeds the model's window.
		const backend = await this.ensureBackend();
		const chunks = chunkNote(
			note.title ?? '', note.body ?? '', settings, backend.countTokens,
		);

		if (chunks.length === 0) {
			await this.store.deleteNote(note.id);
			this.cachedIndex = null;
			return;
		}

		const stored: StoredChunk[] = [];

		// Batching measured no faster than one-at-a-time for chunks this size, so
		// the batch exists to bound memory, not to chase throughput.
		for (let start = 0; start < chunks.length; start += settings.batchSize) {
			const slice = chunks.slice(start, start + settings.batchSize);
			const vectors = await backend.embed(slice.map(c => c.text));
			for (let i = 0; i < slice.length; i++) {
				stored.push({ text: slice[i].text, vector: vectors[i] });
			}
		}

		await this.store.putNote(
			note.id,
			note.title ?? '',
			Number(note.updated_time),
			stored,
		);
		this.cachedIndex = null;
	}

	/** Drop stored vectors for notes that no longer exist. */
	private async removeDeleted(notes: IndexableNote[]): Promise<void> {
		const live = new Set(notes.map(n => n.id));
		const indexed = await this.store.indexedNotes();
		for (const id of indexed.keys()) {
			if (!live.has(id)) {
				await this.store.deleteNote(id);
				this.cachedIndex = null;
			}
		}
	}

	private async fetchNote(id: string): Promise<IndexableNote | null> {
		try {
			return await joplin.data.get(['notes', id], { fields: NOTE_FIELDS });
		} catch {
			return null;
		}
	}

	private async ensureBackend(): Promise<EmbeddingBackend> {
		if (!this.backend) {
			this.backend = await createBackend(await assetPaths(), readFile);
		}
		return this.backend;
	}

	private async notify(): Promise<void> {
		if (this.listeners.length === 0) return;
		const status = await this.status();
		for (const listener of this.listeners) listener(status);
	}
}

function estimateEta(
	startedAt: number,
	charsDone: number,
	charsTotal: number,
): number | null {
	if (charsDone <= 0 || charsTotal <= 0) return null;
	const elapsed = (Date.now() - startedAt) / 1000;
	const rate = charsDone / elapsed;
	if (rate <= 0) return null;
	return Math.max(0, Math.round((charsTotal - charsDone) / rate));
}

/**
 * Hand control back to the event loop. `setTimeout` rather than a resolved
 * promise: a microtask would not let queued I/O or plugin messages run.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

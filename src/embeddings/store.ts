/**
 * On-disk storage for note embeddings.
 *
 * SQLite (bundled with Joplin, reached via `joplin.require`) rather than a flat
 * file, so a long indexing run commits incrementally and survives being
 * cancelled or interrupted halfway.
 */

import joplin from 'api';

const DB_FILENAME = 'embeddings.sqlite';

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS notes (
		note_id TEXT PRIMARY KEY,
		title TEXT,
		updated_time INTEGER,
		n_chunks INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS chunks (
		note_id TEXT,
		chunk_idx INTEGER,
		text TEXT,
		vec BLOB,
		PRIMARY KEY (note_id, chunk_idx)
	)`,
	`CREATE TABLE IF NOT EXISTS dirty (
		note_id TEXT PRIMARY KEY
	)`,
];

const META_FINGERPRINT = 'fingerprint';
const META_DIMS = 'dims';

export interface StoredChunk {
	text: string;
	vector: Float32Array;
}

/** Vectors laid out for scoring: one contiguous matrix, chunk-major. */
export interface VectorIndex {
	dims: number;
	/** chunkCount x dims, row i is chunk i. */
	matrix: Float32Array;
	chunkTexts: string[];
	/** Note ordinal for each chunk, indexing into `noteIds`/`noteTitles`. */
	chunkNote: Int32Array;
	noteIds: string[];
	noteTitles: string[];
}

export class VectorStore {
	private constructor(private db: Database, readonly dims: number) {}

	static async open(dims: number): Promise<VectorStore> {
		const dir = await joplin.plugins.dataDir();
		const db = await openDatabase(`${dir}/${DB_FILENAME}`);
		for (const statement of SCHEMA) await db.run(statement);
		const store = new VectorStore(db, dims);
		await store.setMeta(META_DIMS, String(dims));
		return store;
	}

	async close(): Promise<void> {
		await this.db.close();
	}

	async getMeta(key: string): Promise<string | null> {
		const row = await this.db.get(
			'SELECT value FROM meta WHERE key = ?', [key],
		);
		return row ? String(row.value) : null;
	}

	async setMeta(key: string, value: string): Promise<void> {
		await this.db.run(
			'INSERT INTO meta (key, value) VALUES (?, ?) ' +
			'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
			[key, value],
		);
	}

	/**
	 * Check the stored vectors were built with the given settings, clearing them
	 * if not. Vectors from different chunking settings are not comparable, so
	 * mixing them would silently degrade every similarity score.
	 */
	async reconcileFingerprint(fingerprint: string): Promise<boolean> {
		const stored = await this.getMeta(META_FINGERPRINT);
		if (stored === fingerprint) return true;
		if (stored !== null) await this.clear();
		await this.setMeta(META_FINGERPRINT, fingerprint);
		return stored === null;
	}

	async clear(): Promise<void> {
		await this.db.run('DELETE FROM chunks');
		await this.db.run('DELETE FROM notes');
		await this.db.run('DELETE FROM dirty');
	}

	/** Note id to last-indexed `updated_time`, for skipping unchanged notes. */
	async indexedNotes(): Promise<Map<string, number>> {
		const rows = await this.db.all('SELECT note_id, updated_time FROM notes');
		return new Map(rows.map(r => [String(r.note_id), Number(r.updated_time)]));
	}

	async countChunks(): Promise<number> {
		const row = await this.db.get('SELECT COUNT(*) AS n FROM chunks');
		return row ? Number(row.n) : 0;
	}

	async countNotes(): Promise<number> {
		const row = await this.db.get('SELECT COUNT(*) AS n FROM notes');
		return row ? Number(row.n) : 0;
	}

	/** Replace all stored chunks for one note, in a single transaction. */
	async putNote(
		noteId: string,
		title: string,
		updatedTime: number,
		chunks: StoredChunk[],
	): Promise<void> {
		await this.db.run('BEGIN');
		try {
			await this.db.run('DELETE FROM chunks WHERE note_id = ?', [noteId]);
			for (let i = 0; i < chunks.length; i++) {
				await this.db.run(
					'INSERT INTO chunks (note_id, chunk_idx, text, vec) VALUES (?, ?, ?, ?)',
					[noteId, i, chunks[i].text, encodeVector(chunks[i].vector)],
				);
			}
			await this.db.run(
				'INSERT INTO notes (note_id, title, updated_time, n_chunks) ' +
				'VALUES (?, ?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET ' +
				'title = excluded.title, updated_time = excluded.updated_time, ' +
				'n_chunks = excluded.n_chunks',
				[noteId, title, updatedTime, chunks.length],
			);
			await this.db.run('DELETE FROM dirty WHERE note_id = ?', [noteId]);
			await this.db.run('COMMIT');
		} catch (err) {
			await this.db.run('ROLLBACK');
			throw err;
		}
	}

	async deleteNote(noteId: string): Promise<void> {
		await this.db.run('DELETE FROM chunks WHERE note_id = ?', [noteId]);
		await this.db.run('DELETE FROM notes WHERE note_id = ?', [noteId]);
		await this.db.run('DELETE FROM dirty WHERE note_id = ?', [noteId]);
	}

	async markDirty(noteId: string): Promise<void> {
		await this.db.run(
			'INSERT OR IGNORE INTO dirty (note_id) VALUES (?)', [noteId],
		);
	}

	async dirtyNotes(limit: number): Promise<string[]> {
		const rows = await this.db.all(
			'SELECT note_id FROM dirty LIMIT ?', [limit],
		);
		return rows.map(r => String(r.note_id));
	}

	async clearDirty(noteId: string): Promise<void> {
		await this.db.run('DELETE FROM dirty WHERE note_id = ?', [noteId]);
	}

	/**
	 * Load every vector into one contiguous matrix.
	 *
	 * Brute-force scoring over this is fast enough that an approximate index
	 * would be premature: a few thousand chunks scores in single-digit
	 * milliseconds, and the whole matrix is only a few MB.
	 */
	async loadIndex(): Promise<VectorIndex> {
		const rows = await this.db.all(
			'SELECT c.note_id, c.text, c.vec, n.title FROM chunks c ' +
			'JOIN notes n ON n.note_id = c.note_id ' +
			'ORDER BY c.note_id, c.chunk_idx',
		);

		const matrix = new Float32Array(rows.length * this.dims);
		const chunkTexts: string[] = [];
		const chunkNote = new Int32Array(rows.length);
		const noteIds: string[] = [];
		const noteTitles: string[] = [];
		const ordinals = new Map<string, number>();

		for (let i = 0; i < rows.length; i++) {
			const noteId = String(rows[i].note_id);
			let ordinal = ordinals.get(noteId);
			if (ordinal === undefined) {
				ordinal = noteIds.length;
				ordinals.set(noteId, ordinal);
				noteIds.push(noteId);
				noteTitles.push(String(rows[i].title ?? ''));
			}

			chunkNote[i] = ordinal;
			chunkTexts.push(String(rows[i].text ?? ''));
			matrix.set(decodeVector(rows[i].vec, this.dims), i * this.dims);
		}

		return {
			dims: this.dims,
			matrix,
			chunkTexts,
			chunkNote,
			noteIds,
			noteTitles,
		};
	}
}

/**
 * Vectors are stored as raw little-endian float32 bytes where a `Buffer` is
 * available, and base64 text otherwise. Sqlite columns are dynamically typed, so
 * both forms coexist in the same column and `decodeVector` handles either.
 */
function encodeVector(vector: Float32Array): unknown {
	const bytes = new Uint8Array(
		vector.buffer, vector.byteOffset, vector.byteLength,
	);
	const BufferCtor = (globalThis as { Buffer?: any }).Buffer;
	if (BufferCtor) return BufferCtor.from(bytes);
	return base64Encode(bytes);
}

function decodeVector(value: unknown, dims: number): Float32Array {
	const bytes = typeof value === 'string'
		? base64Decode(value)
		: new Uint8Array(value as ArrayBufferLike);

	// Copy rather than aliasing: the source may be a view into a pooled buffer,
	// and a Float32Array needs a 4-byte-aligned offset which is not guaranteed.
	const copy = new Uint8Array(dims * 4);
	copy.set(bytes.subarray(0, copy.length));
	return new Float32Array(copy.buffer);
}

function base64Encode(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Minimal promise wrapper over node-sqlite3's callback API. */
interface Database {
	run(sql: string, params?: unknown[]): Promise<void>;
	get(sql: string, params?: unknown[]): Promise<any>;
	all(sql: string, params?: unknown[]): Promise<any[]>;
	close(): Promise<void>;
}

function openDatabase(path: string): Promise<Database> {
	const sqlite3 = joplin.require('sqlite3');

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(path, (err: Error | null) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(wrapDatabase(db));
		});
	});
}

function wrapDatabase(db: any): Database {
	const call = <T>(method: string, sql: string, params: unknown[]): Promise<T> =>
		new Promise((resolve, reject) => {
			db[method](sql, params, (err: Error | null, result: T) => {
				if (err) reject(err);
				else resolve(result);
			});
		});

	return {
		run: (sql, params = []) => call<void>('run', sql, params).then(() => undefined),
		get: (sql, params = []) => call<any>('get', sql, params),
		all: (sql, params = []) => call<any[]>('all', sql, params).then(r => r ?? []),
		close: () => new Promise((resolve, reject) => {
			db.close((err: Error | null) => (err ? reject(err) : resolve()));
		}),
	};
}

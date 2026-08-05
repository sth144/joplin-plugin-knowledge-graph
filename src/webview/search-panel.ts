/**
 * Webview script for the semantic search panel.
 *
 * Unlike the graph dialog, panels have a working message channel, so this talks
 * to the plugin over webviewApi rather than reading data out of the DOM.
 *
 * All result text is inserted via textContent, never innerHTML: note titles and
 * snippets are arbitrary user content and would otherwise be an injection route.
 */

declare const webviewApi: {
	postMessage(message: unknown): Promise<unknown>;
	onMessage(handler: (event: { message: unknown }) => void): void;
};

interface SearchHit {
	noteId: string;
	title: string;
	score: number;
	snippet: string;
}

interface IndexProgress {
	done: number;
	total: number;
	etaSeconds: number | null;
}

interface IndexStatus {
	notes: number;
	chunks: number;
	progress: IndexProgress | null;
	stale: boolean;
}

type PluginMessage =
	| { type: 'status'; status: IndexStatus }
	| { type: 'results'; results: SearchHit[]; query: string }
	| { type: 'related'; results: SearchHit[]; title?: string }
	| { type: 'error'; message: string };

const QUERY_DEBOUNCE_MS = 250;

let queryTimer: ReturnType<typeof setTimeout> | null = null;

function element<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function init(): void {
	const query = element<HTMLInputElement>('kg-query');

	query.addEventListener('input', () => {
		if (queryTimer !== null) clearTimeout(queryTimer);
		queryTimer = setTimeout(() => {
			void webviewApi.postMessage({ type: 'query', text: query.value });
		}, QUERY_DEBOUNCE_MS);
	});

	element('kg-build').addEventListener('click', () => {
		void webviewApi.postMessage({ type: 'build' });
	});
	element('kg-rebuild').addEventListener('click', () => {
		void webviewApi.postMessage({ type: 'rebuild' });
	});
	element('kg-cancel').addEventListener('click', () => {
		void webviewApi.postMessage({ type: 'cancel' });
	});

	webviewApi.onMessage(event => handleMessage(event.message as PluginMessage));
	void webviewApi.postMessage({ type: 'ready' });
}

function handleMessage(message: PluginMessage): void {
	switch (message.type) {
		case 'status':
			renderStatus(message.status);
			return;
		case 'results':
			renderHits(element('kg-results'), message.results, message.query
				? 'No matches.'
				: 'Type to search by meaning.');
			return;
		case 'related':
			renderHits(element('kg-related'), message.results, 'Nothing similar found.');
			return;
		case 'error':
			showError(message.message);
			return;
	}
}

function renderStatus(status: IndexStatus): void {
	const text = element('kg-status-text');
	const track = element('kg-progress-track');
	const bar = element('kg-progress-bar');
	const building = status.progress !== null;

	text.textContent = statusText(status);
	text.classList.toggle('kg-stale', status.stale && !building);
	track.classList.toggle('kg-visible', building);

	if (status.progress && status.progress.total > 0) {
		const fraction = status.progress.done / status.progress.total;
		bar.style.width = `${Math.round(fraction * 100)}%`;
	}

	// Only offer the actions that make sense for the current state.
	element('kg-build').hidden = building || status.notes > 0;
	element('kg-rebuild').hidden = building || status.notes === 0;
	element('kg-cancel').hidden = !building;

	if (building) showError('');
}

function statusText(status: IndexStatus): string {
	const progress = status.progress;
	if (progress) {
		const eta = progress.etaSeconds === null
			? ''
			: `, ${formatDuration(progress.etaSeconds)} left`;
		return `Indexing ${progress.done} of ${progress.total} notes${eta}`;
	}

	if (status.notes === 0) {
		return 'No semantic index yet. Building it runs entirely on this machine, ' +
			'takes several minutes for a large library, and only needs doing once.';
	}

	const summary = `${status.notes} notes indexed (${status.chunks} passages)`;
	return status.stale
		? `${summary}. Settings changed since indexing — rebuild to apply them.`
		: summary;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes} min`;
}

function renderHits(
	container: HTMLElement,
	hits: SearchHit[],
	emptyMessage: string,
): void {
	container.textContent = '';

	if (hits.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'kg-empty';
		empty.textContent = emptyMessage;
		container.appendChild(empty);
		return;
	}

	for (const hit of hits) {
		container.appendChild(hitElement(hit));
	}
}

function hitElement(hit: SearchHit): HTMLElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'kg-hit';

	const top = document.createElement('div');
	top.className = 'kg-hit-top';

	const score = document.createElement('span');
	score.className = 'kg-hit-score';
	score.textContent = hit.score > 0 ? hit.score.toFixed(2) : '·';

	const title = document.createElement('span');
	title.className = 'kg-hit-title';
	title.textContent = hit.title || '(untitled)';

	top.appendChild(score);
	top.appendChild(title);
	button.appendChild(top);

	if (hit.snippet) {
		const snippet = document.createElement('div');
		snippet.className = 'kg-hit-snippet';
		snippet.textContent = hit.snippet;
		button.appendChild(snippet);
	}

	button.addEventListener('click', () => {
		void webviewApi.postMessage({ type: 'open', noteId: hit.noteId });
	});

	return button;
}

function showError(message: string): void {
	const box = element('kg-error');
	box.textContent = message;
	box.classList.toggle('kg-visible', message.length > 0);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}

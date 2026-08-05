/**
 * The semantic control panel inside the graph dialog: every embedding,
 * clustering and search parameter, plus indexing controls.
 *
 * Fields are declared as data and rendered in a loop rather than written out as
 * markup, so adding a parameter is one entry here instead of edits in three
 * places.
 *
 * Which action a change needs depends on what it affects:
 *   - indexing fields change the stored vectors, so they need a rebuild;
 *   - clustering fields are recomputed from existing vectors on demand;
 *   - search fields are read per query, so persisting them is enough.
 */

import {
	ConfigResponse,
	ConfigValues,
	IndexStatusReport,
	SemanticResponse,
} from '../graph-messages';

type Group = 'index' | 'cluster' | 'search';

interface Field {
	key: string;
	label: string;
	kind: 'int' | 'unit' | 'bool' | 'enum';
	group: Group;
	min?: number;
	max?: number;
	options?: Record<string, string>;
	help?: string;
}

const FIELDS: Field[] = [
	// Indexing — changing any of these requires re-embedding.
	{
		key: 'kg.chunkChars', label: 'Passage size (characters)', kind: 'int',
		group: 'index', min: 200, max: 4000,
		help: 'Target only. The model reads at most 256 tokens per passage and ' +
			'longer ones are split again, so nothing is lost.',
	},
	{
		key: 'kg.chunkOverlap', label: 'Passage overlap', kind: 'int',
		group: 'index', min: 0, max: 1000,
		help: 'Text shared between consecutive passages.',
	},
	{
		key: 'kg.minChunkChars', label: 'Minimum passage size', kind: 'int',
		group: 'index', min: 0, max: 2000,
		help: 'Shorter passages are skipped; tiny fragments match everything.',
	},
	{
		key: 'kg.maxNoteChars', label: 'Max characters per note (0 = all)', kind: 'int',
		group: 'index', min: 0, max: 2000000,
		help: 'Bounds indexing time when a few very long notes dominate it.',
	},
	{
		key: 'kg.batchSize', label: 'Batch size', kind: 'int',
		group: 'index', min: 1, max: 128,
		help: 'Passages embedded per batch. Bounds memory.',
	},

	// Clustering and edges — recomputed from the existing vectors.
	{
		key: 'kg.clustering', label: 'Group into clusters (k-means)', kind: 'bool',
		group: 'cluster',
		help: 'Off keeps notebook colours and shows semantic distance only.',
	},
	{
		key: 'kg.clusterCount', label: 'Clusters (0 = automatic)', kind: 'int',
		group: 'cluster', min: 0, max: 200,
		help: 'Automatic tries several counts and keeps the best-separated one.',
	},
	{
		key: 'kg.separation', label: 'Cluster separation', kind: 'unit',
		group: 'cluster',
		help: '0 settles into one ball; higher pulls clusters apart.',
	},
	{
		key: 'kg.neighbours', label: 'Neighbours per note', kind: 'int',
		group: 'cluster', min: 1, max: 50,
		help: 'How many nearest notes each note may link to.',
	},
	{
		key: 'kg.minCosine', label: 'Minimum similarity for an edge', kind: 'unit',
		group: 'cluster',
		help: 'Values bunch in 0.3-0.6, so small changes matter.',
	},
	{
		key: 'kg.mutualOnly', label: 'Mutual neighbours only', kind: 'bool',
		group: 'cluster',
		help: 'Require both notes to count each other as near.',
	},
	{
		key: 'kg.pooling', label: 'Compare notes by', kind: 'enum', group: 'cluster',
		options: { 'max-chunk': 'Best matching passage', mean: 'Whole-note average' },
	},

	// Search — read per query.
	{
		key: 'kg.searchLimit', label: 'Search results', kind: 'int',
		group: 'search', min: 1, max: 200,
	},
	{
		key: 'kg.searchMinScore', label: 'Minimum search score', kind: 'unit',
		group: 'search',
		help: 'Ignored while keyword blending is above 0.',
	},
	{
		key: 'kg.keywordBlend', label: 'Keyword blend', kind: 'unit', group: 'search',
		help: '0 is pure meaning-based. Raise it for exact strings like ticket ids.',
	},
];

const GROUP_TITLES: Record<Group, string> = {
	index: 'Vectorization',
	cluster: 'Clustering & edges',
	search: 'Search',
};

const POLL_INTERVAL_MS = 1200;
const WRITE_DEBOUNCE_MS = 400;

export interface ParamsPanelOptions {
	request(message: unknown): Promise<unknown>;
	/** Apply a freshly computed semantic view to the scene. */
	onSemantic(response: SemanticResponse): void;
	/** Report a message to the user. */
	onNotice(message: string): void;
}

export class ParamsPanel {
	private values: ConfigValues = {};
	private pending: ConfigValues = {};
	private writeTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
	private container: HTMLElement;

	constructor(private options: ParamsPanelOptions, container: HTMLElement) {
		this.container = container;
	}

	async mount(): Promise<void> {
		this.render();
		await this.load();
	}

	private async load(): Promise<void> {
		const response = await this.options.request({ type: 'getConfig' }) as
			ConfigResponse | null;
		if (!response) return;

		this.values = response.values;
		this.syncInputs();
		this.renderStatus(response.status);
	}

	private render(): void {
		this.container.textContent = '';
		this.container.appendChild(this.buildStatusBlock());

		for (const group of ['index', 'cluster', 'search'] as Group[]) {
			this.container.appendChild(this.buildGroup(group));
		}
	}

	private buildStatusBlock(): HTMLElement {
		const block = document.createElement('div');
		block.id = 'sem-status-block';

		const status = document.createElement('div');
		status.id = 'sem-status';
		status.textContent = 'Checking index…';
		block.appendChild(status);

		const track = document.createElement('div');
		track.id = 'sem-progress-track';
		const bar = document.createElement('div');
		bar.id = 'sem-progress-bar';
		track.appendChild(bar);
		block.appendChild(track);

		const actions = document.createElement('div');
		actions.id = 'sem-actions';
		actions.appendChild(this.actionButton('sem-build', 'Build index', async () => {
			await this.flush();
			this.renderStatus(await this.request<IndexStatusReport>({ type: 'buildIndex' }));
			this.startPolling();
		}));
		actions.appendChild(this.actionButton('sem-rebuild', 'Re-vectorize', async () => {
			await this.flush();
			this.renderStatus(await this.request<IndexStatusReport>({
				type: 'buildIndex', rebuild: true,
			}));
			this.startPolling();
		}));
		actions.appendChild(this.actionButton('sem-cancel', 'Cancel', async () => {
			this.renderStatus(await this.request<IndexStatusReport>({ type: 'cancelIndex' }));
		}));
		block.appendChild(actions);

		const recompute = this.actionButton(
			'sem-recompute', 'Recompute clusters', async () => {
				await this.flush();
				this.options.onNotice('Recomputing clusters…');
				const response = await this.request<SemanticResponse>({
					type: 'refreshSemantic',
				});
				this.options.onSemantic(response);
				this.renderStatus(response.status);
			},
		);
		recompute.id = 'sem-recompute';
		block.appendChild(recompute);

		return block;
	}

	private actionButton(
		id: string,
		label: string,
		onClick: () => Promise<void>,
	): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.id = id;
		button.className = 'sem-button';
		button.textContent = label;

		button.addEventListener('click', async () => {
			button.disabled = true;
			try {
				await onClick();
			} catch (err) {
				this.options.onNotice(String(err));
			} finally {
				button.disabled = false;
			}
		});

		return button;
	}

	private buildGroup(group: Group): HTMLElement {
		const section = document.createElement('details');
		section.className = 'sem-group';
		// Clustering is the one people reach for repeatedly; the others are setup.
		section.open = group === 'cluster';

		const summary = document.createElement('summary');
		summary.textContent = GROUP_TITLES[group];
		section.appendChild(summary);

		if (group === 'index') {
			const note = document.createElement('div');
			note.className = 'sem-group-note';
			note.textContent =
				'Changing these requires re-vectorizing, which re-reads every note.';
			section.appendChild(note);
		}

		for (const field of FIELDS.filter(f => f.group === group)) {
			section.appendChild(this.buildField(field));
		}

		return section;
	}

	private buildField(field: Field): HTMLElement {
		const row = document.createElement('div');
		row.className = `sem-field sem-field-${field.kind}`;

		const label = document.createElement('label');
		label.textContent = field.label;
		label.htmlFor = `sem-${field.key}`;
		if (field.help) label.title = field.help;

		const input = this.buildInput(field);
		input.id = `sem-${field.key}`;
		this.inputs.set(field.key, input);

		if (field.kind === 'bool') {
			row.appendChild(input);
			row.appendChild(label);
		} else {
			row.appendChild(label);
			row.appendChild(input);
		}

		return row;
	}

	private buildInput(field: Field): HTMLInputElement | HTMLSelectElement {
		if (field.kind === 'enum') {
			const select = document.createElement('select');
			for (const [value, text] of Object.entries(field.options ?? {})) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = text;
				select.appendChild(option);
			}
			select.addEventListener('change', () => this.stage(field, select.value));
			return select;
		}

		const input = document.createElement('input');

		if (field.kind === 'bool') {
			input.type = 'checkbox';
			input.addEventListener('change', () => this.stage(field, input.checked));
			return input;
		}

		if (field.kind === 'unit') {
			input.type = 'number';
			input.min = '0';
			input.max = '1';
			input.step = '0.05';
		} else {
			input.type = 'number';
			if (field.min !== undefined) input.min = String(field.min);
			if (field.max !== undefined) input.max = String(field.max);
			input.step = '1';
		}

		input.addEventListener('change', () => this.stage(field, input.value));
		return input;
	}

	/** Queue a value for writing, debounced so typing does not spam the plugin. */
	private stage(field: Field, raw: string | boolean): void {
		const value = field.kind === 'bool'
			? Boolean(raw)
			: field.kind === 'int'
				? clampInt(raw as string, field)
				: String(raw);

		this.pending[field.key] = value;

		if (this.writeTimer !== null) clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => {
			void this.flush().then(() => {
				if (field.group === 'index') {
					this.options.onNotice('Vectorization settings changed — re-vectorize to apply.');
				} else if (field.group === 'cluster') {
					this.options.onNotice('Clustering changed — use "Recompute clusters".');
				}
			});
		}, WRITE_DEBOUNCE_MS);
	}

	/** Write any staged values immediately. */
	private async flush(): Promise<void> {
		if (this.writeTimer !== null) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		if (Object.keys(this.pending).length === 0) return;

		const values = this.pending;
		this.pending = {};

		const response = await this.options.request({ type: 'setConfig', values }) as
			ConfigResponse | null;
		if (!response) return;

		this.values = response.values;
		this.syncInputs();
		this.renderStatus(response.status);
	}

	private syncInputs(): void {
		for (const [key, input] of this.inputs) {
			const value = this.values[key];
			if (value === undefined) continue;

			if (input instanceof HTMLInputElement && input.type === 'checkbox') {
				input.checked = value !== false;
			} else {
				input.value = String(value);
			}
		}
	}

	private renderStatus(status: IndexStatusReport | null | undefined): void {
		if (!status) return;

		const text = document.getElementById('sem-status');
		const track = document.getElementById('sem-progress-track');
		const bar = document.getElementById('sem-progress-bar');
		if (!text || !track || !bar) return;

		text.textContent = describeStatus(status);
		text.classList.toggle('sem-warn', status.stale && !status.building);
		track.classList.toggle('visible', status.building);

		if (status.building && status.total > 0) {
			bar.style.width = `${Math.round((status.done / status.total) * 100)}%`;
		}

		setHidden('sem-build', status.building || status.notes > 0);
		setHidden('sem-rebuild', status.building);
		setHidden('sem-cancel', !status.building);
		setHidden('sem-recompute', status.building || status.notes === 0);

		if (!status.building) this.stopPolling();
	}

	/**
	 * A modal dialog cannot be pushed to, so progress is polled while a build
	 * runs. Polling stops as soon as the build finishes.
	 */
	private startPolling(): void {
		if (this.pollTimer !== null) return;
		this.pollTimer = setInterval(() => {
			void this.request<IndexStatusReport>({ type: 'indexStatus' })
				.then(status => this.renderStatus(status));
		}, POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer === null) return;
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	private async request<T>(message: unknown): Promise<T> {
		return await this.options.request(message) as T;
	}
}

function clampInt(raw: string, field: Field): number {
	const parsed = Math.round(Number(raw));
	if (!Number.isFinite(parsed)) return field.min ?? 0;
	const low = field.min ?? Number.NEGATIVE_INFINITY;
	const high = field.max ?? Number.POSITIVE_INFINITY;
	return Math.min(high, Math.max(low, parsed));
}

function describeStatus(status: IndexStatusReport): string {
	if (status.building) {
		const eta = status.etaSeconds === null
			? ''
			: ` · ${formatDuration(status.etaSeconds)} left`;
		return `Vectorizing ${status.done}/${status.total} notes${eta}`;
	}

	if (status.notes === 0) {
		return 'No vectors yet. Building runs entirely on this machine and can ' +
			'take many minutes the first time.';
	}

	const summary = `${status.notes} notes vectorized · ${status.chunks} passages`;
	return status.stale
		? `${summary}. Vectorization settings changed — re-vectorize to apply.`
		: summary;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	return `${Math.round(seconds / 60)} min`;
}

function setHidden(id: string, hidden: boolean): void {
	const element = document.getElementById(id);
	if (element) element.hidden = hidden;
}

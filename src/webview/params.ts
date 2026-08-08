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
		help: 'How many nearest notes each note may link to — the main density ' +
			'control. Raise it for a denser graph with more paths to follow, lower ' +
			'it for a sparser one that is easier to read.',
	},
	{
		key: 'kg.minCosine', label: 'Minimum similarity for an edge', kind: 'unit',
		group: 'cluster',
		help: 'Edges weaker than this are dropped. Raise it to keep only strong ' +
			'matches, lower it to surface loose associations. Real values bunch ' +
			'between 0.3 and 0.6, so move it in steps of about 0.05.',
	},
	{
		key: 'kg.mutualOnly', label: 'Mutual neighbours only', kind: 'bool',
		group: 'cluster',
		help: 'Keep an edge only when both notes count each other as near. On, this ' +
			'removes hub notes that everything links to but which link back to ' +
			'nothing in particular.',
	},
	{
		key: 'kg.pooling', label: 'Compare notes by', kind: 'enum', group: 'cluster',
		options: { 'max-chunk': 'Best matching passage', mean: 'Whole-note average' },
		help: 'Best matching passage joins notes that share one specific topic, even ' +
			'if the rest is unrelated — good for long, mixed notes. Whole-note ' +
			'average compares overall subject matter instead.',
	},

	// Search — read per query.
	{
		key: 'kg.searchLimit', label: 'Search results', kind: 'int',
		group: 'search', min: 1, max: 200,
		help: 'How many notes the "Meaning" search keeps. Everything else in the ' +
			'graph is dimmed while a search is active.',
	},
	{
		key: 'kg.searchMinScore', label: 'Minimum search score', kind: 'unit',
		group: 'search',
		help: 'Hides weak matches. Ignored while Keyword blend is above 0, because a ' +
			'keyword-only hit has no similarity score to compare against.',
	},
	{
		key: 'kg.keywordBlend', label: 'Keyword blend', kind: 'unit', group: 'search',
		help: 'How much Joplin\'s own keyword search counts against meaning-based ' +
			'search. 0 is pure meaning, which is nearly blind to exact strings like ' +
			'ticket keys or file paths. Raise it towards 0.5 when you search for ' +
			'identifiers, lower it when you search by description.',
	},
];

const GROUP_TITLES: Record<Group, string> = {
	index: 'Vectorization',
	cluster: 'Semantic graph — clusters & edges',
	search: 'Meaning search',
};

/**
 * Shown under each group heading. These say what the group actually does and,
 * more importantly, what else you have to do for a change to become visible —
 * which is not guessable from the field names alone.
 */
const GROUP_NOTES: Record<Group, string> = {
	index: 'Changing these requires re-vectorizing, which re-reads every note.',
	cluster:
		'Builds the graph you browse in "Semantic distance" — switch to it with the ' +
		'toggle at the top of this panel. Edges join notes the model reads as ' +
		'similar, so these fields are how you widen or tighten what the graph ' +
		'connects. Press "Recompute clusters" above to apply a change.',
	search:
		'Applies to the search box above when it is set to "Meaning". That search is ' +
		'already hybrid: it blends similarity with Joplin\'s keyword search, so ' +
		'paraphrases and exact strings both match.',
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

		const note = document.createElement('div');
		note.className = 'sem-group-note';
		note.textContent = GROUP_NOTES[group];
		section.appendChild(note);

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

		// The badge sits beside the label rather than inside it: a click inside a
		// <label> is forwarded to the control, which would toggle the checkboxes.
		const labelWrap = document.createElement('span');
		labelWrap.className = 'sem-label';
		labelWrap.appendChild(label);
		const badge = buildHelpBadge(field);
		if (badge) labelWrap.appendChild(badge);

		const input = this.buildInput(field);
		input.id = `sem-${field.key}`;
		this.inputs.set(field.key, input);

		if (field.kind === 'bool') {
			row.appendChild(input);
			row.appendChild(labelWrap);
		} else {
			row.appendChild(labelWrap);
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

/** A "?" next to a label that reveals the field's help on hover or focus. */
function buildHelpBadge(field: Field): HTMLElement | null {
	if (!field.help) return null;

	const badge = document.createElement('span');
	badge.className = 'param-help';
	badge.textContent = '?';
	badge.tabIndex = 0;
	// Carries the text for screen readers, which cannot hover.
	badge.setAttribute('aria-label', `${field.label}: ${field.help}`);

	const show = (): void => showHelpTooltip(badge, field.help!);
	badge.addEventListener('mouseenter', show);
	badge.addEventListener('focus', show);
	badge.addEventListener('mouseleave', hideHelpTooltip);
	badge.addEventListener('blur', hideHelpTooltip);

	return badge;
}

let helpTooltip: HTMLElement | null = null;

function showHelpTooltip(anchor: HTMLElement, text: string): void {
	if (!helpTooltip) {
		helpTooltip = document.createElement('div');
		helpTooltip.id = 'param-tooltip';
		document.body.appendChild(helpTooltip);
	}

	helpTooltip.textContent = text;
	// Make it visible before measuring; it has display:none until then.
	helpTooltip.classList.add('visible');

	const rect = anchor.getBoundingClientRect();
	const { offsetWidth: width, offsetHeight: height } = helpTooltip;

	// Prefer the left side: the control panel is pinned to the right edge, so a
	// tooltip placed to the right of the badge would run off screen.
	let left = rect.left - width - 10;
	if (left < 8) left = Math.min(rect.right + 10, window.innerWidth - width - 8);

	const top = Math.max(
		8,
		Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - 8),
	);

	helpTooltip.style.left = `${left}px`;
	helpTooltip.style.top = `${top}px`;
}

function hideHelpTooltip(): void {
	helpTooltip?.classList.remove('visible');
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

import joplin from 'api';
import { ToastType, ToolbarButtonLocation } from 'api/types';
import { buildGraphData, GraphData } from './graph-builder';
import { Indexer } from './embeddings/indexer';
import { buildOverlay } from './embeddings/overlay';
import { runSelfTest } from './embeddings/selftest';
import { GraphController } from './graph-controller';
import { GraphRequest } from './graph-messages';
import { SearchPanel } from './search-panel';
import { registerSettings } from './settings';

const GRAPH_CSS = `
#graph-root {
	position: relative;
	width: 100%;
	height: 100vh;
	overflow: hidden;
	background: #1a1a2e;
	font-family: 'SF Mono', Menlo, Consolas, monospace;
}

#loading {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	text-align: center;
	z-index: 100;
	color: rgba(255, 255, 255, 0.8);
	font-size: 14px;
}

#loading.hidden {
	display: none;
}

#loading-spinner {
	width: 40px;
	height: 40px;
	border: 3px solid rgba(255, 255, 255, 0.15);
	border-top-color: #76b7b2;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
	margin: 0 auto 16px;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

#graph-container {
	width: 100%;
	height: 100%;
}

#graph-container canvas {
	display: block;
	width: 100%;
	height: 100%;
}

#hover-popup {
	display: none;
	position: fixed;
	background: rgba(10, 10, 30, 0.95);
	color: white;
	padding: 12px 14px;
	border-radius: 8px;
	max-width: 380px;
	z-index: 2000;
	pointer-events: none;
	border: 1px solid rgba(255, 255, 255, 0.15);
	backdrop-filter: blur(8px);
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
	font-size: 11px;
}

#hover-popup.pinned {
	pointer-events: auto;
	width: min(420px, calc(100vw - 32px));
	max-width: none;
}

#hover-title {
	font-weight: bold;
	font-size: 13px;
	margin-bottom: 6px;
	padding-right: 20px;
}

#hover-notebook {
	color: #76b7b2;
	font-size: 10px;
	margin-bottom: 8px;
}

#hover-body {
	color: rgba(255, 255, 255, 0.7);
	line-height: 1.4;
	white-space: pre-wrap;
	word-break: break-word;
}

#hover-popup.pinned #hover-body {
	white-space: normal;
	max-height: 45vh;
	overflow-y: auto;
	margin-top: 8px;
	padding-top: 8px;
	padding-right: 6px;
	border-top: 1px solid rgba(255, 255, 255, 0.12);
}

#hover-body h1, #hover-body h2, #hover-body h3,
#hover-body h4, #hover-body h5, #hover-body h6 {
	color: #fff;
	margin: 10px 0 6px;
	line-height: 1.25;
}

#hover-body h1 { font-size: 16px; }
#hover-body h2 { font-size: 15px; }
#hover-body h3 { font-size: 13px; }
#hover-body h4, #hover-body h5, #hover-body h6 { font-size: 12px; }

#hover-body p { margin: 0 0 8px; }
#hover-body ul, #hover-body ol { margin: 0 0 8px; padding-left: 18px; }
#hover-body li { margin: 2px 0; }
#hover-body a { color: #76b7b2; }

#hover-body code {
	background: rgba(255, 255, 255, 0.1);
	padding: 1px 4px;
	border-radius: 4px;
	font-family: 'SF Mono', Menlo, Consolas, monospace;
	font-size: 10px;
}

#hover-body pre {
	background: rgba(255, 255, 255, 0.07);
	padding: 8px 10px;
	border-radius: 6px;
	overflow-x: auto;
	margin: 0 0 8px;
}

#hover-body pre code {
	background: none;
	padding: 0;
}

#hover-body blockquote {
	margin: 0 0 8px;
	padding-left: 10px;
	border-left: 2px solid rgba(255, 255, 255, 0.25);
	color: rgba(255, 255, 255, 0.6);
}

#hover-body hr {
	border: none;
	border-top: 1px solid rgba(255, 255, 255, 0.15);
	margin: 8px 0;
}

#popup-close {
	display: none;
	position: absolute;
	top: 8px;
	right: 8px;
	width: 20px;
	height: 20px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: rgba(255, 255, 255, 0.08);
	color: rgba(255, 255, 255, 0.7);
	font-size: 15px;
	line-height: 18px;
	cursor: pointer;
}

#popup-close:hover {
	background: rgba(255, 255, 255, 0.16);
	color: #fff;
}

#popup-open {
	display: none;
	color: #76b7b2;
	font-size: 11px;
	text-decoration: none;
	margin-top: 10px;
	padding-top: 8px;
	border-top: 1px solid rgba(255, 255, 255, 0.12);
}

#popup-open:hover {
	text-decoration: underline;
}

#hover-popup.pinned #popup-close,
#hover-popup.pinned #popup-open {
	display: block;
}

#ctrl-panel {
	position: fixed;
	top: 10px;
	right: 10px;
	background: rgba(10, 10, 30, 0.95);
	color: white;
	padding: 14px;
	border-radius: 12px;
	font-size: 11px;
	max-height: 88vh;
	overflow-y: auto;
	z-index: 1000;
	width: min(360px, calc(100vw - 32px));
	border: 1px solid rgba(255, 255, 255, 0.15);
	backdrop-filter: blur(12px);
}

#search-wrapper {
	margin-bottom: 10px;
}

#layout-toggle {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 4px;
	margin-bottom: 8px;
	padding: 3px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
}

.view-button:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

#index-notice {
	display: none;
	margin: -4px 0 10px;
	padding: 8px 10px;
	border-radius: 8px;
	background: rgba(118, 183, 178, 0.12);
	border: 1px solid rgba(118, 183, 178, 0.35);
	font-size: 11px;
	line-height: 1.45;
	color: rgba(255, 255, 255, 0.82);
}

#index-notice.visible {
	display: block;
}

#index-notice-text {
	margin-bottom: 8px;
}

#build-index {
	width: 100%;
	padding: 6px 8px;
	border: 0;
	border-radius: 6px;
	background: rgba(118, 183, 178, 0.32);
	color: #fff;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

#build-index:hover {
	background: rgba(118, 183, 178, 0.48);
}

#build-index:disabled {
	opacity: 0.5;
	cursor: default;
}

#view-toggle {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 4px;
	margin-bottom: 10px;
	padding: 3px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
}

.view-button {
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: rgba(255, 255, 255, 0.72);
	font: inherit;
	font-size: 11px;
	padding: 6px 8px;
	cursor: pointer;
}

.view-button.active {
	background: rgba(118, 183, 178, 0.24);
	color: white;
}

#search-box {
	width: 100%;
	padding: 6px 8px;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.16);
	border-radius: 6px;
	color: white;
	font-family: inherit;
	font-size: 12px;
	box-sizing: border-box;
}

#search-box::placeholder {
	color: rgba(255, 255, 255, 0.5);
}

.filter-header {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

.filter-header a {
	color: #76b7b2;
	font-size: 10px;
	text-decoration: none;
	margin-left: 0;
	cursor: pointer;
}

.filter-header a:hover {
	text-decoration: underline;
}

#ctrl-panel hr {
	border: none;
	border-top: 1px solid rgba(255, 255, 255, 0.15);
	margin: 8px 0;
}

#edge-type-filters {
	display: grid;
	grid-template-columns: 1fr;
	gap: 6px;
	margin-bottom: 10px;
}

.edge-type-label {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	padding: 6px 8px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.08);
	cursor: pointer;
	font-size: 11px;
	line-height: 1.2;
}

.edge-type-label input {
	margin: 0;
}

.edge-type-swatch {
	display: inline-block;
	width: 22px;
	height: 3px;
	border-radius: 999px;
	box-shadow: 0 0 8px currentColor;
}

#notebook-filters {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 6px;
	max-height: 34vh;
	overflow-y: auto;
	padding-right: 4px;
}

#search-mode-toggle {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 4px;
	margin-bottom: 6px;
	padding: 3px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
}

#semantic-details summary,
#semantic-panel summary {
	cursor: pointer;
	font-weight: bold;
	padding: 4px 0;
	list-style: revert;
}

#sem-notice {
	display: none;
	margin: 6px 0;
	padding: 6px 8px;
	border-radius: 6px;
	background: rgba(237, 201, 72, 0.14);
	border: 1px solid rgba(237, 201, 72, 0.4);
	color: rgba(255, 255, 255, 0.88);
	line-height: 1.4;
}

#sem-notice.visible {
	display: block;
}

#sem-status-block {
	margin: 6px 0 10px;
	padding: 8px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid rgba(255, 255, 255, 0.1);
}

#sem-status {
	color: rgba(255, 255, 255, 0.75);
	line-height: 1.4;
}

#sem-status.sem-warn {
	color: #edc948;
}

#sem-progress-track {
	display: none;
	height: 4px;
	margin-top: 6px;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.14);
	overflow: hidden;
}

#sem-progress-track.visible {
	display: block;
}

#sem-progress-bar {
	height: 100%;
	width: 0;
	border-radius: 999px;
	background: #76b7b2;
	transition: width 0.3s ease;
}

#sem-actions {
	display: flex;
	gap: 6px;
	margin-top: 8px;
}

.sem-button {
	flex: 1;
	padding: 5px 6px;
	border: 1px solid rgba(255, 255, 255, 0.16);
	border-radius: 6px;
	background: rgba(255, 255, 255, 0.08);
	color: #fff;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.sem-button:hover:not(:disabled) {
	background: rgba(255, 255, 255, 0.16);
}

.sem-button:disabled {
	opacity: 0.5;
	cursor: default;
}

#sem-recompute {
	width: 100%;
	margin-top: 6px;
	background: rgba(118, 183, 178, 0.28);
}

#sem-recompute:hover:not(:disabled) {
	background: rgba(118, 183, 178, 0.44);
}

.sem-group {
	margin-bottom: 6px;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.sem-group-note {
	margin: 4px 0 8px;
	color: rgba(255, 255, 255, 0.55);
	line-height: 1.4;
}

.sem-field {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 6px;
}

.sem-field label {
	color: rgba(255, 255, 255, 0.8);
	line-height: 1.35;
}

.sem-field input[type="number"],
.sem-field select {
	width: 84px;
	flex: none;
	padding: 3px 5px;
	background: rgba(255, 255, 255, 0.09);
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 5px;
	color: #fff;
	font: inherit;
	font-size: 11px;
}

.sem-field-bool {
	justify-content: flex-start;
}

.sem-field-bool input {
	margin: 0;
	flex: none;
}

.nb-label {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.08);
	cursor: pointer;
	font-size: 11px;
	line-height: 1.2;
}

.nb-label input {
	margin: 0;
}

.nb-dot {
	display: inline-block;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	margin-right: 4px;
	vertical-align: middle;
}

#stats-line {
	color: rgba(255, 255, 255, 0.65);
	font-size: 10px;
	margin-top: 8px;
}

/* Stops short of the control panel so the two never overlap. */
#timeline {
	position: fixed;
	bottom: 12px;
	left: 12px;
	right: calc(min(360px, 100vw - 32px) + 32px);
	background: rgba(10, 10, 30, 0.95);
	border: 1px solid rgba(255, 255, 255, 0.15);
	border-radius: 12px;
	padding: 8px 12px 10px;
	color: white;
	z-index: 900;
	backdrop-filter: blur(12px);
}

#timeline-head {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 6px;
	font-size: 10px;
}

#timeline-field {
	display: flex;
	gap: 3px;
	padding: 2px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.12);
}

#timeline-field .view-button {
	font-size: 10px;
	padding: 3px 8px;
}

#timeline-readout {
	color: rgba(255, 255, 255, 0.65);
	font-size: 10px;
	white-space: nowrap;
}

#timeline.filtered #timeline-readout {
	color: #76b7b2;
}

/* Push the trailing controls to the right edge of the bar. */
#timeline-hide-label {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	color: rgba(255, 255, 255, 0.7);
	cursor: pointer;
	white-space: nowrap;
}

#timeline-hide-label input {
	margin: 0;
}

#timeline-reset {
	color: #76b7b2;
	text-decoration: none;
	cursor: pointer;
}

#timeline-reset:hover {
	text-decoration: underline;
}

#timeline-track {
	position: relative;
	height: 38px;
	border-radius: 6px;
	background: rgba(255, 255, 255, 0.05);
	touch-action: none;
	cursor: crosshair;
}

#timeline-hist {
	position: absolute;
	inset: 0;
	border-radius: 6px;
	pointer-events: none;
}

#timeline-selection {
	position: absolute;
	top: 0;
	bottom: 0;
	background: rgba(118, 183, 178, 0.12);
	border-left: 1px solid rgba(118, 183, 178, 0.55);
	border-right: 1px solid rgba(118, 183, 178, 0.55);
	cursor: grab;
}

#timeline-selection:active {
	cursor: grabbing;
}

.timeline-handle {
	position: absolute;
	top: -3px;
	bottom: -3px;
	width: 11px;
	margin-left: -5.5px;
	border-radius: 4px;
	background: #76b7b2;
	border: 1px solid rgba(10, 10, 30, 0.8);
	cursor: ew-resize;
	touch-action: none;
}

.timeline-handle:hover,
.timeline-handle:focus {
	background: #8fd3ce;
	outline: none;
}
`;

// Build the dialog HTML with the graph data embedded as a non-executed
// JSON block. Joplin dialogs have no onMessage channel (only panels do),
// so the webview reads its data straight from the DOM instead of
// requesting it via postMessage. Escaping "<" prevents a "</script>" inside
// note content from breaking out of the data block; it stays valid JSON.
/**
 * The semantic view needs an index. Rather than let the button silently do
 * nothing, disable it and say why.
 */
function semanticToggleAttrs(graphData: GraphData): string {
	if (graphData.semanticEdges.length > 0) {
		return ' title="Group notes by embedding similarity"';
	}
	return ' disabled title="Build the semantic index first ' +
		'(Tools &gt; Build semantic index)"';
}

function buildDialogHtml(graphData: GraphData): string {
	const json = JSON.stringify(graphData).replace(/</g, '\\u003c');
	return `
		<style>${GRAPH_CSS}</style>
		<div id="graph-root">
			<div id="loading">
				<div id="loading-spinner"></div>
				<div id="loading-text">Preparing knowledge graph...</div>
			</div>
			<div id="graph-container"></div>
			<div id="hover-popup">
				<button type="button" id="popup-close" aria-label="Close">&times;</button>
				<div id="hover-title"></div>
				<div id="hover-notebook"></div>
				<div id="hover-body"></div>
				<a id="popup-open" href="#" rel="noopener">Open note &#8599;</a>
			</div>
			<div id="ctrl-panel">
				<div id="layout-toggle" aria-label="Relationship model">
					<button type="button" id="layout-links" class="view-button active">Links &amp; TF-IDF</button>
					<button type="button" id="layout-semantic" class="view-button"${semanticToggleAttrs(graphData)}>Semantic distance</button>
				</div>
				<div id="index-notice">
					<div id="index-notice-text">
						Semantic clusters need a one-time index of your notes. It runs
						entirely on this machine.
					</div>
					<button type="button" id="build-index">Build semantic index</button>
				</div>
				<div id="view-toggle" aria-label="Graph view">
					<button type="button" id="view-2d" class="view-button">2D</button>
					<button type="button" id="view-3d" class="view-button active">3D</button>
				</div>
				<div id="search-wrapper">
					<div id="search-mode-toggle" aria-label="Search mode">
						<button type="button" class="view-button active" data-search-mode="title">Titles</button>
						<button type="button" class="view-button" data-search-mode="semantic" title="Searches by meaning and blends in Joplin's keyword search, so paraphrases and exact strings like ticket numbers both match. Adjust the mix with 'Keyword search blend' in settings.">Meaning</button>
					</div>
					<input type="text" id="search-box" placeholder="Search titles..." />
				</div>
				<div class="filter-header">
					<b>Relationships</b>
				</div>
				<div id="edge-type-filters"></div>
				<hr />
				<div class="filter-header">
					<b>Notebooks</b>
					<span>
						<a href="#" id="select-all">all</a>
						<a href="#" id="select-none">none</a>
					</span>
				</div>
				<hr />
				<div id="notebook-filters"></div>
				<hr />
				<details id="semantic-details">
					<summary>Semantic index &amp; parameters</summary>
					<div id="sem-notice"></div>
					<div id="semantic-panel"></div>
				</details>
				<hr />
				<div id="stats-line">...</div>
			</div>
			<div id="timeline" aria-label="Filter notes by date">
				<div id="timeline-head">
					<div id="timeline-field" aria-label="Date field">
						<button type="button" class="view-button active" data-date-field="created">Created</button>
						<button type="button" class="view-button" data-date-field="updated">Updated</button>
					</div>
					<span id="timeline-readout"></span>
					<label id="timeline-hide-label">
						<input type="checkbox" id="timeline-hide" />
						Hide filtered
					</label>
					<a href="#" id="timeline-reset">reset</a>
				</div>
				<div id="timeline-track">
					<canvas id="timeline-hist"></canvas>
					<div id="timeline-selection"></div>
					<div class="timeline-handle" id="timeline-from" tabindex="0" role="slider" aria-label="Range start"></div>
					<div class="timeline-handle" id="timeline-to" tabindex="0" role="slider" aria-label="Range end"></div>
				</div>
			</div>
			<script type="application/json" id="kg-data">${json}</script>
		</div>
	`;
}

function log(message: string): void {
	console.info(`[knowledge-graph] ${message}`);
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Toasts are unavailable on older Joplin versions; never fail because of one. */
async function notify(message: string, type: ToastType): Promise<void> {
	try {
		await joplin.views.dialogs.showToast({ message, type, duration: 4000 });
	} catch {
		log(message);
	}
}

/**
 * Re-embed changed notes shortly after edits stop. Joplin fires note-change
 * events on every keystroke, so without debouncing a note being typed into
 * would be re-embedded continuously.
 */
const DIRTY_DEBOUNCE_MS = 5000;

/**
 * Delay before the startup reconciliation sweep, so it never competes with
 * Joplin's own launch work.
 */
const RECONCILE_DELAY_MS = 20000;

async function trackNoteChanges(indexer: Indexer): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	await joplin.workspace.onNoteChange(async (event) => {
		if (!event?.id) return;
		await indexer.markDirty(event.id);

		clearTimeout(timer);
		timer = setTimeout(() => {
			indexer.drainDirty().catch(err => {
				log(`Incremental indexing failed: ${describeError(err)}`);
			});
		}, DIRTY_DEBOUNCE_MS);
	});

	// Sync can bring in changes with no per-note event, so compare timestamps
	// rather than trusting the dirty queue alone.
	await joplin.workspace.onSyncComplete(() => {
		indexer.reconcile().catch(err => {
			log(`Reconciliation failed: ${describeError(err)}`);
		});
	});

	// Catch anything that changed while the plugin was not running.
	setTimeout(() => {
		indexer.reconcile().catch(err => {
			log(`Reconciliation failed: ${describeError(err)}`);
		});
	}, RECONCILE_DELAY_MS);
}

joplin.plugins.register({
	onStart: async function () {
		await registerSettings();

		// Opening the store is cheap; loading the model is not, and happens only
		// when something actually needs to embed.
		const indexer = await Indexer.create();
		const searchPanel = await SearchPanel.create(indexer);
		await trackNoteChanges(indexer);

		await joplin.settings.onChange(async () => {
			await indexer.checkFingerprint();
		});

		// Create the dialog
		const dialog = await joplin.views.dialogs.create('knowledge-graph-dialog');

		await joplin.views.dialogs.setFitToContent(dialog, false);
		// The button id must be one Joplin treats as a "dismiss" button —
		// UserWebviewDialog.findDismissButton only matches cancel/no/reject, and
		// that match is what enables the Escape key (both the in-iframe key
		// handler and the native <dialog> onCancel path). An id of "close"
		// renders an identical button but leaves Escape dead.
		await joplin.views.dialogs.setButtons(dialog, [
			{ id: 'cancel', title: 'Close' },
		]);

		// Everything the dialog needs from the plugin goes through one handler:
		// opening links (the webview sandbox cannot navigate joplin:// itself),
		// reading and writing settings, driving the indexer, recomputing the
		// semantic view, and running searches. Dialogs share the panel view
		// controller, so panels.onMessage registers a handler on the dialog, and
		// the value returned here is what the webview's postMessage resolves to.
		const controller = new GraphController(
			indexer,
			() => searchPanel.reveal(),
			log,
		);

		await joplin.views.panels.onMessage(dialog, async (message: any) => {
			// Older callers sent a bare { link } message.
			if (message && typeof message.link === 'string') {
				return controller.handle({ type: 'link', link: message.link });
			}
			return controller.handle(message as GraphRequest);
		});

		// Register command
		await joplin.commands.register({
			name: 'showKnowledgeGraph',
			label: 'Show Knowledge Graph',
			iconName: 'fas fa-sitemap',
			execute: async () => {
				// The graph is built before the modal can be shown, which takes a few
				// seconds on a large library. Without this the click looks ignored.
				await notify('Building knowledge graph…', ToastType.Info);

				// The semantic overlay is optional: without an index the graph is
				// exactly what it always was, so a missing or broken index must not
				// stop the graph from opening.
				const overlay = await buildOverlay(indexer, log).catch(err => {
					log(`Semantic view unavailable: ${describeError(err)}`);
					return null;
				});

				const graphData = await buildGraphData(log, overlay);

				await joplin.views.dialogs.setHtml(dialog, buildDialogHtml(graphData));
				await joplin.views.dialogs.addScript(dialog, './webview/graph.js');
				await joplin.views.dialogs.open(dialog);
			},
		});

		await joplin.commands.register({
			name: 'kgBuildIndex',
			label: 'Build semantic index',
			execute: async () => {
				await searchPanel.reveal();
				await indexer.buildAll();
			},
		});

		await joplin.commands.register({
			name: 'kgRebuildIndex',
			label: 'Rebuild semantic index from scratch',
			execute: async () => {
				await searchPanel.reveal();
				await indexer.buildAll({ rebuild: true });
			},
		});

		await joplin.commands.register({
			name: 'kgCancelIndex',
			label: 'Cancel semantic indexing',
			execute: async () => indexer.cancel(),
		});

		await joplin.commands.register({
			name: 'kgToggleSearch',
			label: 'Toggle semantic search panel',
			iconName: 'fas fa-search',
			execute: async () => searchPanel.toggle(),
		});

		// Verifies the bundled embedding runtime works in the plugin sandbox.
		await joplin.commands.register({
			name: 'kgEmbedSelfTest',
			label: 'Test knowledge graph embedding runtime',
			execute: async () => {
				const { lines } = await runSelfTest();
				for (const line of lines) console.info(`[knowledge-graph] ${line}`);
				await joplin.views.dialogs.showMessageBox(
					`Embedding runtime self-test\n\n${lines.join('\n')}`,
				);
			},
		});

		// Toolbar buttons
		await joplin.views.toolbarButtons.create(
			'knowledge-graph-button',
			'showKnowledgeGraph',
			ToolbarButtonLocation.NoteToolbar,
		);

		await joplin.views.toolbarButtons.create(
			'knowledge-graph-search-button',
			'kgToggleSearch',
			ToolbarButtonLocation.NoteToolbar,
		);

		// Tools menu items
		await joplin.views.menuItems.create(
			'knowledge-graph-menu',
			'showKnowledgeGraph',
		);

		for (const [id, command] of [
			['knowledge-graph-search-menu', 'kgToggleSearch'],
			['knowledge-graph-build-menu', 'kgBuildIndex'],
			['knowledge-graph-rebuild-menu', 'kgRebuildIndex'],
			['knowledge-graph-cancel-menu', 'kgCancelIndex'],
			['knowledge-graph-selftest-menu', 'kgEmbedSelfTest'],
		]) {
			await joplin.views.menuItems.create(id, command);
		}
	},
});

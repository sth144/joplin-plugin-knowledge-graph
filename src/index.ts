import joplin from 'api';
import { ToolbarButtonLocation } from 'api/types';
import { buildGraphData, GraphData } from './graph-builder';

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
	overflow: hidden;
	z-index: 1000;
	width: min(360px, calc(100vw - 32px));
	border: 1px solid rgba(255, 255, 255, 0.15);
	backdrop-filter: blur(12px);
}

#search-wrapper {
	margin-bottom: 10px;
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
	max-height: 58vh;
	overflow-y: auto;
	padding-right: 4px;
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
`;

// Build the dialog HTML with the graph data embedded as a non-executed
// JSON block. Joplin dialogs have no onMessage channel (only panels do),
// so the webview reads its data straight from the DOM instead of
// requesting it via postMessage. Escaping "<" prevents a "</script>" inside
// note content from breaking out of the data block; it stays valid JSON.
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
				<div id="view-toggle" aria-label="Graph view">
					<button type="button" id="view-2d" class="view-button">2D</button>
					<button type="button" id="view-3d" class="view-button active">3D</button>
				</div>
				<div id="search-wrapper">
					<input type="text" id="search-box" placeholder="Search notes..." />
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
				<div id="stats-line">...</div>
			</div>
			<script type="application/json" id="kg-data">${json}</script>
		</div>
	`;
}

joplin.plugins.register({
	onStart: async function () {
		// Create the dialog
		const dialog = await joplin.views.dialogs.create('knowledge-graph-dialog');

		await joplin.views.dialogs.setFitToContent(dialog, false);
		await joplin.views.dialogs.setButtons(dialog, [
			{ id: 'close', title: 'Close' },
		]);

		// The dialog webview can't navigate joplin:// links itself (sandbox),
		// so it posts clicked links here. Dialogs share the panel view
		// controller, so panels.onMessage registers a handler on the dialog.
		// openItem resolves both internal (:/id) and external links.
		await joplin.views.panels.onMessage(dialog, async (message: any) => {
			if (message && typeof message.link === 'string') {
				await joplin.commands.execute('openItem', message.link);
			}
		});

		// Register command
		await joplin.commands.register({
			name: 'showKnowledgeGraph',
			label: 'Show Knowledge Graph',
			iconName: 'fas fa-sitemap',
			execute: async () => {
				// Build graph data, embed it in the dialog HTML, then open.
				const graphData = await buildGraphData((msg: string) => {
					console.info(`[knowledge-graph] ${msg}`);
				});

				await joplin.views.dialogs.setHtml(dialog, buildDialogHtml(graphData));
				await joplin.views.dialogs.addScript(dialog, './webview/graph.js');
				await joplin.views.dialogs.open(dialog);
			},
		});

		// Toolbar button
		await joplin.views.toolbarButtons.create(
			'knowledge-graph-button',
			'showKnowledgeGraph',
			ToolbarButtonLocation.NoteToolbar,
		);

		// Tools menu item
		await joplin.views.menuItems.create(
			'knowledge-graph-menu',
			'showKnowledgeGraph',
		);
	},
});

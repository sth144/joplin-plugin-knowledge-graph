import joplin from 'api';
import { ToolbarButtonLocation } from 'api/types';
import { buildGraphData, GraphData } from './graph-builder';

// Build the dialog HTML with the graph data embedded as a non-executed
// JSON block. Joplin dialogs have no onMessage channel (only panels do),
// so the webview reads its data straight from the DOM instead of
// requesting it via postMessage. Escaping "<" prevents a "</script>" inside
// note content from breaking out of the data block; it stays valid JSON.
function buildDialogHtml(graphData: GraphData): string {
	const json = JSON.stringify(graphData).replace(/</g, '\\u003c');
	return `
		<div id="graph-root">
			<div id="loading">
				<div id="loading-spinner"></div>
				<div id="loading-text">Preparing knowledge graph...</div>
			</div>
			<div id="graph-container"></div>
			<div id="hover-popup">
				<div id="hover-title"></div>
				<div id="hover-notebook"></div>
				<div id="hover-preview"></div>
			</div>
			<div id="ctrl-panel">
				<div id="search-wrapper">
					<input type="text" id="search-box" placeholder="Search notes..." />
				</div>
				<div id="filter-header">
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

		await joplin.views.dialogs.addScript(dialog, './webview/graph.css');
		await joplin.views.dialogs.addScript(dialog, './webview/graph.js');

		await joplin.views.dialogs.setFitToContent(dialog, false);
		await joplin.views.dialogs.setButtons(dialog, [
			{ id: 'close', title: 'Close' },
		]);

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

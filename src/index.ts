import joplin from 'api';
import { ToolbarButtonLocation } from 'api/types';
import { buildGraphData, GraphData } from './graph-builder';

joplin.plugins.register({
	onStart: async function () {
		// Cached graph data, rebuilt each time the dialog opens
		let graphData: GraphData | null = null;

		// Create the dialog
		const dialog = await joplin.views.dialogs.create('knowledge-graph-dialog');

		await joplin.views.dialogs.addScript(dialog, './webview/graph.css');
		await joplin.views.dialogs.addScript(dialog, './webview/graph.js');

		await joplin.views.dialogs.setHtml(dialog, `
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
			</div>
		`);

		await joplin.views.dialogs.setFitToContent(dialog, false);
		await joplin.views.dialogs.setButtons(dialog, [
			{ id: 'close', title: 'Close' },
		]);

		// Register the message handler ONCE — the webview calls this
		// when it initializes to request graph data
		await joplin.views.dialogs.onMessage(dialog, (message: any) => {
			if (message.type === 'requestGraphData') {
				return graphData;
			}
			return null;
		});

		// Register command
		await joplin.commands.register({
			name: 'showKnowledgeGraph',
			label: 'Show Knowledge Graph',
			iconName: 'fas fa-sitemap',
			execute: async () => {
				// Build graph data before opening dialog
				graphData = await buildGraphData((msg: string) => {
					console.info(`[knowledge-graph] ${msg}`);
				});

				// Open the dialog — the webview's init() will fire
				// and request graphData via postMessage
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

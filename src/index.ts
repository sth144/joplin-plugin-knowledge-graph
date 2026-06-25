import joplin from 'api';
import { ToolbarButtonLocation } from 'api/types';
import { buildGraphData } from './graph-builder';

joplin.plugins.register({
	onStart: async function () {
		// Register the dialog
		const dialog = await joplin.views.dialogs.create('knowledge-graph-dialog');

		await joplin.views.dialogs.addScript(dialog, './webview/graph.css');
		await joplin.views.dialogs.addScript(dialog, './webview/graph.js');

		// Set initial HTML (loading state)
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

		// Handle messages from the webview
		await joplin.views.dialogs.setButtons(dialog, [
			{ id: 'close', title: 'Close' },
		]);

		// Register command
		await joplin.commands.register({
			name: 'showKnowledgeGraph',
			label: 'Show Knowledge Graph',
			iconName: 'fas fa-project-diagram',
			execute: async () => {
				// Build graph data before showing dialog
				const graphData = await buildGraphData((msg: string) => {
					console.info(`[knowledge-graph] ${msg}`);
				});

				// Send data to the webview via a message handler
				await joplin.views.dialogs.onMessage(dialog, (message: any) => {
					if (message.type === 'requestGraphData') {
						return graphData;
					}
					return null;
				});

				await joplin.views.dialogs.open(dialog);
			},
		});

		// Add toolbar button
		await joplin.views.toolbarButtons.create(
			'knowledge-graph-button',
			'showKnowledgeGraph',
			ToolbarButtonLocation.NoteToolbar,
		);

		// Add menu item under Tools
		await joplin.views.menuItems.create(
			'knowledge-graph-menu',
			'showKnowledgeGraph',
		);
	},
});

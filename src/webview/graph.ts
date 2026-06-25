/**
 * Webview script for the knowledge graph dialog.
 *
 * Runs inside the Joplin webview sandbox. Communicates with the plugin
 * process via webviewApi.postMessage() to fetch graph data.
 *
 * vis-network is loaded from a bundled copy (see webpack extraScripts).
 */

declare const webviewApi: {
	postMessage(message: any): Promise<any>;
};

// vis-network types (minimal subset we use)
interface VisNode {
	id: number;
	label: string;
	group: string;
	color: string;
	size: number;
	notebook: string;
	preview: string;
	hidden?: boolean;
}

interface VisEdge {
	id?: string;
	from: number;
	to: number;
	weight: number;
	color: string;
	title?: string;
	hidden?: boolean;
}

interface GraphData {
	nodes: VisNode[];
	edges: VisEdge[];
	folderColors: Record<string, string>;
}

// Load vis-network from CDN (since we can't bundle native modules)
function loadVisNetwork(): Promise<void> {
	return new Promise((resolve, reject) => {
		// Check if already loaded
		if ((window as any).vis) {
			resolve();
			return;
		}
		const script = document.createElement('script');
		script.src = 'https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js';
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Failed to load vis-network'));
		document.head.appendChild(script);
	});
}

async function init(): Promise<void> {
	const loading = document.getElementById('loading')!;
	const loadingText = document.getElementById('loading-text')!;

	try {
		// Load vis-network
		loadingText.textContent = 'Loading visualization library...';
		await loadVisNetwork();

		// Request graph data from plugin process
		loadingText.textContent = 'Building knowledge graph...';
		const graphData: GraphData = await webviewApi.postMessage({
			type: 'requestGraphData',
		});

		if (!graphData || !graphData.nodes) {
			loadingText.textContent = 'Error: No graph data received.';
			return;
		}

		loadingText.textContent = `Rendering ${graphData.nodes.length} nodes...`;

		// Build the filter panel
		buildFilterPanel(graphData.folderColors);

		// Render the graph
		renderGraph(graphData);

		// Hide loading
		loading.classList.add('hidden');
	} catch (err) {
		loadingText.textContent = `Error: ${err}`;
	}
}

function buildFilterPanel(folderColors: Record<string, string>): void {
	const container = document.getElementById('notebook-filters')!;
	const entries = Object.entries(folderColors).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	for (const [folder, color] of entries) {
		const label = document.createElement('label');
		label.className = 'nb-label';

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = true;
		checkbox.dataset.group = folder;
		checkbox.className = 'nb-filter';
		checkbox.style.marginRight = '6px';

		const dot = document.createElement('span');
		dot.className = 'nb-dot';
		dot.style.background = color;

		const text = document.createElement('span');
		text.style.verticalAlign = 'middle';
		text.textContent = folder;

		label.appendChild(checkbox);
		label.appendChild(dot);
		label.appendChild(text);
		container.appendChild(label);
	}
}

function renderGraph(graphData: GraphData): void {
	const vis = (window as any).vis;
	const container = document.getElementById('graph-container')!;

	// Assign edge IDs
	const edgesWithIds = graphData.edges.map((e, i) => ({
		...e,
		id: `e${i}`,
	}));

	const nodesDataset = new vis.DataSet(graphData.nodes);
	const edgesDataset = new vis.DataSet(edgesWithIds);

	const network = new vis.Network(
		container,
		{ nodes: nodesDataset, edges: edgesDataset },
		{
			physics: {
				forceAtlas2Based: {
					gravitationalConstant: -80,
					centralGravity: 0.01,
					springLength: 120,
					springConstant: 0.02,
					damping: 0.4,
				},
				solver: 'forceAtlas2Based',
				stabilization: { iterations: 200 },
			},
			interaction: {
				hover: true,
				tooltipDelay: 0,
				navigationButtons: true,
				keyboard: true,
			},
			nodes: {
				font: {
					size: 12,
					color: 'white',
					strokeWidth: 2,
					strokeColor: '#1a1a2e',
				},
				borderWidth: 1,
				borderWidthSelected: 3,
			},
			edges: {
				smooth: { type: 'continuous' },
				scaling: { min: 0.5, max: 3 },
			},
		},
	);

	// Cache node data for hover and filtering
	const allNodes = nodesDataset.get() as VisNode[];
	const allEdges = edgesDataset.get() as VisEdge[];
	const nodeMap = new Map(allNodes.map((n: VisNode) => [n.id, n]));

	// Hover popup
	setupHoverPopup(network, nodeMap);

	// Filters
	setupFilters(allNodes, allEdges, nodesDataset, edgesDataset);

	// Initial stats
	updateStats(allNodes.length, allEdges.length);
}

function setupHoverPopup(
	network: any,
	nodeMap: Map<number, VisNode>,
): void {
	const popup = document.getElementById('hover-popup')!;
	const hoverTitle = document.getElementById('hover-title')!;
	const hoverNotebook = document.getElementById('hover-notebook')!;
	const hoverPreview = document.getElementById('hover-preview')!;

	network.on('hoverNode', (params: { node: number }) => {
		const node = nodeMap.get(params.node);
		if (!node) return;
		hoverTitle.textContent = node.label || '(untitled)';
		hoverNotebook.textContent = node.notebook || '';
		hoverPreview.textContent = node.preview || '';
		popup.style.display = 'block';
	});

	network.on('blurNode', () => {
		popup.style.display = 'none';
	});

	document.addEventListener('mousemove', (e: MouseEvent) => {
		if (popup.style.display === 'none') return;
		let x = e.clientX + 16;
		let y = e.clientY + 16;
		if (x + 390 > window.innerWidth) x = e.clientX - 396;
		if (y + 200 > window.innerHeight) y = e.clientY - 200;
		popup.style.left = `${x}px`;
		popup.style.top = `${y}px`;
	});
}

function setupFilters(
	allNodes: VisNode[],
	allEdges: VisEdge[],
	nodesDataset: any,
	edgesDataset: any,
): void {
	const searchBox = document.getElementById('search-box') as HTMLInputElement;
	let searchTimeout: ReturnType<typeof setTimeout>;

	function applyFilters(): void {
		const activeGroups = new Set<string>();
		document.querySelectorAll<HTMLInputElement>('.nb-filter:checked').forEach(
			cb => activeGroups.add(cb.dataset.group!),
		);

		const query = searchBox.value.trim().toLowerCase();
		const visibleIds = new Set<number>();
		const nodeUpdates: Array<{ id: number; hidden: boolean }> = [];

		for (const n of allNodes) {
			const groupMatch = activeGroups.has(n.group);
			const searchMatch =
				!query || (n.label && n.label.toLowerCase().includes(query));
			const visible = groupMatch && searchMatch;
			if (visible) visibleIds.add(n.id);
			nodeUpdates.push({ id: n.id, hidden: !visible });
		}

		nodesDataset.update(nodeUpdates);

		let visibleEdgeCount = 0;
		const edgeUpdates: Array<{ id: string; hidden: boolean }> = [];
		for (const e of allEdges) {
			const visible = visibleIds.has(e.from) && visibleIds.has(e.to);
			if (visible) visibleEdgeCount++;
			edgeUpdates.push({ id: e.id!, hidden: !visible });
		}
		edgesDataset.update(edgeUpdates);

		updateStats(visibleIds.size, visibleEdgeCount);
	}

	// Attach filter listeners
	document.querySelectorAll('.nb-filter').forEach(cb => {
		cb.addEventListener('change', applyFilters);
	});

	document.getElementById('select-all')!.addEventListener('click', (e) => {
		e.preventDefault();
		document.querySelectorAll<HTMLInputElement>('.nb-filter').forEach(
			cb => { cb.checked = true; },
		);
		applyFilters();
	});

	document.getElementById('select-none')!.addEventListener('click', (e) => {
		e.preventDefault();
		document.querySelectorAll<HTMLInputElement>('.nb-filter').forEach(
			cb => { cb.checked = false; },
		);
		applyFilters();
	});

	searchBox.addEventListener('input', () => {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(applyFilters, 150);
	});
}

function updateStats(nodeCount: number, edgeCount: number): void {
	const el = document.getElementById('stats-line');
	if (el) el.textContent = `${nodeCount} nodes, ${edgeCount} edges`;
}

// Run on load
document.addEventListener('DOMContentLoaded', init);
// Fallback if DOMContentLoaded already fired
if (document.readyState !== 'loading') {
	init();
}

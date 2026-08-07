/**
 * Webview script for the knowledge graph dialog.
 *
 * Runs inside the Joplin webview sandbox. Joplin dialogs have no message
 * channel (unlike panels), so the plugin embeds the graph data in the dialog
 * HTML as a JSON block (id="kg-data") which this script reads from the DOM.
 *
 * Three.js is bundled via webpack (no CDN dependency).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { renderMarkdown } from './markdown';
import { SearchResponse, SemanticPayload, SemanticResponse } from '../graph-messages';
import { ParamsPanel } from './params';
import { Timeline, TimelineState } from './timeline';

// Injected by Joplin into plugin webviews (panels and dialogs alike). Used to
// hand note/link clicks back to the plugin, which runs the openItem command.
declare const webviewApi: { postMessage(message: unknown): Promise<unknown> };

interface GraphNode {
	id: number;
	label: string;
	group: string;
	color: string;
	size: number;
	notebook: string;
	preview: string;
	noteId: string;
	body: string;
	created: number;
	updated: number;
}

interface GraphEdge {
	from: number;
	to: number;
	weight: number;
	color: string;
	title?: string;
	reasons?: EdgeReason[];
}

type EdgeReasonType = 'similarity' | 'ticket' | 'link' | 'semantic';

interface EdgeReason {
	type: EdgeReasonType;
	label: string;
	detail?: string;
	weight: number;
}

interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	folderColors: Record<string, string>;
	semanticEdges?: GraphEdge[];
	clusters?: number[];
	clusterColors?: Record<string, string>;
	clusterLabels?: Record<string, string>;
	separation?: number;
}

interface LayoutNode {
	data: GraphNode;
	position: THREE.Vector3;
	velocity: THREE.Vector3;
	visible: boolean;
	mesh: THREE.Mesh;
	/** Notebook-coloured material, restored when leaving the semantic view. */
	baseMaterial: THREE.MeshBasicMaterial;
	/** Dropped here by the user; the simulation moves everything else around it. */
	pinned: boolean;
	/** Outside the date range but still laid out, drawn faded for context. */
	dimmed: boolean;
}

interface RenderEdge {
	data: GraphEdge;
	line: THREE.Line;
	visible: boolean;
	/** Which layout this edge belongs to; only one layout is shown at a time. */
	layout: LayoutMode;
	/** Opacity from the edge colour, restored when the edge stops being dimmed. */
	baseOpacity: number;
}

type ViewMode = '2d' | '3d';

/**
 * Which relationship model drives the graph. Both edge sets arrive in the same
 * payload, so switching is a visibility change rather than a rebuild.
 */
type LayoutMode = 'links' | 'semantic';

/** How the search box interprets what is typed into it. */
type SearchMode = 'title' | 'semantic';

const CLUSTER_LABEL_WIDTH = 512;
const CLUSTER_LABEL_HEIGHT = 128;

const EDGE_TYPE_LABELS: Record<EdgeReasonType, string> = {
	similarity: 'Similar content',
	ticket: 'Shared ticket',
	link: 'Joplin link',
	semantic: 'Similar meaning',
};

const EDGE_TYPE_COLORS: Record<EdgeReasonType, string> = {
	similarity: 'rgba(150,150,150,0.65)',
	ticket: 'rgba(255,165,0,0.8)',
	link: 'rgba(100,100,255,0.85)',
	semantic: 'rgba(118,183,178,0.85)',
};

/** Edge types belonging to each layout, used to filter the relationship list. */
const LAYOUT_EDGE_TYPES: Record<LayoutMode, EdgeReasonType[]> = {
	links: ['similarity', 'ticket', 'link'],
	semantic: ['semantic'],
};

/** Nodes with no cluster (no semantic neighbours) render in grey. */
const UNCLUSTERED_COLOR = '#6b6b7b';

const NODE_TEXTURE_WIDTH = 320;
const NODE_TEXTURE_HEIGHT = 120;
const MAX_LABEL_LINES = 2;
/** How far notes outside the date range fade, rather than disappearing. */
const DIMMED_NODE_OPACITY = 0.12;
const DIMMED_EDGE_FACTOR = 0.12;

async function init(): Promise<void> {
	const loading = document.getElementById('loading')!;
	const loadingText = document.getElementById('loading-text')!;

	try {
		loadingText.textContent = 'Building knowledge graph...';
		const dataEl = document.getElementById('kg-data');
		const graphData: GraphData | null = dataEl
			? JSON.parse(dataEl.textContent || 'null')
			: null;

		if (!graphData || !graphData.nodes) {
			loadingText.textContent = 'Error: No graph data received.';
			return;
		}

		setupIndexNotice(graphData);

		loadingText.textContent = `Rendering ${graphData.nodes.length} nodes...`;
		buildFilterPanel(graphData.folderColors);
		buildEdgeTypePanel([
			...graphData.edges,
			...(graphData.semanticEdges ?? []),
		]);

		const graph = new ThreeKnowledgeGraph(graphData);
		graph.mount(document.getElementById('graph-container')!);

		await setupSemanticPanel(graph);
		setupSearchMode(graph);

		loading.classList.add('hidden');
	} catch (err) {
		loadingText.textContent = `Error: ${err}`;
	}
}

function buildEdgeTypePanel(edges: GraphEdge[]): void {
	const container = document.getElementById('edge-type-filters')!;
	const counts: Record<EdgeReasonType, number> = {
		similarity: 0,
		ticket: 0,
		link: 0,
		semantic: 0,
	};

	for (const edge of edges) {
		for (const type of getEdgeReasonTypes(edge)) counts[type]++;
	}

	for (const type of Object.keys(EDGE_TYPE_LABELS) as EdgeReasonType[]) {
		const label = document.createElement('label');
		label.className = 'edge-type-label';
		label.dataset.edgeTypeRow = type;

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = true;
		checkbox.dataset.edgeType = type;
		checkbox.className = 'edge-type-filter';

		const swatch = document.createElement('span');
		swatch.className = 'edge-type-swatch';
		swatch.style.background = EDGE_TYPE_COLORS[type];

		const text = document.createElement('span');
		text.textContent = `${EDGE_TYPE_LABELS[type]} (${counts[type]})`;

		label.title = edgeTypeHelp(type);
		label.appendChild(checkbox);
		label.appendChild(swatch);
		label.appendChild(text);
		container.appendChild(label);
	}
}

/**
 * Show only the relationship types that exist in the active layout, and make
 * sure they are enabled — a type left unchecked in the other layout would
 * otherwise present as an empty graph.
 */
/**
 * Mount the parameter panel and route its requests to the plugin. Recomputing
 * clusters comes back as a payload that is applied to the live scene, so the
 * dialog never has to be reopened.
 */
async function setupSemanticPanel(graph: ThreeKnowledgeGraph): Promise<void> {
	const container = document.getElementById('semantic-panel');
	if (!container) return;

	const panel = new ParamsPanel({
		request: message => webviewApi.postMessage(message),
		onSemantic: (response: SemanticResponse) => {
			if (response?.error) {
				showNotice(response.error);
				return;
			}
			if (!response?.payload) {
				showNotice('No vectors yet — build the index first.');
				return;
			}
			graph.applySemanticPayload(response.payload);
			showNotice('');
		},
		onNotice: showNotice,
	}, container);

	await panel.mount();
}

/** Toggle the search box between title matching and semantic search. */
function setupSearchMode(graph: ThreeKnowledgeGraph): void {
	const box = document.getElementById('search-box') as HTMLInputElement | null;
	const buttons = Array.from(
		document.querySelectorAll<HTMLButtonElement>('[data-search-mode]'),
	);
	if (!box || buttons.length === 0) return;

	let mode: SearchMode = 'title';
	let timer: ReturnType<typeof setTimeout> | null = null;
	let latest = '';

	const runSemanticSearch = async (query: string) => {
		latest = query;
		if (!query.trim()) {
			graph.applySemanticMatches(null);
			return;
		}

		const response = await webviewApi.postMessage({
			type: 'semanticSearch', text: query,
		}) as SearchResponse | null;

		// A slower earlier query must not overwrite a newer one.
		if (latest !== query) return;

		if (response?.error) {
			showNotice(response.error);
			return;
		}

		const ids = new Set<number>();
		for (const result of response?.results ?? []) {
			const nodeId = graph.nodeIdForNote(result.noteId);
			if (nodeId !== undefined) ids.add(nodeId);
		}
		graph.applySemanticMatches(ids);
	};

	for (const button of buttons) {
		button.addEventListener('click', () => {
			mode = button.dataset.searchMode === 'semantic' ? 'semantic' : 'title';
			for (const other of buttons) {
				other.classList.toggle('active', other === button);
			}
			box.placeholder = mode === 'semantic'
				? 'Search by meaning…'
				: 'Search titles…';
			graph.setSearchMode(mode);
			if (mode === 'semantic') void runSemanticSearch(box.value);
		});
	}

	box.addEventListener('input', () => {
		if (mode !== 'semantic') return;
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => void runSemanticSearch(box.value), 250);
	});
}

function showNotice(message: string): void {
	const notice = document.getElementById('sem-notice');
	if (!notice) return;
	notice.textContent = message;
	notice.classList.toggle('visible', message.length > 0);
}

/**
 * Without an index the semantic view has nothing to show, so rather than leaving
 * a disabled button and a tooltip, offer to build the index from here.
 */
function setupIndexNotice(graphData: GraphData): void {
	const notice = document.getElementById('index-notice');
	const button = document.getElementById('build-index') as HTMLButtonElement | null;
	const text = document.getElementById('index-notice-text');
	if (!notice || !button || !text) return;

	if ((graphData.semanticEdges ?? []).length > 0) return;
	notice.classList.add('visible');

	button.addEventListener('click', async () => {
		button.disabled = true;
		button.textContent = 'Starting…';

		const response = await webviewApi.postMessage({ type: 'buildIndex' }) as
			{ started?: boolean; message?: string } | null;

		if (response?.started) {
			text.textContent =
				'Indexing started. Close the graph to watch progress in the ' +
				'Semantic Search panel, then reopen the graph to see clusters.';
			button.textContent = 'Indexing in progress';
			return;
		}

		text.textContent = response?.message ?? 'Could not start indexing.';
		button.textContent = 'Build semantic index';
		button.disabled = false;
	});
}

function syncEdgeTypeRows(layout: LayoutMode): void {
	const applicable = new Set<EdgeReasonType>(LAYOUT_EDGE_TYPES[layout]);

	document.querySelectorAll<HTMLElement>('[data-edge-type-row]').forEach(row => {
		const type = row.dataset.edgeTypeRow as EdgeReasonType;
		const shown = applicable.has(type);
		row.style.display = shown ? '' : 'none';

		const checkbox = row.querySelector<HTMLInputElement>('.edge-type-filter');
		if (shown && checkbox && !checkbox.checked) checkbox.checked = true;
	});
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

		const dot = document.createElement('span');
		dot.className = 'nb-dot';
		dot.style.background = color;

		const text = document.createElement('span');
		text.textContent = folder;

		label.appendChild(checkbox);
		label.appendChild(dot);
		label.appendChild(text);
		container.appendChild(label);
	}
}

class ThreeKnowledgeGraph {
	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
	private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
	private readonly raycaster = new THREE.Raycaster();
	private readonly pointer = new THREE.Vector2();
	private readonly nodes: LayoutNode[] = [];
	// Not readonly: the semantic edge set is replaced when clusters are recomputed.
	private edges: RenderEdge[] = [];
	private readonly nodeById = new Map<number, LayoutNode>();
	private readonly controls: OrbitControls;
	private mode: ViewMode = '3d';
	private hoveredNode: LayoutNode | null = null;
	private hoveredEdge: RenderEdge | null = null;
	private pinnedNode: LayoutNode | null = null;
	private pointerDown = new THREE.Vector2();
	private searchTimeout: ReturnType<typeof setTimeout> | undefined;
	private simulationAlpha = 1;
	private frameCount = 0;
	/** Node currently held by the pointer, if any. */
	private draggedNode: LayoutNode | null = null;
	/** Plane the held node slides along, facing the camera through its start point. */
	private readonly dragPlane = new THREE.Plane();
	/** Grab point relative to the node centre, so it doesn't snap under the cursor. */
	private readonly dragOffset = new THREE.Vector3();
	private readonly dragHit = new THREE.Vector3();
	private container: HTMLElement | null = null;
	private layout: LayoutMode = 'links';
	/** Cluster-coloured node textures, built on first switch to the semantic view. */
	private clusterMaterials: THREE.MeshBasicMaterial[] | null = null;
	/** Fixed world position per cluster id, which nodes are drawn towards. */
	private clusterAnchors = new Map<number, THREE.Vector3>();
	private clusterLabelSprites: THREE.Sprite[] = [];
	private searchMode: SearchMode = 'title';
	/** Node ids matching the current semantic query, or null when not searching. */
	private semanticMatches: Set<number> | null = null;
	private noteIdToNodeId = new Map<string, number>();
	/** Date range control along the bottom edge; absent until mount(). */
	private timeline: Timeline | null = null;

	public constructor(private graphData: GraphData) {
		this.scene.background = new THREE.Color('#171726');
		this.camera.position.set(320, -420, 340);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		// Pan in the plane of the screen rather than along the ground plane.
		this.controls.screenSpacePanning = true;
		this.controls.minDistance = 120;
		// Recomputed from the actual layout extent; see updateZoomLimits().
		this.controls.maxDistance = 1800;
		this.raycaster.params.Line = { threshold: 8 };
	}

	public mount(container: HTMLElement): void {
		this.container = container;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(container.clientWidth, container.clientHeight);
		container.appendChild(this.renderer.domElement);

		this.createGraphObjects();
		this.setupLighting();
		this.setupPointerEvents();
		this.setupControls();
		this.setupTimeline();
		this.applyMode('3d');
		syncEdgeTypeRows(this.layout);
		this.rebuildClusterVisuals();
		this.applyFilters();
		this.resize();

		window.addEventListener('resize', () => this.resize());
		this.animate();
	}

	private createGraphObjects(): void {
		const nodeCount = Math.max(this.graphData.nodes.length, 1);
		const radius = Math.max(120, Math.sqrt(nodeCount) * 32);

		for (const node of this.graphData.nodes) {
			const material = new THREE.MeshBasicMaterial({
				map: createNodeTexture(node),
				transparent: true,
				depthWrite: false,
			});
			const aspect = NODE_TEXTURE_WIDTH / NODE_TEXTURE_HEIGHT;
			const height = THREE.MathUtils.clamp(node.size * 2.2, 24, 56);
			const geometry = new THREE.PlaneGeometry(height * aspect, height);
			const mesh = new THREE.Mesh(geometry, material);
			mesh.userData.nodeId = node.id;

			const seed = seededUnit(node.id + 1);
			const theta = seed * Math.PI * 2;
			const phi = Math.acos(2 * seededUnit(node.id + 17) - 1);
			mesh.position.set(
				radius * Math.sin(phi) * Math.cos(theta),
				radius * Math.sin(phi) * Math.sin(theta),
				radius * Math.cos(phi),
			);

			const layoutNode: LayoutNode = {
				data: node,
				position: mesh.position,
				velocity: new THREE.Vector3(),
				visible: true,
				mesh,
				baseMaterial: material,
				pinned: false,
				dimmed: false,
			};
			this.nodes.push(layoutNode);
			this.nodeById.set(node.id, layoutNode);
			this.noteIdToNodeId.set(node.noteId, node.id);
			this.scene.add(mesh);
		}

		this.createEdgeObjects(this.graphData.edges, 'links');
		this.createEdgeObjects(this.graphData.semanticEdges ?? [], 'semantic');
	}

	private createEdgeObjects(edges: GraphEdge[], layout: LayoutMode): void {
		for (const edge of edges) {
			const from = this.nodeById.get(edge.from);
			const to = this.nodeById.get(edge.to);
			if (!from || !to) continue;

			const geometry = new THREE.BufferGeometry().setFromPoints([
				from.position,
				to.position,
			]);
			const { color, opacity } = parseRgba(edge.color);
			const material = new THREE.LineBasicMaterial({
				color,
				transparent: true,
				opacity,
			});
			const line = new THREE.Line(geometry, material);

			this.edges.push({
				data: edge, line, visible: true, layout, baseOpacity: opacity,
			});
			this.scene.add(line);
		}
	}

	private setupLighting(): void {
		this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
	}

	private setupPointerEvents(): void {
		const canvas = this.renderer.domElement;
		canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
		canvas.addEventListener('pointerleave', () => this.hideHoverPopup());
		canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		// On window, so a release outside the canvas still ends the drag.
		window.addEventListener('pointerup', (event) => this.endNodeDrag(event));
		window.addEventListener('pointercancel', (event) => this.endNodeDrag(event));
		canvas.addEventListener('click', (event) => this.onClick(event));

		document.getElementById('popup-close')!.addEventListener('click', () => {
			this.unpinPopup();
		});

		// Route in-card link clicks (the "Open note" link and any internal or
		// external links in the rendered body) to the plugin via postMessage,
		// since the dialog iframe sandbox blocks navigation on its own.
		document.getElementById('hover-popup')!.addEventListener('click', (event) => {
			const anchor = (event.target as HTMLElement).closest('a');
			const href = anchor?.getAttribute('href');
			if (!href || href === '#') return;
			event.preventDefault();
			if (typeof webviewApi !== 'undefined') {
				void webviewApi.postMessage({ link: href });
			}
		});
	}

	private setupControls(): void {
		document.querySelectorAll<HTMLInputElement>('.nb-filter').forEach(cb => {
			cb.addEventListener('change', () => this.applyFilters());
		});
		document.querySelectorAll<HTMLInputElement>('.edge-type-filter').forEach(cb => {
			cb.addEventListener('change', () => this.applyFilters());
		});

		document.getElementById('select-all')!.addEventListener('click', (event) => {
			event.preventDefault();
			document.querySelectorAll<HTMLInputElement>('.nb-filter').forEach(
				cb => { cb.checked = true; },
			);
			this.applyFilters();
		});

		document.getElementById('select-none')!.addEventListener('click', (event) => {
			event.preventDefault();
			document.querySelectorAll<HTMLInputElement>('.nb-filter').forEach(
				cb => { cb.checked = false; },
			);
			this.applyFilters();
		});

		const searchBox = document.getElementById('search-box') as HTMLInputElement;
		searchBox.addEventListener('input', () => {
			clearTimeout(this.searchTimeout);
			this.searchTimeout = setTimeout(() => this.applyFilters(), 150);
		});

		document.getElementById('view-2d')!.addEventListener('click', () => {
			this.applyMode('2d');
		});
		document.getElementById('view-3d')!.addEventListener('click', () => {
			this.applyMode('3d');
		});

		document.getElementById('layout-links')?.addEventListener('click', () => {
			this.applyLayout('links');
		});
		document.getElementById('layout-semantic')?.addEventListener('click', () => {
			if ((this.graphData.semanticEdges ?? []).length === 0) return;
			this.applyLayout('semantic');
		});
	}

	private setupTimeline(): void {
		this.timeline = new Timeline(
			this.graphData.nodes,
			(_state, resettle) => this.applyFilters(resettle),
		);
		this.timeline.mount();
	}

	/**
	 * Switch between the link/TF-IDF graph and the embedding-derived one. Both
	 * edge sets already exist as scene objects, so this only changes which are
	 * visible, how nodes are coloured, and which relationship filters apply.
	 */
	private applyLayout(layout: LayoutMode): void {
		if (this.layout === layout) return;
		this.layout = layout;

		document.getElementById('layout-links')?.classList.toggle(
			'active', layout === 'links',
		);
		document.getElementById('layout-semantic')?.classList.toggle(
			'active', layout === 'semantic',
		);

		this.applyNodeColors();
		this.updateClusterLabelVisibility();
		syncEdgeTypeRows(layout);

		// Re-run the force simulation: a different edge set implies a different
		// resting shape, and leaving nodes where the old edges put them would
		// misrepresent the new one. Hand-placed pins belong to the old shape too,
		// so switching layouts is also how you clear them.
		for (const node of this.nodes) node.pinned = false;
		this.simulationAlpha = 1;
		this.applyFilters();
	}

	/**
	 * Recompute everything derived from the cluster assignment: anchor positions,
	 * node colours and floating cluster labels.
	 */
	private rebuildClusterVisuals(): void {
		this.clusterMaterials = null;
		this.computeClusterAnchors();
		this.buildClusterLabels();
		this.applyNodeColors();
		this.updateClusterLabelVisibility();
	}

	/**
	 * Place each cluster at a fixed point, spread evenly so the layout has
	 * somewhere distinct to pull each group.
	 *
	 * In 3D the points go on a sphere using a Fibonacci spiral, which distributes
	 * far more evenly than stepping latitude and longitude (that bunches points at
	 * the poles). In 2D they go on a circle.
	 */
	private computeClusterAnchors(): void {
		this.clusterAnchors.clear();

		const ids = [...new Set(this.graphData.clusters ?? [])]
			.filter(id => id >= 0)
			.sort((a, b) => a - b);
		if (ids.length === 0) return;

		const radius = Math.max(320, Math.sqrt(this.nodes.length) * 62);
		const golden = Math.PI * (3 - Math.sqrt(5));

		ids.forEach((id, index) => {
			if (this.mode === '2d' || ids.length === 1) {
				const angle = (index / ids.length) * Math.PI * 2;
				this.clusterAnchors.set(
					id,
					new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0),
				);
				return;
			}

			const y = 1 - (index / (ids.length - 1)) * 2;
			const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
			const theta = golden * index;
			this.clusterAnchors.set(
				id,
				new THREE.Vector3(
					Math.cos(theta) * ringRadius * radius,
					y * radius,
					Math.sin(theta) * ringRadius * radius,
				),
			);
		});
	}

	/** Floating text at each cluster anchor, naming the group. */
	private buildClusterLabels(): void {
		for (const sprite of this.clusterLabelSprites) {
			this.scene.remove(sprite);
			sprite.material.map?.dispose();
			sprite.material.dispose();
		}
		this.clusterLabelSprites = [];

		const labels = this.graphData.clusterLabels ?? {};
		const colors = this.graphData.clusterColors ?? {};

		for (const [id, anchor] of this.clusterAnchors) {
			const text = labels[String(id)];
			if (!text) continue;

			const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
				map: createClusterLabelTexture(text, colors[String(id)] ?? '#ffffff'),
				transparent: true,
				depthWrite: false,
			}));

			// Sit above the cluster so labels do not fight with note cards.
			sprite.position.copy(anchor).add(new THREE.Vector3(0, 54, 0));
			sprite.scale.set(260, 65, 1);
			sprite.visible = false;
			this.clusterLabelSprites.push(sprite);
			this.scene.add(sprite);
		}
	}

	private updateClusterLabelVisibility(): void {
		const show = this.layout === 'semantic' && this.clusterAnchors.size > 0;
		for (const sprite of this.clusterLabelSprites) sprite.visible = show;
	}

	/**
	 * Adopt a recomputed semantic view without reopening the dialog. Only the
	 * semantic edge objects are rebuilt; nodes and link-view edges are untouched.
	 */
	public applySemanticPayload(payload: SemanticPayload): void {
		this.graphData.clusterLabels = payload.clusterLabels;
		this.graphData.clusterColors = payload.clusterColors;
		this.graphData.separation = payload.separation;

		const clusters = new Array<number>(this.graphData.nodes.length).fill(-1);
		for (const [noteId, cluster] of Object.entries(payload.clusters)) {
			const nodeId = this.noteIdToNodeId.get(noteId);
			if (nodeId !== undefined) clusters[nodeId] = cluster;
		}
		this.graphData.clusters = clusters;

		this.replaceSemanticEdges(payload.edges);
		this.rebuildClusterVisuals();
		syncEdgeTypeRows(this.layout);

		this.simulationAlpha = 1;
		this.applyFilters();
	}

	private replaceSemanticEdges(
		edges: Array<{ a: string; b: string; score: number }>,
	): void {
		for (const edge of this.edges) {
			if (edge.layout !== 'semantic') continue;
			this.scene.remove(edge.line);
			edge.line.geometry.dispose();
			(edge.line.material as THREE.Material).dispose();
		}
		this.edges = this.edges.filter(edge => edge.layout !== 'semantic');

		const rebuilt: GraphEdge[] = [];
		for (const edge of edges) {
			const from = this.noteIdToNodeId.get(edge.a);
			const to = this.noteIdToNodeId.get(edge.b);
			if (from === undefined || to === undefined) continue;

			rebuilt.push({
				from,
				to,
				weight: edge.score,
				color: EDGE_TYPE_COLORS.semantic,
				title: `Semantic similarity ${edge.score.toFixed(2)}`,
				reasons: [{
					type: 'semantic',
					label: 'Semantic similarity',
					detail: edge.score.toFixed(2),
					weight: edge.score,
				}],
			});
		}

		this.graphData.semanticEdges = rebuilt;
		this.createEdgeObjects(rebuilt, 'semantic');
		updateEdgeTypeCount('semantic', rebuilt.length);
	}

	/** Restrict the graph to notes matching a semantic query. */
	public applySemanticMatches(matches: Set<number> | null): void {
		this.semanticMatches = matches;
		this.applyFilters();
	}

	public nodeIdForNote(noteId: string): number | undefined {
		return this.noteIdToNodeId.get(noteId);
	}

	public setSearchMode(mode: SearchMode): void {
		this.searchMode = mode;
		if (mode === 'title') this.semanticMatches = null;
		this.applyFilters();
	}

	/** Colour nodes by notebook in the link view, by cluster in the semantic one. */
	private applyNodeColors(): void {
		// Notebook colours unless there is a clustering to show. With clustering
		// switched off the semantic view is about distance, not groups, so keeping
		// notebook colours makes it directly comparable to the link view.
		if (this.layout === 'links' || this.clusterAnchors.size === 0) {
			for (const node of this.nodes) {
				node.mesh.material = node.baseMaterial;
			}
			return;
		}

		if (!this.clusterMaterials) this.clusterMaterials = this.buildClusterMaterials();
		for (let i = 0; i < this.nodes.length; i++) {
			this.nodes[i].mesh.material = this.clusterMaterials[i];
		}
	}

	/**
	 * Node labels bake their colour into a texture, so cluster colouring needs a
	 * second set. Built once, on the first switch, rather than up front.
	 */
	private buildClusterMaterials(): THREE.MeshBasicMaterial[] {
		const clusters = this.graphData.clusters ?? [];
		const colors = this.graphData.clusterColors ?? {};

		return this.nodes.map((node, i) => {
			const cluster = clusters[i] ?? -1;
			const color = colors[String(cluster)] ?? UNCLUSTERED_COLOR;
			return new THREE.MeshBasicMaterial({
				map: createNodeTexture({ ...node.data, color }),
				transparent: true,
				depthWrite: false,
			});
		});
	}

	private applyMode(mode: ViewMode): void {
		this.mode = mode;
		this.simulationAlpha = Math.max(this.simulationAlpha, 0.8);
		this.controls.enableRotate = mode === '3d';
		// Rotating is meaningless in 2D, so drag pans there; in 3D drag still
		// orbits and panning stays on the right button.
		this.controls.mouseButtons = {
			LEFT: mode === '2d' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
			MIDDLE: THREE.MOUSE.DOLLY,
			RIGHT: THREE.MOUSE.PAN,
		};
		this.controls.touches = {
			ONE: mode === '2d' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE,
			TWO: THREE.TOUCH.DOLLY_PAN,
		};

		document.getElementById('view-2d')?.classList.toggle('active', mode === '2d');
		document.getElementById('view-3d')?.classList.toggle('active', mode === '3d');

		// Anchors sit on a circle in 2D and a sphere in 3D.
		if (this.clusterAnchors.size > 0) {
			this.computeClusterAnchors();
			this.buildClusterLabels();
			this.updateClusterLabelVisibility();
		}

		// Only the viewing direction matters here; frameAll() picks the distance.
		if (mode === '2d') {
			this.camera.position.set(0, 0, 720);
			this.controls.target.set(0, 0, 0);
		} else {
			this.camera.position.set(320, -420, 340);
			this.controls.target.set(0, 0, 0);
		}
		this.frameAll();
	}

	/**
	 * Distance at which every visible node fits inside the frustum. The layout
	 * grows with the note count, so a fixed zoom ceiling clips large graphs.
	 */
	private fitDistance(): number {
		const target = this.controls.target;
		let radius = 0;
		for (const node of this.nodes) {
			if (!node.visible) continue;
			radius = Math.max(radius, node.position.distanceTo(target));
		}
		if (radius === 0) return 720;

		// Node cards are billboards, so allow for one sticking out past the edge.
		radius += 60;

		const vFov = THREE.MathUtils.degToRad(this.camera.fov);
		const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
		return (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05;
	}

	/** Keep the zoom-out ceiling and far plane ahead of the current extent. */
	private updateZoomLimits(): void {
		const fit = this.fitDistance();
		this.controls.maxDistance = Math.max(1800, fit * 1.6);
		const far = Math.max(5000, this.controls.maxDistance * 2);
		if (far !== this.camera.far) {
			this.camera.far = far;
			this.camera.updateProjectionMatrix();
		}
	}

	/** Pull the camera back along its current direction until all nodes are in frame. */
	private frameAll(): void {
		this.updateZoomLimits();

		const direction = new THREE.Vector3()
			.subVectors(this.camera.position, this.controls.target);
		if (direction.lengthSq() === 0) direction.set(0, 0, 1);
		direction.normalize();

		this.camera.position
			.copy(this.controls.target)
			.addScaledVector(direction, this.fitDistance());
		this.controls.update();
	}

	/**
	 * `resettle` re-runs the force layout. It is off for date scrubbing: dimmed
	 * nodes stay in the simulation, so nothing should move while you drag, and
	 * a graph that reflows on every frame of a drag is unreadable.
	 */
	private applyFilters(resettle = true): void {
		const activeGroups = new Set<string>();
		document.querySelectorAll<HTMLInputElement>('.nb-filter:checked').forEach(
			cb => activeGroups.add(cb.dataset.group!),
		);
		const activeEdgeTypes = new Set<EdgeReasonType>();
		document.querySelectorAll<HTMLInputElement>('.edge-type-filter:checked').forEach(
			cb => activeEdgeTypes.add(cb.dataset.edgeType as EdgeReasonType),
		);

		const searchBox = document.getElementById('search-box') as HTMLInputElement;
		const query = searchBox.value.trim().toLowerCase();
		const visibleIds = new Set<number>();
		const dateRange = this.timeline?.state();

		for (const node of this.nodes) {
			const groupMatch = activeGroups.has(node.data.group);
			const searchMatch = this.searchMode === 'semantic'
				? this.semanticMatches === null || this.semanticMatches.has(node.data.id)
				: !query || node.data.label.toLowerCase().includes(query);
			const dateMatch = inDateRange(node.data, dateRange);

			// Out-of-range notes are faded rather than removed unless asked for,
			// which keeps the layout still and the surrounding structure legible.
			const hideForDate = !dateMatch && dateRange?.hide === true;
			node.visible = groupMatch && searchMatch && !hideForDate;
			node.dimmed = node.visible && !dateMatch;
			node.mesh.visible = node.visible;
			(node.mesh.material as THREE.MeshBasicMaterial).opacity =
				node.dimmed ? DIMMED_NODE_OPACITY : 1;
			if (node.visible) visibleIds.add(node.data.id);
		}

		let activeEdgeCount = 0;
		for (const edge of this.edges) {
			const typeMatch = getEdgeReasonTypes(edge.data).some(
				type => activeEdgeTypes.has(type),
			);
			edge.visible =
				edge.layout === this.layout &&
				typeMatch &&
				visibleIds.has(edge.data.from) &&
				visibleIds.has(edge.data.to);
			edge.line.visible = edge.visible;

			// An edge is only fully in range when both of its endpoints are.
			const dimmed = edge.visible && (
				this.nodeById.get(edge.data.from)?.dimmed === true ||
				this.nodeById.get(edge.data.to)?.dimmed === true
			);
			(edge.line.material as THREE.LineBasicMaterial).opacity =
				dimmed ? edge.baseOpacity * DIMMED_EDGE_FACTOR : edge.baseOpacity;
			if (edge.visible && !dimmed) activeEdgeCount++;
		}

		// Report what survived the filters, not what is merely on screen.
		const activeNodeCount = this.nodes.filter(
			node => node.visible && !node.dimmed,
		).length;
		updateStats(activeNodeCount, activeEdgeCount);
		if (resettle) this.simulationAlpha = Math.max(this.simulationAlpha, 0.55);
	}

	private animate(): void {
		requestAnimationFrame(() => this.animate());

		this.tickLayout();
		this.updateEdges();
		this.billboardNodes();
		// The force layout keeps spreading, so re-derive the ceiling as it settles.
		if (this.frameCount++ % 30 === 0) this.updateZoomLimits();
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	}

	private tickLayout(): void {
		if (this.simulationAlpha < 0.02) return;

		const alpha = this.simulationAlpha;
		const visibleNodes = this.nodes.filter(node => node.visible);
		const repulsion = this.mode === '3d' ? 1900 : 2600;
		const springLength = this.mode === '3d' ? 120 : 150;

		for (let i = 0; i < visibleNodes.length; i++) {
			for (let j = i + 1; j < visibleNodes.length; j++) {
				const a = visibleNodes[i];
				const b = visibleNodes[j];
				const delta = new THREE.Vector3().subVectors(a.position, b.position);
				if (this.mode === '2d') delta.z = 0;
				const distanceSq = Math.max(delta.lengthSq(), 1600);
				const force = (repulsion / distanceSq) * alpha;
				delta.normalize().multiplyScalar(force);
				a.velocity.add(delta);
				b.velocity.sub(delta);
			}
		}

		for (const edge of this.edges) {
			if (!edge.visible) continue;
			const from = this.nodeById.get(edge.data.from);
			const to = this.nodeById.get(edge.data.to);
			if (!from || !to) continue;

			const delta = new THREE.Vector3().subVectors(to.position, from.position);
			if (this.mode === '2d') delta.z = 0;
			const distance = Math.max(delta.length(), 1);
			const strength = THREE.MathUtils.clamp(edge.data.weight, 0.2, 3) * 0.006;
			const force = (distance - springLength) * strength * alpha;
			delta.normalize().multiplyScalar(force);
			from.velocity.add(delta);
			to.velocity.sub(delta);
		}

		// Pull each node towards its cluster's anchor instead of towards the origin,
		// which is what actually separates clusters in space. Without this every
		// cluster collapses into the same ball and only the colours differ.
		const clusters = this.graphData.clusters ?? [];
		const separation = this.graphData.separation ?? 0.6;
		const useAnchors = this.layout === 'semantic'
			&& this.clusterAnchors.size > 0
			&& separation > 0;

		for (const node of visibleNodes) {
			// Dragged/dropped nodes still push on their neighbours but stay put.
			if (node.pinned) {
				node.velocity.set(0, 0, 0);
				continue;
			}

			const anchor = useAnchors
				? this.clusterAnchors.get(clusters[node.data.id] ?? -1)
				: undefined;

			if (anchor) {
				const toAnchor = new THREE.Vector3().subVectors(anchor, node.position);
				if (this.mode === '2d') toAnchor.z = 0;
				node.velocity.add(toAnchor.multiplyScalar(0.004 * separation * alpha));
			} else {
				const centerPull = node.position.clone().multiplyScalar(-0.0018 * alpha);
				node.velocity.add(centerPull);
			}
			if (this.mode === '2d') {
				node.velocity.z += -node.position.z * 0.08 * alpha;
			}
			node.velocity.multiplyScalar(0.82);
			node.position.add(node.velocity);
			if (this.mode === '2d') node.position.z *= 0.82;
		}

		this.simulationAlpha *= 0.985;
	}

	private updateEdges(): void {
		for (const edge of this.edges) {
			if (!edge.visible) continue;
			const from = this.nodeById.get(edge.data.from);
			const to = this.nodeById.get(edge.data.to);
			if (!from || !to) continue;

			const positions = edge.line.geometry.attributes.position as THREE.BufferAttribute;
			positions.setXYZ(0, from.position.x, from.position.y, from.position.z);
			positions.setXYZ(1, to.position.x, to.position.y, to.position.z);
			positions.needsUpdate = true;
			edge.line.geometry.computeBoundingSphere();
		}
	}

	private billboardNodes(): void {
		for (const node of this.nodes) {
			if (!node.visible) continue;
			node.mesh.quaternion.copy(this.camera.quaternion);
		}
	}

	/** Raycast the visible nodes at a screen position; return the front-most. */
	private pickNode(clientX: number, clientY: number): LayoutNode | null {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);

		this.raycaster.setFromCamera(this.pointer, this.camera);
		const intersects = this.raycaster.intersectObjects(
			this.nodes.filter(node => node.visible).map(node => node.mesh),
			false,
		);
		if (!intersects.length) return null;

		const mesh = intersects[0].object as THREE.Mesh;
		return this.nodeById.get(mesh.userData.nodeId) || null;
	}

	/** Raycast visible edges at a screen position; used for reason previews. */
	private pickEdge(clientX: number, clientY: number): RenderEdge | null {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);

		this.raycaster.setFromCamera(this.pointer, this.camera);
		const visibleEdges = this.edges.filter(edge => edge.visible);
		const intersects = this.raycaster.intersectObjects(
			visibleEdges.map(edge => edge.line),
			false,
		);
		if (!intersects.length) return null;

		const line = intersects[0].object;
		return visibleEdges.find(edge => edge.line === line) || null;
	}

	/**
	 * Left-drag grabs a node if the pointer is over one, otherwise it falls
	 * through to OrbitControls and pans (or rotates, in 3D) the camera.
	 */
	private onPointerDown(event: PointerEvent): void {
		this.pointerDown.set(event.clientX, event.clientY);
		if (event.button !== 0) return;

		const node = this.pickNode(event.clientX, event.clientY);
		if (!node) return;

		this.draggedNode = node;
		node.pinned = true;
		node.velocity.set(0, 0, 0);

		// Slide along a plane facing the camera so the node tracks the cursor
		// at its current depth, whatever angle we're viewing from.
		const normal = this.mode === '2d'
			? new THREE.Vector3(0, 0, 1)
			: this.camera.getWorldDirection(new THREE.Vector3()).negate();
		this.dragPlane.setFromNormalAndCoplanarPoint(normal, node.position);

		if (this.raycastDragPlane(event.clientX, event.clientY)) {
			this.dragOffset.subVectors(node.position, this.dragHit);
		} else {
			this.dragOffset.set(0, 0, 0);
		}

		// Let the node move without the camera moving with it. OrbitControls has
		// already taken pointer capture on its own pointerdown, so move events
		// keep reaching the canvas even when the cursor leaves it.
		this.controls.enabled = false;
		this.renderer.domElement.style.cursor = 'grabbing';
	}

	private endNodeDrag(event: PointerEvent): void {
		if (!this.draggedNode) return;

		// A press that never moved is a click, not a drag: don't strand the node.
		// Anything actually dragged keeps its pin so the new arrangement sticks.
		const moved = this.pointerDown.distanceTo(
			new THREE.Vector2(event.clientX, event.clientY),
		) > 5;
		if (!moved) this.draggedNode.pinned = false;

		this.draggedNode = null;
		this.controls.enabled = true;
		this.renderer.domElement.style.cursor = '';
		// Let the rest of the graph settle around where it was dropped.
		this.simulationAlpha = Math.max(this.simulationAlpha, 0.5);
	}

	/** Project a screen position onto the active drag plane into `dragHit`. */
	private raycastDragPlane(clientX: number, clientY: number): boolean {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
		this.raycaster.setFromCamera(this.pointer, this.camera);
		return this.raycaster.ray.intersectPlane(this.dragPlane, this.dragHit) !== null;
	}

	private onPointerMove(event: PointerEvent): void {
		if (this.draggedNode) {
			if (this.raycastDragPlane(event.clientX, event.clientY)) {
				this.draggedNode.position.copy(this.dragHit).add(this.dragOffset);
				this.draggedNode.velocity.set(0, 0, 0);
				// Keep the neighbours reacting for as long as the drag lasts.
				this.simulationAlpha = Math.max(this.simulationAlpha, 0.35);
			}
			return;
		}

		// The pinned popup takes over; don't fight it with hover previews.
		if (this.pinnedNode) return;

		const node = this.pickNode(event.clientX, event.clientY);
		if (node) {
			this.hoveredNode = node;
			this.hoveredEdge = null;
			this.showHoverPopup(node, event.clientX, event.clientY);
			return;
		}

		const edge = this.pickEdge(event.clientX, event.clientY);
		if (edge) {
			this.hoveredNode = null;
			this.hoveredEdge = edge;
			this.showEdgePopup(edge, event.clientX, event.clientY);
			return;
		}

		this.hideHoverPopup();
	}

	private onClick(event: MouseEvent): void {
		// Ignore clicks that were really camera drags (rotate/pan).
		if (this.pointerDown.distanceTo(
			new THREE.Vector2(event.clientX, event.clientY),
		) > 5) return;

		const node = this.pickNode(event.clientX, event.clientY);
		if (node) this.pinPopup(node, event.clientX, event.clientY);
		else this.unpinPopup();
	}

	private showHoverPopup(node: LayoutNode, clientX: number, clientY: number): void {
		const popup = document.getElementById('hover-popup')!;
		popup.classList.remove('pinned');
		document.getElementById('hover-title')!.textContent =
			node.data.label || '(untitled)';
		document.getElementById('hover-notebook')!.textContent =
			node.data.notebook || '';
		document.getElementById('hover-body')!.textContent = node.data.preview || '';
		popup.style.display = 'block';
		this.positionPopup(popup, clientX, clientY);
	}

	private hideHoverPopup(): void {
		if (this.pinnedNode || (!this.hoveredNode && !this.hoveredEdge)) return;
		this.hoveredNode = null;
		this.hoveredEdge = null;
		document.getElementById('hover-popup')!.style.display = 'none';
	}

	/** Pin a scrollable, markdown-rendered card for the clicked note. */
	private pinPopup(node: LayoutNode, clientX: number, clientY: number): void {
		this.pinnedNode = node;
		this.hoveredNode = null;

		const popup = document.getElementById('hover-popup')!;
		popup.classList.add('pinned');
		document.getElementById('hover-title')!.textContent =
			node.data.label || '(untitled)';
		document.getElementById('hover-notebook')!.textContent =
			node.data.notebook || '';

		const bodyEl = document.getElementById('hover-body')!;
		bodyEl.innerHTML = renderMarkdown(node.data.body || node.data.preview || '');
		bodyEl.scrollTop = 0;

		const openLink = document.getElementById('popup-open') as HTMLAnchorElement;
		openLink.href = node.data.noteId ? `:/${node.data.noteId}` : '#';

		popup.style.display = 'block';
		this.positionPopup(popup, clientX, clientY);
	}

	private showEdgePopup(edge: RenderEdge, clientX: number, clientY: number): void {
		const from = this.nodeById.get(edge.data.from);
		const to = this.nodeById.get(edge.data.to);
		const popup = document.getElementById('hover-popup')!;
		popup.classList.remove('pinned');
		document.getElementById('hover-title')!.textContent =
			`${from?.data.label || 'Note'} <-> ${to?.data.label || 'Note'}`;
		document.getElementById('hover-notebook')!.textContent = 'Relationship';
		document.getElementById('hover-body')!.textContent =
			edge.data.title || describeEdge(edge.data);
		popup.style.display = 'block';
		this.positionPopup(popup, clientX, clientY);
	}

	private unpinPopup(): void {
		this.pinnedNode = null;
		document.getElementById('hover-popup')!.style.display = 'none';
	}

	private positionPopup(popup: HTMLElement, clientX: number, clientY: number): void {
		const width = popup.offsetWidth || 390;
		const height = popup.offsetHeight || 220;
		let x = clientX + 16;
		let y = clientY + 16;
		if (x + width > window.innerWidth) x = Math.max(8, clientX - width - 16);
		if (y + height > window.innerHeight) y = Math.max(8, clientY - height - 16);
		popup.style.left = `${x}px`;
		popup.style.top = `${y}px`;
	}

	private resize(): void {
		if (!this.container) return;
		const width = Math.max(this.container.clientWidth, 1);
		const height = Math.max(this.container.clientHeight, 1);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height, false);
	}
}

/**
 * Notes without the timestamp always pass: a missing date is not evidence that
 * the note falls outside the window, and silently dropping them would be worse
 * than showing them.
 */
function inDateRange(node: GraphNode, range: TimelineState | undefined): boolean {
	if (!range) return true;
	const time = range.field === 'created' ? node.created : node.updated;
	if (!time) return true;
	return time >= range.from && time <= range.to;
}

function createNodeTexture(node: GraphNode): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = NODE_TEXTURE_WIDTH;
	canvas.height = NODE_TEXTURE_HEIGHT;
	const ctx = canvas.getContext('2d')!;
	const background = node.color || '#4e79a7';

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	roundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 18);
	ctx.fillStyle = background;
	ctx.fill();
	ctx.lineWidth = 4;
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
	ctx.stroke();

	const lines = wrapText(ctx, node.label || '(untitled)', 260, MAX_LABEL_LINES);
	ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	ctx.fillStyle = '#ffffff';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
	ctx.shadowBlur = 5;

	const lineHeight = 28;
	const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;
	lines.forEach((line, index) => {
		ctx.fillText(line, canvas.width / 2, startY + index * lineHeight);
	});

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + width - radius, y);
	ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
	ctx.lineTo(x + width, y + height - radius);
	ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
	ctx.lineTo(x + radius, y + height);
	ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
}

function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number,
): string[] {
	ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';

	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (ctx.measureText(next).width <= maxWidth) {
			current = next;
			continue;
		}
		if (current) lines.push(current);
		current = word;
		if (lines.length === maxLines) break;
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (!lines.length) lines.push(text.slice(0, 24));

	const last = lines[lines.length - 1];
	if (words.join(' ') !== lines.join(' ') && last.length > 3) {
		lines[lines.length - 1] = `${last.replace(/\.+$/, '').slice(0, 24)}...`;
	}
	return lines;
}

function parseRgba(input: string): { color: THREE.Color; opacity: number } {
	const match = input.match(/rgba?\(([^)]+)\)/i);
	if (!match) return { color: new THREE.Color(input || '#999999'), opacity: 0.5 };
	const parts = match[1].split(',').map(part => Number(part.trim()));
	const [r, g, b, a] = parts;
	return {
		color: new THREE.Color((r || 0) / 255, (g || 0) / 255, (b || 0) / 255),
		opacity: a === undefined || Number.isNaN(a) ? 0.5 : a,
	};
}

function getEdgeReasonTypes(edge: GraphEdge): EdgeReasonType[] {
	if (edge.reasons?.length) {
		return [...new Set(edge.reasons.map(reason => reason.type))];
	}

	if (edge.color.includes('255,165,0')) return ['ticket'];
	if (edge.color.includes('100,100,255')) return ['link'];
	if (edge.color.includes('118,183,178')) return ['semantic'];
	return ['similarity'];
}

/** Canvas texture for a floating cluster name. */
function createClusterLabelTexture(text: string, color: string): THREE.Texture {
	const canvas = document.createElement('canvas');
	canvas.width = CLUSTER_LABEL_WIDTH;
	canvas.height = CLUSTER_LABEL_HEIGHT;

	const context = canvas.getContext('2d')!;
	context.clearRect(0, 0, canvas.width, canvas.height);

	context.font = 'bold 46px -apple-system, Segoe UI, sans-serif';
	context.textAlign = 'center';
	context.textBaseline = 'middle';

	// Dark outline so the text stays legible over nodes and edges of any colour.
	context.lineWidth = 8;
	context.strokeStyle = 'rgba(10, 10, 26, 0.92)';
	context.strokeText(text, canvas.width / 2, canvas.height / 2, canvas.width - 24);

	context.fillStyle = color;
	context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 24);

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

/** Update the count shown beside a relationship filter after a refresh. */
function updateEdgeTypeCount(type: EdgeReasonType, count: number): void {
	const row = document.querySelector<HTMLElement>(`[data-edge-type-row="${type}"]`);
	const text = row?.querySelector('span:last-child');
	if (text) text.textContent = `${EDGE_TYPE_LABELS[type]} (${count})`;
}

function edgeTypeHelp(type: EdgeReasonType): string {
	if (type === 'similarity') return 'Notes with TF-IDF cosine similarity above the threshold.';
	if (type === 'ticket') return 'Notes that mention the same Jira-style ticket key.';
	if (type === 'semantic') return 'Notes whose meaning is similar, according to the local embedding index.';
	return 'Notes connected by an internal Joplin note link.';
}

function describeEdge(edge: GraphEdge): string {
	if (!edge.reasons?.length) return 'Relationship';
	return edge.reasons.map(reason => {
		if (reason.type === 'similarity' || reason.type === 'semantic') {
			return `${reason.label} ${reason.weight.toFixed(2)}`;
		}
		return reason.detail ? `${reason.label}: ${reason.detail}` : reason.label;
	}).join(' + ');
}

function seededUnit(seed: number): number {
	const value = Math.sin(seed * 12.9898) * 43758.5453;
	return value - Math.floor(value);
}

function updateStats(nodeCount: number, edgeCount: number): void {
	const el = document.getElementById('stats-line');
	if (el) el.textContent = `${nodeCount} nodes, ${edgeCount} edges`;
}

document.addEventListener('DOMContentLoaded', init);
if (document.readyState !== 'loading') {
	init();
}

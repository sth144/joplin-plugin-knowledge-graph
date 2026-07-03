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
}

interface GraphEdge {
	from: number;
	to: number;
	weight: number;
	color: string;
	title?: string;
}

interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	folderColors: Record<string, string>;
}

interface LayoutNode {
	data: GraphNode;
	position: THREE.Vector3;
	velocity: THREE.Vector3;
	visible: boolean;
	mesh: THREE.Mesh;
}

interface RenderEdge {
	data: GraphEdge;
	line: THREE.Line;
	visible: boolean;
}

type ViewMode = '2d' | '3d';

const NODE_TEXTURE_WIDTH = 320;
const NODE_TEXTURE_HEIGHT = 120;
const MAX_LABEL_LINES = 2;

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

		loadingText.textContent = `Rendering ${graphData.nodes.length} nodes...`;
		buildFilterPanel(graphData.folderColors);

		const graph = new ThreeKnowledgeGraph(graphData);
		graph.mount(document.getElementById('graph-container')!);

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
	private readonly edges: RenderEdge[] = [];
	private readonly nodeById = new Map<number, LayoutNode>();
	private readonly controls: OrbitControls;
	private mode: ViewMode = '3d';
	private hoveredNode: LayoutNode | null = null;
	private pinnedNode: LayoutNode | null = null;
	private pointerDown = new THREE.Vector2();
	private searchTimeout: ReturnType<typeof setTimeout> | undefined;
	private simulationAlpha = 1;
	private container: HTMLElement | null = null;

	public constructor(private readonly graphData: GraphData) {
		this.scene.background = new THREE.Color('#171726');
		this.camera.position.set(320, -420, 340);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.minDistance = 120;
		this.controls.maxDistance = 1800;
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
		this.applyMode('3d');
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
			};
			this.nodes.push(layoutNode);
			this.nodeById.set(node.id, layoutNode);
			this.scene.add(mesh);
		}

		for (const edge of this.graphData.edges) {
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
			const renderEdge = { data: edge, line, visible: true };

			this.edges.push(renderEdge);
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
		canvas.addEventListener('pointerdown', (event) => {
			this.pointerDown.set(event.clientX, event.clientY);
		});
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
	}

	private applyMode(mode: ViewMode): void {
		this.mode = mode;
		this.simulationAlpha = Math.max(this.simulationAlpha, 0.8);
		this.controls.enableRotate = mode === '3d';

		document.getElementById('view-2d')?.classList.toggle('active', mode === '2d');
		document.getElementById('view-3d')?.classList.toggle('active', mode === '3d');

		if (mode === '2d') {
			this.camera.position.set(0, 0, 720);
			this.controls.target.set(0, 0, 0);
		} else {
			this.camera.position.set(320, -420, 340);
			this.controls.target.set(0, 0, 0);
		}
		this.controls.update();
	}

	private applyFilters(): void {
		const activeGroups = new Set<string>();
		document.querySelectorAll<HTMLInputElement>('.nb-filter:checked').forEach(
			cb => activeGroups.add(cb.dataset.group!),
		);

		const searchBox = document.getElementById('search-box') as HTMLInputElement;
		const query = searchBox.value.trim().toLowerCase();
		const visibleIds = new Set<number>();

		for (const node of this.nodes) {
			const groupMatch = activeGroups.has(node.data.group);
			const searchMatch =
				!query || node.data.label.toLowerCase().includes(query);
			node.visible = groupMatch && searchMatch;
			node.mesh.visible = node.visible;
			if (node.visible) visibleIds.add(node.data.id);
		}

		let visibleEdgeCount = 0;
		for (const edge of this.edges) {
			edge.visible = visibleIds.has(edge.data.from) && visibleIds.has(edge.data.to);
			edge.line.visible = edge.visible;
			if (edge.visible) visibleEdgeCount++;
		}

		updateStats(visibleIds.size, visibleEdgeCount);
		this.simulationAlpha = Math.max(this.simulationAlpha, 0.55);
	}

	private animate(): void {
		requestAnimationFrame(() => this.animate());

		this.tickLayout();
		this.updateEdges();
		this.billboardNodes();
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

		for (const node of visibleNodes) {
			const centerPull = node.position.clone().multiplyScalar(-0.0018 * alpha);
			node.velocity.add(centerPull);
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

	private onPointerMove(event: PointerEvent): void {
		// The pinned popup takes over; don't fight it with hover previews.
		if (this.pinnedNode) return;

		const node = this.pickNode(event.clientX, event.clientY);
		if (!node) {
			this.hideHoverPopup();
			return;
		}
		this.hoveredNode = node;
		this.showHoverPopup(node, event.clientX, event.clientY);
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
		if (this.pinnedNode || !this.hoveredNode) return;
		this.hoveredNode = null;
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

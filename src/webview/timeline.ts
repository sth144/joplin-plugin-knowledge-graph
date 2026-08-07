/**
 * Two-handle date range filter drawn along the bottom of the graph dialog.
 *
 * Native <input type="range"> only has one thumb, so the track, the handles and
 * the histogram behind them are all hand-rolled. The histogram is the point as
 * much as the filter is: it shows where the corpus actually sits in time, so
 * you can see which window is worth selecting before you select it.
 */

export type DateField = 'created' | 'updated';

export interface TimelineState {
	field: DateField;
	/** Inclusive epoch-ms bounds of the current selection. */
	from: number;
	to: number;
	/** Remove out-of-range notes from the layout rather than dimming them. */
	hide: boolean;
}

export interface TimelineNode {
	created: number;
	updated: number;
}

/** Buckets are ~3px wide, within these limits, so the shape stays legible. */
const MIN_BUCKETS = 24;
const MAX_BUCKETS = 160;
const HANDLE_KEY_STEP = 1 / 60;

const DAY_MS = 86400000;

export class Timeline {
	private field: DateField = 'created';
	/** Selection as fractions of the full range, so switching field keeps it. */
	private fromFraction = 0;
	private toFraction = 1;
	private hide = false;
	private bounds = { min: 0, max: 1 };
	private dragging: 'from' | 'to' | 'window' | null = null;
	/** Grab point within the window, as a fraction, for whole-window drags. */
	private windowGrab = 0;

	private root!: HTMLElement;
	private track!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private selection!: HTMLElement;
	private fromHandle!: HTMLElement;
	private toHandle!: HTMLElement;
	private readout!: HTMLElement;

	public constructor(
		private readonly nodes: TimelineNode[],
		/**
		 * `resettle` asks the caller to re-run the force layout. Scrubbing passes
		 * false: nothing should move under the cursor while you drag.
		 */
		private readonly onChange: (state: TimelineState, resettle: boolean) => void,
	) {}

	public mount(): void {
		this.root = document.getElementById('timeline')!;
		this.track = document.getElementById('timeline-track')!;
		this.canvas = document.getElementById('timeline-hist') as HTMLCanvasElement;
		this.selection = document.getElementById('timeline-selection')!;
		this.fromHandle = document.getElementById('timeline-from')!;
		this.toHandle = document.getElementById('timeline-to')!;
		this.readout = document.getElementById('timeline-readout')!;

		this.computeBounds();
		if (this.bounds.max <= this.bounds.min) {
			// Every note shares a timestamp (or there are none): nothing to filter.
			this.root.style.display = 'none';
			return;
		}

		this.bindFieldToggle();
		this.bindHideToggle();
		this.bindReset();
		this.bindDragging();

		window.addEventListener('resize', () => this.draw());
		this.render(false);
		// The dialog may not have been laid out yet, in which case the track has
		// no width and the first draw is a no-op.
		requestAnimationFrame(() => this.draw());
	}

	public state(): TimelineState {
		return {
			field: this.field,
			from: this.toTime(this.fromFraction),
			to: this.toTime(this.toFraction),
			hide: this.hide,
		};
	}

	/** True when the selection covers everything, i.e. the filter is inert. */
	public isFullRange(): boolean {
		return this.fromFraction <= 0 && this.toFraction >= 1;
	}

	private timeOf(node: TimelineNode): number {
		return this.field === 'created' ? node.created : node.updated;
	}

	private computeBounds(): void {
		let min = Infinity;
		let max = -Infinity;
		for (const node of this.nodes) {
			const time = this.timeOf(node);
			// Joplin always sets these, but a 0 would drag the axis back to 1970.
			if (!time) continue;
			if (time < min) min = time;
			if (time > max) max = time;
		}
		if (!isFinite(min) || !isFinite(max)) {
			this.bounds = { min: 0, max: 0 };
			return;
		}
		// Pad to a whole day either side so the extreme notes aren't on the edge.
		this.bounds = { min: min - DAY_MS, max: max + DAY_MS };
	}

	private toTime(fraction: number): number {
		return this.bounds.min + (this.bounds.max - this.bounds.min) * fraction;
	}

	private bindFieldToggle(): void {
		this.root.querySelectorAll<HTMLButtonElement>('[data-date-field]').forEach(
			button => button.addEventListener('click', () => {
				const field = button.dataset.dateField as DateField;
				if (field === this.field) return;
				this.field = field;
				this.root.querySelectorAll('[data-date-field]').forEach(
					other => other.classList.toggle(
						'active', other === button,
					),
				);
				// The selection is held as fractions, so it survives the switch
				// onto the new field's own min/max.
				this.computeBounds();
				this.render(this.hide);
			}),
		);
	}

	private bindHideToggle(): void {
		const input = document.getElementById('timeline-hide') as HTMLInputElement;
		input.addEventListener('change', () => {
			this.hide = input.checked;
			// Adding or removing nodes changes the resting shape, so this one
			// does warrant letting the layout re-pack.
			this.render(true);
		});
	}

	private bindReset(): void {
		document.getElementById('timeline-reset')!.addEventListener('click', (event) => {
			event.preventDefault();
			this.fromFraction = 0;
			this.toFraction = 1;
			this.render(this.hide);
		});
	}

	private bindDragging(): void {
		this.bindHandle(this.fromHandle, 'from');
		this.bindHandle(this.toHandle, 'to');

		// Dragging inside the selection slides the whole window, which is the
		// natural gesture for "same span, later period".
		this.selection.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			this.dragging = 'window';
			this.windowGrab = this.fractionAt(event.clientX) - this.fromFraction;
			this.selection.setPointerCapture(event.pointerId);
		});

		// Clicking bare track jumps the nearer handle to that point.
		this.track.addEventListener('pointerdown', (event) => {
			if (event.target !== this.track && event.target !== this.canvas) return;
			const fraction = this.fractionAt(event.clientX);
			const toFrom = Math.abs(fraction - this.fromFraction);
			const toTo = Math.abs(fraction - this.toFraction);
			this.dragging = toFrom <= toTo ? 'from' : 'to';
			this.moveTo(fraction);
			this.track.setPointerCapture(event.pointerId);
		});

		window.addEventListener('pointermove', (event) => {
			if (!this.dragging) return;
			event.preventDefault();
			this.moveTo(this.fractionAt(event.clientX));
		});

		const end = (): void => {
			if (!this.dragging) return;
			this.dragging = null;
			// Re-pack once the drag settles, but only if nodes actually left.
			if (this.hide) this.render(true);
		};
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);
	}

	private bindHandle(handle: HTMLElement, which: 'from' | 'to'): void {
		handle.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.dragging = which;
			handle.setPointerCapture(event.pointerId);
		});

		handle.addEventListener('keydown', (event) => {
			const direction = event.key === 'ArrowLeft' ? -1
				: event.key === 'ArrowRight' ? 1
					: 0;
			if (!direction) return;
			event.preventDefault();
			const step = direction * HANDLE_KEY_STEP * (event.shiftKey ? 5 : 1);
			const current = which === 'from' ? this.fromFraction : this.toFraction;
			this.dragging = which;
			this.moveTo(current + step);
			this.dragging = null;
			if (this.hide) this.render(true);
		});
	}

	private fractionAt(clientX: number): number {
		const rect = this.track.getBoundingClientRect();
		if (rect.width === 0) return 0;
		return clamp01((clientX - rect.left) / rect.width);
	}

	/** Move whichever part of the selection is being dragged to `fraction`. */
	private moveTo(fraction: number): void {
		const target = clamp01(fraction);
		if (this.dragging === 'from') {
			this.fromFraction = Math.min(target, this.toFraction);
		} else if (this.dragging === 'to') {
			this.toFraction = Math.max(target, this.fromFraction);
		} else if (this.dragging === 'window') {
			const span = this.toFraction - this.fromFraction;
			const start = clamp01(Math.min(target - this.windowGrab, 1 - span));
			this.fromFraction = start;
			this.toFraction = start + span;
		} else {
			return;
		}
		this.render(false);
	}

	private render(resettle: boolean): void {
		const left = this.fromFraction * 100;
		const right = this.toFraction * 100;
		this.selection.style.left = `${left}%`;
		this.selection.style.width = `${right - left}%`;
		this.fromHandle.style.left = `${left}%`;
		this.toHandle.style.left = `${right}%`;
		this.root.classList.toggle('filtered', !this.isFullRange());

		const state = this.state();
		this.readout.textContent = this.isFullRange()
			? `all ${this.field} dates`
			: `${formatDate(state.from)} — ${formatDate(state.to)}`;

		this.setAria(this.fromHandle, state.from);
		this.setAria(this.toHandle, state.to);

		this.draw();
		this.onChange(state, resettle);
	}

	private setAria(handle: HTMLElement, time: number): void {
		handle.setAttribute('aria-valuetext', formatDate(time));
		handle.setAttribute('aria-valuemin', String(this.bounds.min));
		handle.setAttribute('aria-valuemax', String(this.bounds.max));
		handle.setAttribute('aria-valuenow', String(Math.round(time)));
	}

	/**
	 * Draw the note-count histogram. Bars inside the selection are drawn bright
	 * and the rest muted, so the track doubles as a preview of what the current
	 * window actually keeps.
	 */
	private draw(): void {
		const width = this.track.clientWidth;
		const height = this.track.clientHeight;
		if (width === 0 || height === 0) return;

		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.round(width * ratio);
		this.canvas.height = Math.round(height * ratio);
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;

		const ctx = this.canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const bucketCount = Math.max(
			MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.floor(width / 3)),
		);
		const buckets = new Array<number>(bucketCount).fill(0);
		const span = this.bounds.max - this.bounds.min;

		for (const node of this.nodes) {
			const time = this.timeOf(node);
			if (!time) continue;
			const index = Math.min(
				bucketCount - 1,
				Math.max(0, Math.floor(((time - this.bounds.min) / span) * bucketCount)),
			);
			buckets[index]++;
		}

		const peak = Math.max(...buckets, 1);
		const barWidth = width / bucketCount;

		for (let i = 0; i < bucketCount; i++) {
			if (buckets[i] === 0) continue;
			// Square root keeps a handful of huge daybook days from flattening
			// everything else into invisibility.
			const scaled = Math.sqrt(buckets[i]) / Math.sqrt(peak);
			const barHeight = Math.max(2, scaled * (height - 4));
			const centre = (i + 0.5) / bucketCount;
			const inRange = centre >= this.fromFraction && centre <= this.toFraction;
			ctx.fillStyle = inRange
				? 'rgba(118, 183, 178, 0.85)'
				: 'rgba(255, 255, 255, 0.16)';
			ctx.fillRect(
				i * barWidth,
				height - barHeight,
				Math.max(1, barWidth - 1),
				barHeight,
			);
		}
	}
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function formatDate(time: number): string {
	return new Date(time).toLocaleDateString(undefined, {
		year: 'numeric', month: 'short', day: 'numeric',
	});
}

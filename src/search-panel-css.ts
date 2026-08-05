/**
 * Styles for the search panel.
 *
 * Kept as a TS string, matching how the graph dialog's CSS is handled in
 * index.ts, so it ships in the main bundle rather than needing a separate asset.
 * Colours come from Joplin's own CSS variables so the panel follows the active
 * theme instead of hard-coding a dark palette like the graph dialog does.
 */

export const PANEL_CSS = `
#kg-search {
	font-family: var(--joplin-font-family, sans-serif);
	font-size: var(--joplin-font-size, 13px);
	color: var(--joplin-color, #222);
	padding: 8px;
	box-sizing: border-box;
}

#kg-index-status {
	border: 1px solid var(--joplin-divider-color, rgba(0,0,0,0.15));
	border-radius: 6px;
	padding: 8px;
	margin-bottom: 10px;
	font-size: 0.9em;
}

#kg-status-text {
	color: var(--joplin-color-faded, #666);
}

#kg-status-text.kg-stale {
	color: var(--joplin-warning-text-color, #b8860b);
}

#kg-progress-track {
	display: none;
	height: 4px;
	margin-top: 6px;
	border-radius: 999px;
	background: var(--joplin-divider-color, rgba(0,0,0,0.12));
	overflow: hidden;
}

#kg-progress-track.kg-visible {
	display: block;
}

#kg-progress-bar {
	height: 100%;
	width: 0;
	border-radius: 999px;
	background: var(--joplin-color-correct, #4e79a7);
	transition: width 0.3s ease;
}

#kg-status-actions {
	display: flex;
	gap: 6px;
	margin-top: 8px;
}

#kg-status-actions button {
	flex: 1;
	padding: 4px 6px;
	font-family: inherit;
	font-size: 0.9em;
	cursor: pointer;
	color: var(--joplin-color, #222);
	background: var(--joplin-background-color3, rgba(0,0,0,0.05));
	border: 1px solid var(--joplin-divider-color, rgba(0,0,0,0.15));
	border-radius: 4px;
}

#kg-status-actions button:hover {
	background: var(--joplin-background-color-hover3, rgba(0,0,0,0.1));
}

#kg-status-actions button[hidden] {
	display: none;
}

#kg-query {
	width: 100%;
	padding: 6px 8px;
	box-sizing: border-box;
	font-family: inherit;
	font-size: 1em;
	color: var(--joplin-color, #222);
	background: var(--joplin-background-color, #fff);
	border: 1px solid var(--joplin-divider-color, rgba(0,0,0,0.25));
	border-radius: 4px;
}

#kg-error {
	display: none;
	margin-top: 8px;
	padding: 6px 8px;
	border-radius: 4px;
	font-size: 0.9em;
	color: var(--joplin-color-error, #a11);
	background: var(--joplin-background-color3, rgba(170,17,17,0.08));
	word-break: break-word;
}

#kg-error.kg-visible {
	display: block;
}

.kg-heading {
	margin: 14px 0 6px;
	font-weight: bold;
	font-size: 0.85em;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--joplin-color-faded, #777);
}

.kg-hit {
	display: block;
	width: 100%;
	text-align: left;
	padding: 7px 8px;
	margin-bottom: 4px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	font-family: inherit;
	font-size: 1em;
	color: inherit;
	cursor: pointer;
}

.kg-hit:hover {
	background: var(--joplin-background-color-hover3, rgba(0,0,0,0.06));
}

.kg-hit-top {
	display: flex;
	align-items: baseline;
	gap: 6px;
}

.kg-hit-score {
	flex: none;
	font-variant-numeric: tabular-nums;
	font-size: 0.85em;
	color: var(--joplin-color-faded, #888);
}

.kg-hit-title {
	font-weight: 600;
	overflow-wrap: anywhere;
}

.kg-hit-snippet {
	margin-top: 3px;
	font-size: 0.9em;
	line-height: 1.35;
	color: var(--joplin-color-faded, #666);
	overflow-wrap: anywhere;
}

#kg-settings-hint {
	margin-top: 16px;
	padding-top: 10px;
	border-top: 1px solid var(--joplin-divider-color, rgba(0,0,0,0.12));
	font-size: 0.85em;
	line-height: 1.4;
	color: var(--joplin-color-faded, #888);
}

.kg-empty {
	font-size: 0.9em;
	color: var(--joplin-color-faded, #888);
	padding: 2px 0 6px;
}
`;

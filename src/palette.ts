/**
 * Shared categorical colours for notebooks and clusters.
 *
 * Extracted so the graph builder and the dialog's semantic refresh assign the
 * same colour to the same cluster id — they run at different times and would
 * otherwise drift.
 */

export const PALETTE = [
	'#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
	'#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
	'#86bcb6', '#8cd17d', '#b6992d', '#499894', '#d37295',
	'#a0cbe8', '#ffbe7d', '#d4a6c8',
];

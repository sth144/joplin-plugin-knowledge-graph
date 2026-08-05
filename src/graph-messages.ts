/**
 * The request/response contract between the graph dialog and the plugin.
 *
 * Dialogs have no push channel, but a dialog webview *can* call postMessage and
 * receive the handler's return value, so everything here is request/response.
 * Indexing progress is therefore polled by the webview rather than pushed.
 *
 * Shared by both sides so the shapes cannot drift apart.
 */

/** Every tunable, keyed as it appears in plugin settings. */
export interface ConfigValues {
	[key: string]: number | boolean | string;
}

export interface IndexStatusReport {
	notes: number;
	chunks: number;
	building: boolean;
	done: number;
	total: number;
	etaSeconds: number | null;
	/** Index was built with different chunking settings than are now set. */
	stale: boolean;
}

/** Note-id-keyed semantic view, translated to node indices by the webview. */
export interface SemanticPayload {
	edges: Array<{ a: string; b: string; score: number }>;
	clusters: Record<string, number>;
	clusterLabels: Record<string, string>;
	clusterColors: Record<string, string>;
	separation: number;
}

export interface SearchResult {
	noteId: string;
	score: number;
}

export type GraphRequest =
	| { type: 'link'; link: string }
	| { type: 'getConfig' }
	| { type: 'setConfig'; values: ConfigValues }
	| { type: 'indexStatus' }
	| { type: 'buildIndex'; rebuild?: boolean }
	| { type: 'cancelIndex' }
	| { type: 'refreshSemantic' }
	| { type: 'semanticSearch'; text: string };

export interface ConfigResponse {
	values: ConfigValues;
	status: IndexStatusReport;
}

export interface SemanticResponse {
	payload: SemanticPayload | null;
	status: IndexStatusReport;
	/** Set when the view could not be rebuilt, for display in the panel. */
	error?: string;
}

export interface SearchResponse {
	results: SearchResult[];
	error?: string;
}

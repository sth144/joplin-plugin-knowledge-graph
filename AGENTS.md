# AGENTS.md — Knowledge Graph Plugin

This file gives AI coding agents the context needed to work on this project
without reading every file from scratch.

## What This Project Is

A Joplin desktop plugin that builds an interactive knowledge graph from the user's
note library. Notes become nodes; edges are derived from content similarity
(TF-IDF), shared Jira-style ticket references, and internal Joplin note links.
The graph renders in a full-screen dialog using vis-network.

## Repository Layout

```
joplin-plugin-knowledge-graph/
  api/                     Joplin API type stubs (not a real npm package)
    index.ts               Re-exports the runtime `joplin` global with full types
    types.ts               Enums and primitive types (ToolbarButtonLocation, etc.)
  src/
    index.ts               Plugin entry point — registers commands, toolbar button, dialog
    graph-builder.ts       Fetches notes/folders, computes all edges, returns GraphData
    tfidf.ts               Pure TS TF-IDF + cosine similarity, no external deps
    webview/
      graph.ts             Webview script — requests data, renders vis-network graph
      graph.css            Webview styles (dark theme, control panel, hover popup)
    manifest.json          Joplin plugin manifest (id, version, min app version)
  plugin.config.json       Declares webview scripts for the buildExtraScripts phase
  webpack.config.js        Three-phase build: buildMain, buildExtraScripts, createArchive
  tsconfig.json            TypeScript config; excludes src/webview/** (separate compilation)
  package.json             npm scripts and dependencies
```

## Architecture: Two Separate Processes

The plugin runs in two isolated JavaScript environments that cannot share imports.

### Plugin Process (`src/index.ts`, `src/graph-builder.ts`, `src/tfidf.ts`)

- Has access to `joplin.data`, `joplin.views`, `joplin.commands` etc.
- Runs in a Node.js-like sandbox.
- Compiled by webpack's `buildMain` phase into `dist/index.js` (CommonJS target).
- `graph-builder.ts` paginates through all notes and folders via `joplin.data.get`,
  runs TF-IDF and regex extraction, and assembles `GraphData`.

### Webview Process (`src/webview/graph.ts`, `src/webview/graph.css`)

- Runs in a browser-like sandbox inside the Joplin dialog.
- Has access to `webviewApi` (injected global) but NOT to `joplin.*`.
- Has access to the DOM.
- Cannot import from `src/` (graph-builder, tfidf) — those run in the plugin process.
- Compiled by webpack's `buildExtraScripts` phase as an IIFE with `library.type = 'window'`.
- vis-network and vis-data are bundled here (they are `dependencies`, not `devDependencies`).

### Communication

The two processes communicate exclusively via `postMessage`:

1. Webview sends: `webviewApi.postMessage({ type: 'requestGraphData' })`
2. Plugin process responds from the `onMessage` handler in `index.ts` by returning
   the pre-built `GraphData` object.

The plugin builds graph data before opening the dialog so the response is immediate.

## The `api/` Directory

`api/index.ts` and `api/types.ts` are hand-written type stubs for the Joplin plugin
API. They are NOT an npm package and are NOT installed via node_modules.

They are resolved via a webpack `resolve.alias` in `buildMainConfig()`:

```js
resolve: {
  alias: {
    api: path.resolve(rootDir, 'api'),
  },
}
```

And via `tsconfig.json` paths for the TypeScript compiler:

```json
"paths": {
  "api":  ["./api/index"],
  "api/*": ["./api/*"]
}
```

**Do not add `api` to webpack `externals`** — that would cause a runtime error
because the module would not be bundled and the Joplin sandbox does not provide it
as a resolvable module name. The alias approach bundles the stubs into `dist/index.js`
while `api/index.ts` recovers the actual runtime object via `(global as any).joplin`.

## Build System

The `npm run dist` script runs webpack three times in sequence:

| Phase | `--env joplin-plugin-config=` | What it does |
|---|---|---|
| 1 | `buildMain` | Compiles `src/index.ts` + `src/graph-builder.ts` + `src/tfidf.ts` into `dist/index.js` (CommonJS, Node target). Copies `manifest.json` to `dist/`. |
| 2 | `buildExtraScripts` | Compiles each script listed in `plugin.config.json` `extraScripts` (currently `src/webview/graph.ts`) into `dist/webview/graph.js` (IIFE, web target, `library.type=window`). vis-network is bundled here. |
| 3 | `createArchive` | Copies CSS files into `dist/webview/`, then tars `dist/` into `publish/com.seanhinds.knowledge-graph.jpl`. |

Running `npm run build` or plain `npx webpack` runs `buildMain` only (the default
branch in `webpack.config.js`). Useful for a quick type-check build without packaging.

### Webview Output Must Be IIFE

The webview bundle must use `output.library.type = 'window'` (which implies IIFE
wrapping). Using `commonjs` or `module` output here will cause a runtime error
because the Joplin dialog sandbox does not have a `require` function and does not
support ES module `<script type="module">` tags.

### CSP Constraint

The Joplin webview enforces a Content Security Policy that disallows inline scripts.
All JavaScript must be loaded as external script files registered via
`joplin.views.dialogs.addScript()`. Do not inject `<script>` tags in the HTML
string passed to `setHtml()`.

## Key Data Types

### `GraphData` (returned by `buildGraphData`, consumed by webview)

```typescript
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  folderColors: Record<string, string>;  // notebook path → hex color
}

interface GraphNode {
  id: number;            // array index into the notes array
  label: string;         // note title
  group: string;         // full notebook path, e.g. "Areas / Daybook"
  color: string;         // hex from PALETTE, assigned per notebook path
  size: number;          // 8–25, scaled from body length
  notebook: string;      // same as group, used for hover display
  preview: string;       // first 300 chars of body, markdown stripped
}

interface GraphEdge {
  from: number;
  to: number;
  weight: number;        // accumulated weight when edges are merged
  color: string;         // rgba string distinguishing edge type
  title?: string;        // tooltip — shared ticket keys, comma-separated
}
```

## Edge Types and Their Colors

| Relationship | Detection | `color` value |
|---|---|---|
| Content similarity | TF-IDF cosine >= 0.15 | `rgba(150,150,150,0.3)` |
| Shared Jira ticket | Same `[A-Z]{2,10}-\d+` key in both notes | `rgba(255,165,0,0.5)` |
| Internal link | `[text](:/<32-char-hex-id>)` Joplin link syntax | `rgba(100,100,255,0.6)` |

When two notes share multiple relationship types, `addOrMergeEdge` combines them
into a single edge by accumulating weight and appending ticket keys to `title`.

## TF-IDF Implementation Notes (`src/tfidf.ts`)

- Terms appearing in fewer than 2 documents or more than 80% of documents are
  excluded from the vocabulary before computing vectors.
- Vectors are L2-normalized before storage so cosine similarity reduces to a dot
  product.
- The implementation uses sparse vectors (`Map<termIndex, value>`) and iterates the
  smaller of the two vectors for pairwise similarity, keeping it tractable for
  libraries with hundreds of notes.
- `stripMarkdown` is exported and reused in `graph-builder.ts` to generate the hover
  preview text.

## Testing / Development Workflow

There is no automated test suite. To test changes:

1. Run `npm run dist` to build and package.
2. In Joplin desktop: **Settings > Plugins > Development plugins**, add this project's
   directory path.
3. Restart Joplin.
4. Click the toolbar button or use **Tools > Show Knowledge Graph**.
5. Check the Joplin log (Help > Open Profile Directory > log.txt) for plugin process
   output — `buildGraphData` logs progress via `console.info`.

For webview errors, open the developer tools in the dialog (right-click > Inspect,
if enabled in your Joplin build).

## Common Pitfalls

- **Importing plugin-process modules in the webview.** `graph.ts` cannot import from
  `graph-builder.ts` or `tfidf.ts`. Data must travel via `postMessage`.
- **Using `externals` for the `api` module.** See the `api/` section above — use
  `resolve.alias` instead.
- **Adding native Node.js modules as dependencies.** The plugin sandbox restricts
  native modules. Keep dependencies pure-JS.
- **`tsconfig.json` excludes `src/webview/**`** — the webview is compiled by
  webpack's ts-loader with inline `compilerOptions` overrides, not by the root
  tsconfig. Type errors in `graph.ts` will not surface in a plain `tsc` run.

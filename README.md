# Joplin Plugin: Knowledge Graph

An interactive knowledge graph for Joplin that maps relationships across all your notes.

![Knowledge Graph](docs/demo.gif)

_Recorded against a synthetic note library — every title, notebook and cluster
label above is made up._

## What It Does

The plugin scans every note in your Joplin library and builds a force-directed graph
where notes are nodes and edges represent discovered relationships. Open it once and
you get a bird's-eye view of how your thinking is connected.

## Features

- Force-directed layout via vis-network (ForceAtlas2 physics)
- Nodes color-coded by notebook, with breadcrumb paths for nested notebooks
- Node size scales with note length
- Search box to highlight notes by title
- Notebook filter panel with "all / none" shortcuts
- Date range slider along the bottom, with a histogram of when notes were written
- Hover popups showing the note title, notebook path, and a content preview
- Semantic clustering: switch the graph from links/TF-IDF to embedding similarity
- Semantic search panel: find notes by meaning, plus "related to this note"
- Fully offline — the embedding model is bundled in the plugin, nothing is sent anywhere
- Opens as a full-screen dialog inside Joplin

## Installation

**Option 1 — Install from file**

1. Download the latest `.jpl` file from the [Releases](https://github.com/seanhinds/joplin-plugin-knowledge-graph/releases) page.
2. In Joplin: **Settings > Plugins > Install from file**, select the `.jpl` file.
3. Restart Joplin.

**Option 2 — Development mode**

1. Clone this repository.
2. In Joplin: **Settings > Plugins > Development plugins**, add the path to the cloned directory.
3. Restart Joplin.

## Usage

After installation, open the graph using either:

- The graph icon in the **Note Toolbar**
- **Tools > Show Knowledge Graph**

The graph builds synchronously when the command is invoked, then the dialog opens.
For large libraries this may take a few seconds. Press **Escape** or click **Close**
to dismiss it.

### Navigating the graph

- **Drag empty space** to pan in 2D, or to orbit in 3D (right-drag pans there).
- **Scroll** to zoom. The zoom-out limit follows the size of the layout, so the
  whole graph always fits however many notes you have.
- **Drag a note** to move it. The rest of the graph re-settles around it and the
  note stays where you dropped it; switching relationship model clears all of
  those hand placements.
- **Click a note** to pin its card open.

### Filtering by date

The bar along the bottom filters notes by **Created** or **Updated** date. The
histogram behind the track shows how many notes fall in each period, so you can
see where your writing actually clusters before choosing a window. Drag either
handle to resize the window, or drag the middle to slide it.

Out-of-range notes fade out rather than disappearing, which keeps the layout
still while you scrub and leaves the surrounding structure readable. Tick **Hide
filtered** to drop them from the graph entirely and let it re-pack.

Prefer **Created** for "when did this thinking happen" — sync activity tends to
smear updated timestamps.

## Semantic Search and Clustering

Both features run on a local embedding index. The model
([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), quantized ONNX,
384 dimensions) ships inside the `.jpl`, so indexing and searching work with no
network access, no API key, and no account. This is why the plugin download is
around 20MB.

### Building the index

Either click **Build semantic index** in the graph's control panel (shown whenever no
index exists), or run **Tools > Build semantic index**. Indexing happens in the background with a
progress bar in the search panel, and can be cancelled and resumed — notes already
embedded are skipped on the next run.

Expect roughly **1,400 characters per second**, measured on a 2MB library of real
notes on Apple Silicon. That library took 28 minutes for a full first index.

### Keeping the index current

You only build once. After that the index maintains itself:

- **While you edit** — a changed note is re-embedded about five seconds after you
  stop typing, taking a second or two. New notes and deletions are handled the same way.
- **After a sync** — timestamps are compared against the index, so changes that
  arrived from another device are caught even though no edit event fired locally.
- **At startup** — the same comparison runs 20 seconds after launch, which catches
  anything that changed while the plugin was disabled or Joplin was closed.

The comparison pass reads only note ids and timestamps, never bodies, so it is cheap
to run repeatedly; only notes that actually changed get re-embedded.

If your library contains a few enormous notes that dominate that time, set
**Maximum characters indexed per note** to bound it.

### Semantic search

The magnifier icon in the **Note Toolbar**, or **Tools > Toggle semantic search
panel**, opens a sidebar with:

- a query box that ranks notes by meaning rather than by keyword
- the best-matching passage from each result as a snippet
- a **Related to this note** section that follows your selection

By default, results blend in Joplin's own keyword search (30%). Pure vector search
is weak at exact strings — searching `APPS-1234` is nearly meaningless to an
embedding model — so the blend restores exact-match recall. Set the blend to 0 for
pure meaning-based search.

### Semantic distance and clustering in the graph

With an index built, the graph's control panel offers a choice of relationship model:

- **Links & TF-IDF** — the original view described above
- **Semantic distance** — notes connected by embedding similarity

Edges here come from *mutual* nearest neighbours rather than a similarity cutoff.
Embedding similarities bunch into a narrow band, so a fixed threshold tends to
produce either nothing or a hairball; requiring that two notes each count the other
among their nearest neighbours adapts to how dense each part of the library is.

Within that view, **Group into clusters** partitions the library with k-means. When
it is on, notes are coloured by cluster, each cluster is pulled toward its own point
in space so the groups are visibly separate, and each is given an inferred name.
When it is off the view keeps notebook colours, so it is directly comparable to the
link view.

Clustering is k-means over the note vectors rather than community detection over the
edges. Label propagation was tried first and produced connected components, not
clusters: on a 305-note library it gave 101 groups, half of them singletons, because
a note with no surviving edge can never join a group. k-means partitions the whole
vector space, so every note lands somewhere and the count is controllable — set it
explicitly, or leave it at 0 and several candidates are tried and scored.

Cluster names come from the notes' own vocabulary: a term names a cluster well when
it is common inside it and rare outside, which is TF-IDF with clusters standing in
for documents. No language model is involved — the plugin only ships an embedding
model, which cannot generate text.

### Everything is adjustable from the graph

The **Semantic index & parameters** section of the graph's control panel holds every
parameter described under Configuration below, plus the indexing controls:

- **Build index** / **Re-vectorize** / **Cancel**, with progress and an ETA
- **Recompute clusters**, which re-clusters from the existing vectors in a couple of
  seconds and updates the graph in place, without reopening it

Changes are written to the same plugin settings shown in Joplin's settings screen, so
the graph, the search panel and the settings screen never disagree. Vectorization
settings change the stored vectors and so need a re-vectorize; clustering settings
only need **Recompute clusters**; search settings apply on the next query.

The graph's search box also has a **Titles / Meaning** toggle, so semantic search can
be used to narrow the graph itself, not just the sidebar panel.

## How Connections Work

Three types of edges are drawn between notes:

| Edge type | Color | How it's detected |
|---|---|---|
| Content similarity | Gray, semi-transparent | TF-IDF cosine similarity >= 0.15 across note bodies |
| Shared ticket reference | Orange, semi-transparent | Two or more notes mention the same Jira-style key (e.g., `APPS-1234`) |
| Internal link | Blue, semi-transparent | A note contains a Joplin internal link (`[text](:/<note-id>)`) pointing to another note |

When multiple relationship types exist between the same two notes, their edges are
merged into a single weighted edge.

## Configuration

Semantic search and clustering are configurable under **Settings > Knowledge Graph**.

Indexing settings change the stored vectors, so changing one means rebuilding the
index; the panel tells you when a rebuild is pending.

| Setting | Default | Effect |
|---|---|---|
| Chunk size (characters) | 500 | Target size per indexed passage. A target only — the model reads at most 256 tokens, and longer passages are split again so no text is lost. Dense content like code and URLs uses far more tokens per character than prose, so raising this mostly causes more splitting. |
| Chunk overlap | 80 | Text shared between consecutive passages, so an idea spanning a boundary is still captured whole somewhere. |
| Minimum chunk size | 80 | Passages shorter than this are skipped; tiny fragments match everything. |
| Maximum characters per note | 0 (no limit) | Bounds how much of each note is read. Useful when a few very long notes dominate indexing time. |
| Indexing batch size | 16 | Passages embedded per batch. Bounds memory; larger batches make cancelling less responsive. |

Clustering and search settings apply immediately, with no rebuild:

| Setting | Default | Effect |
|---|---|---|
| Group notes into clusters | on | Partition with k-means, colouring and separating notes by cluster. Off keeps notebook colours and shows distance only. |
| Number of clusters | 0 (automatic) | Automatic tries several counts and keeps the tightest, best-separated grouping. |
| Cluster separation | 0.6 | How strongly the layout pulls clusters apart. At 0 the graph settles into one ball. |
| Semantic neighbours per note | 6 | How many nearest notes each note may connect to. Higher is denser and harder to read. |
| Minimum similarity for an edge | 0.35 | Similarity floor for semantic edges. Values bunch in 0.3–0.6, so small changes matter. |
| Only connect mutual neighbours | on | Require both notes to count each other as near. Off produces many more edges, often dominated by notes vaguely similar to everything. |
| How to compare notes | Best matching section | Compare notes by their single best-matching passage, or by whole-note average. "Best matching section" suits long, wide-ranging notes; the average is blurrier for them. |
| Search results shown | 20 | Result count. |
| Minimum search score | 0.25 | Hides weak results. Ignored when keyword blending is on, since keyword-only hits have no vector score. |
| Keyword search blend | 0.3 | How much of Joplin's keyword search to mix in, by reciprocal rank fusion. 0 is pure meaning-based. |

The TF-IDF threshold for the original view is still a constant at the top of
`src/graph-builder.ts`:

```typescript
const SIMILARITY_THRESHOLD = 0.15;
```

## Building from Source

Prerequisites: Node.js >= 18, npm.

```bash
git clone https://github.com/seanhinds/joplin-plugin-knowledge-graph.git
cd joplin-plugin-knowledge-graph
npm install
npm run dist
```

The compiled plugin archive is written to `publish/com.seanhinds.knowledge-graph.jpl`.

`npm run dist` first runs `npm run fetch-model`, which downloads the embedding model
into `assets/models/` (~23MB, not committed). That is the only step that uses the
network; the built plugin bundles the model and never fetches anything at runtime.

## Tech Stack

| Component | Technology |
|---|---|
| Plugin logic | TypeScript, Joplin Plugin API |
| Graph rendering | Three.js (custom force-directed layout) |
| Keyword similarity | Custom TF-IDF + cosine similarity (no external deps) |
| Embeddings | transformers.js + onnxruntime-web (WASM), all-MiniLM-L6-v2 bundled |
| Vector storage | SQLite in the plugin data directory |
| Bundler | webpack 5 |

### Notes on the embedding build

Two things about the bundling are load-bearing and easy to break:

- `webpack.config.js` aliases `@huggingface/transformers` and `onnxruntime-web` to
  their **web** builds. Under `target: 'node'` webpack would otherwise pick the
  `node` export condition, which statically requires `onnxruntime-node` — a native
  module that cannot ship in a `.jpl`.
- `src/embeddings/runtime.ts` masks `process.release.name` while transformers.js
  evaluates, because the library picks its backend from that value at import time
  and would otherwise select the (stubbed-out) node runtime and fail with
  `Cannot read properties of undefined (reading 'wasm')`.

`src/embeddings/assets.ts` then feeds the runtime the bundled model files and WASM
binary directly, and clears the CDN `wasmPaths` transformers.js sets by default —
that last step is what makes "no network access" actually true.

## License

MIT

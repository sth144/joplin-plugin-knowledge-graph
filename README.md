# Joplin Plugin: Knowledge Graph

An interactive knowledge graph for Joplin that maps relationships across all your notes.

![Knowledge Graph](docs/screenshot.png)

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
- Hover popups showing the note title, notebook path, and a content preview
- Fully offline — vis-network is bundled by webpack, no CDN calls
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
For large libraries this may take a few seconds.

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

The similarity threshold is defined as a constant at the top of `src/graph-builder.ts`:

```typescript
const SIMILARITY_THRESHOLD = 0.15;
```

Lowering this value draws more edges (higher recall, more noise). Raising it draws
fewer edges (higher precision, sparser graph). This is not yet exposed as a
user-facing setting.

## Building from Source

Prerequisites: Node.js >= 18, npm.

```bash
git clone https://github.com/seanhinds/joplin-plugin-knowledge-graph.git
cd joplin-plugin-knowledge-graph
npm install
npm run dist
```

The compiled plugin archive is written to `publish/com.seanhinds.knowledge-graph.jpl`.

## Tech Stack

| Component | Technology |
|---|---|
| Plugin logic | TypeScript, Joplin Plugin API |
| Graph rendering | vis-network 10, vis-data 8 |
| Similarity engine | Custom TF-IDF + cosine similarity (no external deps) |
| Bundler | webpack 5 |

## License

MIT

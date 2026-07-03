/**
 * Minimal, dependency-free Markdown renderer for the pinned note popup.
 *
 * It HTML-escapes the raw note body FIRST, then applies formatting, so the
 * output is XSS-safe by construction — a note containing "<script>" is shown
 * as text, never executed. It covers the common cases (headings, emphasis,
 * code, links, lists, blockquotes, rules); anything else falls through as a
 * plain paragraph. For the full, faithful render, the popup links to the note.
 */

const SAFE_LINK = /^(https?:|mailto:|joplin:)/i;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Build a safe anchor. Internal note links (":/id") are kept as-is; the webview
 * intercepts clicks and hands the href to the plugin's openItem command, which
 * resolves both internal links and external URLs. Unsafe schemes are dropped.
 */
function renderLink(label: string, url: string): string {
	const internal = /^:\/[0-9a-f]{32}$/i.test(url);
	if (!internal && !SAFE_LINK.test(url)) return label;
	return `<a href="${url}" rel="noopener">${label}</a>`;
}

/** Inline formatting on already-escaped text: code, bold, italic, links. */
function renderInline(text: string): string {
	return text
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
			renderLink(label, url),
		);
}

function renderHeading(line: string): string {
	const match = line.match(/^(#{1,6})\s+(.*)$/)!;
	const level = match[1].length;
	return `<h${level}>${renderInline(match[2])}</h${level}>`;
}

/** Consume a fenced ``` code block; returns the index after the closing fence. */
function renderFence(lines: string[], start: number, out: string[]): number {
	const code: string[] = [];
	let i = start + 1;
	while (i < lines.length && !/^```/.test(lines[i])) {
		code.push(lines[i]);
		i++;
	}
	out.push(`<pre><code>${code.join('\n')}</code></pre>`);
	return i + 1;
}

/** Consume a run of list items into a <ul> or <ol>. */
function renderList(lines: string[], start: number, out: string[]): number {
	const ordered = /^\s*\d+\.\s+/.test(lines[start]);
	const items: string[] = [];
	let i = start;
	while (i < lines.length && isListItem(lines[i])) {
		const content = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
		items.push(`<li>${renderInline(content)}</li>`);
		i++;
	}
	const tag = ordered ? 'ol' : 'ul';
	out.push(`<${tag}>${items.join('')}</${tag}>`);
	return i;
}

// Lines are already HTML-escaped, so a leading ">" now reads as "&gt;".
const QUOTE_PREFIX = /^\s*&gt;\s?/;

/** Consume consecutive blockquote lines into a single <blockquote>. */
function renderQuote(lines: string[], start: number, out: string[]): number {
	const quoted: string[] = [];
	let i = start;
	while (i < lines.length && QUOTE_PREFIX.test(lines[i])) {
		quoted.push(renderInline(lines[i].replace(QUOTE_PREFIX, '')));
		i++;
	}
	out.push(`<blockquote>${quoted.join('<br />')}</blockquote>`);
	return i;
}

/** Consume consecutive non-blank text lines into a single <p>. */
function renderParagraph(lines: string[], start: number, out: string[]): number {
	const text: string[] = [];
	let i = start;
	while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
		text.push(renderInline(lines[i]));
		i++;
	}
	out.push(`<p>${text.join('<br />')}</p>`);
	return i;
}

function isListItem(line: string): boolean {
	return /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function isBlockStart(line: string): boolean {
	return (
		/^#{1,6}\s/.test(line) ||
		/^```/.test(line) ||
		QUOTE_PREFIX.test(line) ||
		/^\s*([-*_])\1{2,}\s*$/.test(line) ||
		isListItem(line)
	);
}

/** Render escaped markdown into safe HTML. */
export function renderMarkdown(markdown: string): string {
	const lines = escapeHtml(markdown).split('\n');
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (/^```/.test(line)) i = renderFence(lines, i, out);
		else if (/^#{1,6}\s/.test(line)) { out.push(renderHeading(line)); i++; }
		else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr />'); i++; }
		else if (isListItem(line)) i = renderList(lines, i, out);
		else if (QUOTE_PREFIX.test(line)) i = renderQuote(lines, i, out);
		else if (line.trim() === '') i++;
		else i = renderParagraph(lines, i, out);
	}

	return out.join('\n');
}

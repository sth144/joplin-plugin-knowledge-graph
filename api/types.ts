/**
 * Minimal Joplin plugin API type declarations.
 * These match the subset of the API used by this plugin.
 */

export enum ToolbarButtonLocation {
	EditorToolbar = 'editorToolbar',
	NoteToolbar = 'noteToolbar',
}

export enum MenuItemLocation {
	Tools = 'tools',
}

export type ViewHandle = string;

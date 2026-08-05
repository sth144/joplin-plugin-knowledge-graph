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

export enum ToastType {
	Info = 'info',
	Success = 'success',
	Error = 'error',
}

export enum SettingItemType {
	Int = 1,
	String = 2,
	Bool = 3,
	Array = 4,
	Object = 5,
	Button = 6,
}

export type ViewHandle = string;

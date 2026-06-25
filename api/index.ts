/**
 * Joplin plugin API stub.
 *
 * At runtime, the `joplin` global is injected by the plugin sandbox.
 * This module re-exports it so `import joplin from 'api'` works
 * at both compile time (type checking) and runtime (global reference).
 */

import { ViewHandle } from './types';

interface JoplinData {
	get(path: string[], query?: any): Promise<any>;
	post(path: string[], query?: any, body?: any): Promise<any>;
	put(path: string[], query?: any, body?: any): Promise<any>;
	delete(path: string[], query?: any): Promise<any>;
}

interface DialogButton {
	id: string;
	title: string;
}

interface JoplinViewsDialogs {
	create(id: string): Promise<ViewHandle>;
	setHtml(handle: ViewHandle, html: string): Promise<void>;
	addScript(handle: ViewHandle, scriptPath: string): Promise<void>;
	setButtons(handle: ViewHandle, buttons: DialogButton[]): Promise<void>;
	setFitToContent(handle: ViewHandle, fit: boolean): Promise<void>;
	open(handle: ViewHandle): Promise<any>;
}

interface JoplinViewsPanels {
	create(id: string): Promise<ViewHandle>;
	setHtml(handle: ViewHandle, html: string): Promise<void>;
	addScript(handle: ViewHandle, scriptPath: string): Promise<void>;
	show(handle: ViewHandle, show?: boolean): Promise<void>;
	onMessage(handle: ViewHandle, callback: (message: any) => any): Promise<void>;
}

interface JoplinViewsToolbarButtons {
	create(id: string, commandName: string, location: string): Promise<void>;
}

interface JoplinViewsMenuItems {
	create(id: string, commandName: string, location?: string): Promise<void>;
}

interface JoplinViews {
	dialogs: JoplinViewsDialogs;
	panels: JoplinViewsPanels;
	toolbarButtons: JoplinViewsToolbarButtons;
	menuItems: JoplinViewsMenuItems;
}

interface CommandDeclaration {
	name: string;
	label: string;
	iconName?: string;
	execute: (...args: any[]) => Promise<any>;
}

interface JoplinCommands {
	register(command: CommandDeclaration): Promise<void>;
	execute(commandName: string, ...args: any[]): Promise<any>;
}

interface JoplinWorkspace {
	selectedNote(): Promise<any>;
	onNoteSelectionChange(callback: (...args: any[]) => void): Promise<any>;
}

interface JoplinPlugins {
	register(plugin: { onStart: () => Promise<void> }): void;
}

interface Joplin {
	data: JoplinData;
	views: JoplinViews;
	commands: JoplinCommands;
	workspace: JoplinWorkspace;
	plugins: JoplinPlugins;
}

// Reference the global `joplin` object injected by the plugin sandbox
const joplin: Joplin = (global as any).joplin;

export default joplin;

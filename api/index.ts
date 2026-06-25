/**
 * Stub for the Joplin plugin API module.
 * At runtime, 'api' is provided by Joplin's plugin host.
 * This file provides type declarations for TypeScript compilation.
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
	onMessage(handle: ViewHandle, callback: (message: any) => any): Promise<void>;
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

declare const joplin: Joplin;
export default joplin;

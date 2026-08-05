/**
 * Joplin plugin API stub.
 *
 * At runtime, the `joplin` global is injected by the plugin sandbox.
 * This module re-exports it so `import joplin from 'api'` works
 * at both compile time (type checking) and runtime (global reference).
 */

import { SettingItemType, ToastType, ViewHandle } from './types';

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
	showMessageBox(message: string): Promise<number>;
	showToast(toast: {
		message: string;
		type?: ToastType;
		duration?: number;
		timestamp?: number;
	}): Promise<void>;
}

interface JoplinViewsPanels {
	create(id: string): Promise<ViewHandle>;
	setHtml(handle: ViewHandle, html: string): Promise<void>;
	addScript(handle: ViewHandle, scriptPath: string): Promise<void>;
	show(handle: ViewHandle, show?: boolean): Promise<void>;
	hide(handle: ViewHandle): Promise<void>;
	visible(handle: ViewHandle): Promise<boolean>;
	onMessage(handle: ViewHandle, callback: (message: any) => any): Promise<void>;
	postMessage(handle: ViewHandle, message: any): void;
	addCss(handle: ViewHandle, css: string): Promise<void>;
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
	/** Fires when any note's content changes, including during sync. */
	onNoteChange(callback: (event: {
		id: string;
		event: number;
	}) => void): Promise<any>;
	onSyncComplete(callback: (...args: any[]) => void): Promise<any>;
}

interface SettingItem {
	value: any;
	type: SettingItemType;
	public: boolean;
	label: string;
	description?: string;
	section?: string;
	minimum?: number;
	maximum?: number;
	step?: number;
	isEnum?: boolean;
	options?: Record<string, string>;
}

interface JoplinSettings {
	registerSection(name: string, section: {
		label: string;
		iconName?: string;
		description?: string;
	}): Promise<void>;
	registerSettings(settings: Record<string, SettingItem>): Promise<void>;
	value(key: string): Promise<any>;
	setValue(key: string, value: any): Promise<void>;
	onChange(callback: (event: { keys: string[] }) => void): Promise<void>;
}

interface JoplinPlugins {
	register(plugin: { onStart: () => Promise<void> }): void;
	/** Writable directory for this plugin's data. Created if absent. */
	dataDir(): Promise<string>;
	/** Directory the plugin was unpacked into; holds bundled assets. */
	installationDir(): Promise<string>;
}

interface Joplin {
	data: JoplinData;
	views: JoplinViews;
	commands: JoplinCommands;
	workspace: JoplinWorkspace;
	plugins: JoplinPlugins;
	settings: JoplinSettings;
	/**
	 * Access to a whitelist of modules bundled with Joplin itself (`fs-extra`,
	 * `sqlite3`, ...). A bare `require` does not work in the plugin sandbox.
	 */
	require(moduleName: string): any;
}

// Reference the global `joplin` object injected by the plugin sandbox
const joplin: Joplin = (global as any).joplin;

export default joplin;

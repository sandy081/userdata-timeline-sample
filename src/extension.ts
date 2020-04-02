import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

export function activate(context: vscode.ExtensionContext) {

	const userDataBackupService = new UserDataChangesBackupService(context);
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => userDataBackupService.backup(UserDataResource.Settings)));

	const userDataFileChangesTimelineProvider = new UserDataBackupTimelineProvider('UserDataFileChangesTimelineProvider', 'Local History', new vscode.ThemeIcon('history'), userDataBackupService);
	context.subscriptions.push(userDataFileChangesTimelineProvider);
	context.subscriptions.push(vscode.workspace.registerTimelineProvider('vscode-userdata', userDataFileChangesTimelineProvider));

	const userDataSyncBackupResolver = new UserDataSyncBackupResolver(context);
	const userDataSyncBackupTimelineProvider = new UserDataBackupTimelineProvider('UserDataSyncBackupTimelineProvider', 'Sync History', new vscode.ThemeIcon('sync'), userDataSyncBackupResolver);
	context.subscriptions.push(userDataSyncBackupTimelineProvider);
	context.subscriptions.push(vscode.workspace.registerTimelineProvider('vscode-userdata', userDataSyncBackupTimelineProvider));

	context.subscriptions.push(vscode.commands.registerCommand('userdata.timeline.openDiff', (left: vscode.Uri, right: vscode.Uri) => {
		const userDataBackupTimelineProvider: UserDataBackupTimelineProvider = left.scheme === userDataBackupService.scheme ? userDataFileChangesTimelineProvider : userDataSyncBackupTimelineProvider;
		return userDataBackupTimelineProvider.openDiff(left, right);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('userdata.timeline.replace', (userDataTimelineEntry: UserDataTimelineItem) => {
		const userDataBackupTimelineProvider: UserDataBackupTimelineProvider = userDataTimelineEntry.backup.scheme === userDataBackupService.scheme ? userDataFileChangesTimelineProvider : userDataSyncBackupTimelineProvider;
		return userDataBackupTimelineProvider.replace(userDataTimelineEntry);
	}));
}

interface UserDataTimelineItem extends vscode.TimelineItem {
	source: vscode.Uri;
	backup: vscode.Uri;
}

class UserDataBackupTimelineProvider implements vscode.TimelineProvider {

	protected readonly disposables: vscode.Disposable[] = [];

	protected readonly _onDidChange: vscode.EventEmitter<vscode.TimelineChangeEvent> = new vscode.EventEmitter<vscode.TimelineChangeEvent>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly icon: vscode.ThemeIcon,
		private readonly userDataBackupResolver: UserDataBackupResolver
	) {
		this.disposables.push(this._onDidChange);
	}

	async provideTimeline(uri: vscode.Uri, options: vscode.TimelineOptions, token: vscode.CancellationToken): Promise<vscode.Timeline | null> {
		const basename = path.basename(uri.path);
		const allEntries = await this.userDataBackupResolver.getAllEntries(basename.substring(0, basename.length - 5) as UserDataResource);
		const filteredEntries = this.filterEntries(allEntries, options);
		const items = filteredEntries.map(entry => this.toTimelineItem(entry, uri));
		const cursor = options.cursor ? parseInt(options.cursor) + 10 : 10;
		return { items, paging: { cursor: allEntries.length > cursor ? `${cursor}` : undefined } };
	}

	private filterEntries(entries: IUserDataBackupEntry[], options: vscode.TimelineOptions): IUserDataBackupEntry[] {
		if (options.cursor) {
			const start = parseInt(options.cursor);
			return entries.slice(start, start + 10);
		}
		return entries.slice(0, 10);
	}

	private toTimelineItem(entry: IUserDataBackupEntry, source: vscode.Uri): UserDataTimelineItem {
		return {
			label: entry.name.substring(0, entry.name.length - 5),
			timestamp: entry.created,
			source,
			backup: entry.uri,
			iconPath: this.icon,
			command: {
				title: 'Open Comparison',
				command: 'userdata.timeline.openDiff',
				arguments: [entry.uri, source]
			},
			contextValue: `userdata/${entry.resource}`
		}
	}

	async replace(item: UserDataTimelineItem): Promise<void> {
		const name = path.basename(item.backup.path);
		const resource = path.basename(path.dirname(item.backup.path));
		const content = await this.userDataBackupResolver.resolveContent(resource as UserDataResource, name);
		await promisify(fs.writeFile)(item.source.with({ scheme: 'file' }).path, content);
	}

	openDiff(left: vscode.Uri, right: vscode.Uri): void {
		vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(left.path)} ↔ Now`);
	}

	dispose() {
		vscode.Disposable.from(...this.disposables).dispose();
	}

}

export const enum UserDataResource {
	Settings = 'settings',
	Keybindings = 'keybindings',
}

export interface IUserDataBackupEntry {
	readonly resource: UserDataResource;
	readonly uri: vscode.Uri;
	readonly name: string;
	readonly created: number;
}

abstract class UserDataBackupResolver {

	readonly userDataPath: string;

	protected readonly _onDidChangeResource: vscode.EventEmitter<UserDataResource> = new vscode.EventEmitter<UserDataResource>();
	readonly onDidChangeResource = this._onDidChangeResource.event;

	constructor(readonly scheme: string, protected readonly userDataBackupFolder: string, context: vscode.ExtensionContext) {
		this.userDataPath = path.dirname(path.dirname(context.globalStoragePath));
		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, this));
	}

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		const name = path.basename(uri.path);
		const resource = path.basename(path.dirname(uri.path));
		return this.resolveContent(resource as UserDataResource, name);
	}

	async resolveContent(resource: UserDataResource, name: string): Promise<string> {
		try {
			const userDataBackupFilePath = path.join(this.userDataBackupFolder, resource, name);
			const content = await promisify(fs.readFile)(userDataBackupFilePath);
			return content.toString();
		} catch (e) {
			return '';
		}
	}

	async getAllEntries(resource: UserDataResource): Promise<IUserDataBackupEntry[]> {
		try {
			const userDataBackupFolderPath = path.join(this.userDataBackupFolder, resource);
			const children = await promisify(fs.readdir)(userDataBackupFolderPath);
			const all = children.filter(name => /^\d{8}T\d{6}(\.json)?$/.test(name)).sort().reverse();
			return all.map(name => ({ name, created: this.getCreationTime(name), resource, uri: vscode.Uri.file(path.join('', resource, name)).with({ scheme: this.scheme }) }));
		} catch (e) {
			return [];
		}
	}

	private getCreationTime(name: string): number {
		return new Date(
			parseInt(name.substring(0, 4)),
			parseInt(name.substring(4, 6)) - 1,
			parseInt(name.substring(6, 8)),
			parseInt(name.substring(9, 11)),
			parseInt(name.substring(11, 13)),
			parseInt(name.substring(13, 15))
		).getTime();
	}
}

class UserDataSyncBackupResolver extends UserDataBackupResolver {

	constructor(context: vscode.ExtensionContext) {
		super('userdata-sync-timeline', path.join(path.dirname(path.dirname(context.globalStoragePath)), 'sync'), context);
	}

	async resolveContent(resource: UserDataResource, name: string): Promise<string> {
		let resolvedContent = await super.resolveContent(resource, name);
		const { content } = JSON.parse(resolvedContent);
		const { settings } = JSON.parse(content);
		return settings;
	}
}

class UserDataChangesBackupService extends UserDataBackupResolver {

	constructor(context: vscode.ExtensionContext) {
		super('userdata-timeline', path.join(context.globalStoragePath, 'userdata-backup'), context);
	}

	async backup(resource: UserDataResource): Promise<void> {
		const userDataFilePath = path.join(this.userDataPath, `${resource}.json`);
		const userDataBackupFolderPath = path.join(this.userDataBackupFolder, resource);
		if (!(await promisify(fs.exists)(userDataBackupFolderPath))) {
			await promisify(fs.mkdir)(userDataBackupFolderPath, { recursive: true });
		}
		const userDataBackupFilePath = path.join(userDataBackupFolderPath, `${toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '')}.json`);
		const content = await promisify(fs.readFile)(userDataFilePath);
		await promisify(fs.writeFile)(userDataBackupFilePath, content);
		this._onDidChangeResource.fire(resource);
	}

}

// this method is called when your extension is deactivated
export function deactivate() { }

function toLocalISOString(date: Date): string {
	return date.getFullYear() +
		'-' + pad(date.getMonth() + 1, 2) +
		'-' + pad(date.getDate(), 2) +
		'T' + pad(date.getHours(), 2) +
		':' + pad(date.getMinutes(), 2) +
		':' + pad(date.getSeconds(), 2) +
		'.' + (date.getMilliseconds() / 1000).toFixed(3).slice(2, 5) +
		'Z';
}

function pad(n: number, l: number, char: string = '0'): string {
	const str = '' + n;
	const r = [str];

	for (let i = str.length; i < l; i++) {
		r.push(char);
	}

	return r.reverse().join('');
}
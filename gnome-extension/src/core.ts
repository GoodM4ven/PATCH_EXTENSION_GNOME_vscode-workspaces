import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

interface Editor {
    name: string;
    binary: string;
    workspacePath: string;
    isDefault?: boolean;
}

interface WorkspaceEntry {
    uri: string;
    label: string;
    displayPath: string;
    storeDir: Gio.File;
    modifiedUsec: number;
    remote: boolean;
    nofail: boolean;
}

interface WorkspaceJson {
    folder?: string;
    workspace?: string;
    nofail?: boolean;
}

const FILE_URI_PREFIX = 'file://';
const KNOWN_ICON_NAMES = ['code', 'vscode', 'vscodium', 'codium', 'code-insiders', 'cursor'];
const MAX_VISIBLE_WORKSPACES = 75;

export class VSCodeWorkspacesCore {
    private readonly _metadata: { name: string; uuid: string };
    private readonly _openPreferences: () => void;
    private _settings?: Gio.Settings;

    private _indicator?: PanelMenu.Button;
    private _refreshTimeoutId: number | null = null;
    private _settingsChangedId: number | null = null;

    private _newWindow = false;
    private _editorLocation = 'auto';
    private _refreshInterval = 30;
    private _preferWorkspaceFile = false;
    private _debug = false;
    private _cleanupOrphanedWorkspaces = false;
    private _nofailList: string[] = [];
    private _customCmdArgs = '';
    private _favorites = new Set<string>();
    private _customIcon = '';

    private readonly _userConfigDir = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    private readonly _knownEditors: Editor[] = [
        {
            name: 'Visual Studio Code',
            binary: 'code',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/Code/User/workspaceStorage']),
            isDefault: true,
        },
        {
            name: 'VSCodium',
            binary: 'codium',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/VSCodium/User/workspaceStorage']),
        },
        {
            name: 'Code - Insiders',
            binary: 'code-insiders',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/Code - Insiders/User/workspaceStorage']),
        },
        {
            name: 'Cursor',
            binary: 'cursor',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/Cursor/User/workspaceStorage']),
        },
    ];

    private _availableEditors: Editor[] = [];
    private _activeEditor: Editor | null = null;
    private _workspaces: WorkspaceEntry[] = [];

    private _tooltipActor: St.Label | null = null;

    constructor(metadata: { name: string; uuid: string }, openPreferences: () => void, settings?: Gio.Settings) {
        this._metadata = metadata;
        this._openPreferences = openPreferences;
        this._settings = settings;
    }

    enable(): void {
        this._indicator = new PanelMenu.Button(0.0, this._metadata.name, false);
        this._indicator.add_child(this._createIcon());
        Main.panel.addToStatusArea(this._metadata.uuid, this._indicator);

        this._setSettings();
        this._attachMenuSignals();

        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed', () => {
                const oldIcon = this._customIcon;
                this._setSettings();

                if (oldIcon !== this._customIcon) {
                    this._replaceIndicatorIcon();
                }

                this._refresh(true);
                this._startRefreshLoop();
            });
        }

        this._refresh(true);
        this._startRefreshLoop();
    }

    disable(): void {
        this._stopRefreshLoop();
        this._destroyTooltip();

        if (this._settings && this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._indicator?.destroy();
        this._indicator = undefined;
        this._activeEditor = null;
        this._availableEditors = [];
        this._workspaces = [];
    }

    private _attachMenuSignals(): void {
        if (!this._indicator) return;

        const menu = this._indicator.menu as PopupMenu.PopupMenu;
        menu.connect('open-state-changed', (_menu: PopupMenu.PopupMenu, open: boolean) => {
            if (!open) {
                this._destroyTooltip();
            }
            return undefined;
        });
    }

    private _setSettings(): void {
        if (!this._settings) return;

        this._newWindow = this._settings.get_boolean('new-window');
        this._editorLocation = this._settings.get_string('editor-location') || 'auto';
        this._refreshInterval = Math.max(5, this._settings.get_int('refresh-interval'));
        this._preferWorkspaceFile = this._settings.get_boolean('prefer-workspace-file');
        this._debug = this._settings.get_boolean('debug');
        this._cleanupOrphanedWorkspaces = this._settings.get_boolean('cleanup-orphaned-workspaces');
        this._nofailList = this._settings.get_strv('nofail-workspaces');
        this._customCmdArgs = this._settings.get_string('custom-cmd-args');
        this._favorites = new Set(this._settings.get_strv('favorite-workspaces'));
        this._customIcon = this._settings.get_string('custom-icon');
    }

    private _persistDynamicSettings(): void {
        if (!this._settings) return;

        this._settings.set_strv('favorite-workspaces', Array.from(this._favorites));
    }

    private _startRefreshLoop(): void {
        this._stopRefreshLoop();

        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                this._refresh(false);
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    private _stopRefreshLoop(): void {
        if (this._refreshTimeoutId !== null) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
    }

    private _refresh(forceRebuildEditors: boolean): void {
        if (forceRebuildEditors || this._availableEditors.length === 0) {
            this._availableEditors = this._detectEditors();
            this._activeEditor = this._resolveActiveEditor();
        }

        this._workspaces = this._scanWorkspaces();
        this._buildMenu();
    }

    private _detectEditors(): Editor[] {
        const found: Editor[] = [];

        for (const editor of this._knownEditors) {
            const binaryFound = GLib.find_program_in_path(editor.binary) !== null;
            const storageExists = Gio.File.new_for_path(editor.workspacePath).query_exists(null);

            if (binaryFound || storageExists) {
                found.push(editor);
            }
        }

        return found;
    }

    private _resolveActiveEditor(): Editor | null {
        if (this._editorLocation === 'auto') {
            return this._availableEditors.find(editor => editor.isDefault)
                ?? this._availableEditors[0]
                ?? this._knownEditors[0];
        }

        if (this._editorLocation.includes('/')) {
            return this._createCustomEditorFromPath(this._editorLocation);
        }

        const byBinary = this._availableEditors.find(editor => editor.binary === this._editorLocation)
            ?? this._knownEditors.find(editor => editor.binary === this._editorLocation);

        if (byBinary) return byBinary;

        return this._createCustomEditorFromBinary(this._editorLocation);
    }

    private _createCustomEditorFromPath(path: string): Editor {
        const base = GLib.path_get_basename(path);
        return {
            name: `Custom (${base})`,
            binary: path,
            workspacePath: this._guessWorkspaceStorage(base),
        };
    }

    private _createCustomEditorFromBinary(binary: string): Editor {
        return {
            name: `Custom (${binary})`,
            binary,
            workspacePath: this._guessWorkspaceStorage(binary),
        };
    }

    private _guessWorkspaceStorage(hint: string): string {
        const lower = hint.toLowerCase();

        if (lower.includes('codium')) {
            return GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']);
        }

        if (lower.includes('insiders')) {
            return GLib.build_filenamev([this._userConfigDir, 'Code - Insiders/User/workspaceStorage']);
        }

        if (lower.includes('cursor')) {
            return GLib.build_filenamev([this._userConfigDir, 'Cursor/User/workspaceStorage']);
        }

        return GLib.build_filenamev([this._userConfigDir, 'Code/User/workspaceStorage']);
    }

    private _scanWorkspaces(): WorkspaceEntry[] {
        const editor = this._activeEditor;
        if (!editor) return [];

        const storageDir = Gio.File.new_for_path(editor.workspacePath);
        if (!storageDir.query_exists(null)) {
            this._log(`workspace storage not found: ${editor.workspacePath}`);
            return [];
        }

        let enumerator: Gio.FileEnumerator | null = null;
        const entries: WorkspaceEntry[] = [];

        try {
            enumerator = storageDir.enumerate_children(
                'standard::name,time::modified-usec,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
                    continue;
                }

                const storeDir = enumerator.get_child(info);
                const workspace = this._parseWorkspaceFromStorage(storeDir, info);
                if (workspace) entries.push(workspace);
            }
        } catch (error) {
            console.error(error as object, 'Failed to scan workspace storage');
        } finally {
            enumerator?.close(null);
        }

        entries.sort((a, b) => b.modifiedUsec - a.modifiedUsec);
        return entries.slice(0, MAX_VISIBLE_WORKSPACES);
    }

    private _parseWorkspaceFromStorage(storeDir: Gio.File, info: Gio.FileInfo): WorkspaceEntry | null {
        const workspaceJsonPath = GLib.build_filenamev([storeDir.get_path()!, 'workspace.json']);
        const workspaceJsonFile = Gio.File.new_for_path(workspaceJsonPath);

        if (!workspaceJsonFile.query_exists(null)) {
            return null;
        }

        try {
            const [ok, bytes] = workspaceJsonFile.load_contents(null);
            if (!ok) return null;

            const raw = new TextDecoder().decode(bytes);
            const parsed = JSON.parse(raw) as WorkspaceJson;
            const uri = parsed.workspace ?? parsed.folder;
            if (!uri) return null;

            const nofail = parsed.nofail === true;
            const remote = uri.startsWith('vscode-remote://') || uri.startsWith('docker://');

            if (!remote && !this._workspaceUriExists(uri)) {
                if (this._cleanupOrphanedWorkspaces && !nofail && !this._isMarkedNoFail(uri)) {
                    this._trashStorageDirectory(storeDir, uri);
                }
                return null;
            }

            const uriToOpen = this._preferWorkspaceFile ? this._preferCodeWorkspaceFile(uri) : uri;
            const { label, displayPath } = this._workspaceDisplay(uriToOpen);

            return {
                uri: uriToOpen,
                label,
                displayPath,
                storeDir,
                modifiedUsec: info.get_attribute_uint64('time::modified-usec'),
                remote,
                nofail,
            };
        } catch (error) {
            console.error(error as object, 'Failed to parse workspace entry');
            return null;
        }
    }

    private _workspaceUriExists(uri: string): boolean {
        if (!uri.startsWith(FILE_URI_PREFIX)) {
            return true;
        }

        const path = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        return Gio.File.new_for_path(path).query_exists(null);
    }

    private _isMarkedNoFail(uri: string): boolean {
        const name = GLib.path_get_basename(uri).replace('.code-workspace', '');
        return this._nofailList.includes(name);
    }

    private _trashStorageDirectory(storeDir: Gio.File, uri: string): void {
        try {
            const trashed = storeDir.trash(null);
            this._log(`orphaned workspace store ${trashed ? 'trashed' : 'failed'}: ${uri}`);
        } catch (error) {
            console.error(error as object, `Failed to trash orphaned workspace store: ${uri}`);
        }
    }

    private _preferCodeWorkspaceFile(uri: string): string {
        if (!uri.startsWith(FILE_URI_PREFIX)) return uri;

        const basePath = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        const base = Gio.File.new_for_path(basePath);

        if (base.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
            return uri;
        }

        let enumerator: Gio.FileEnumerator | null = null;
        try {
            enumerator = base.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);

            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR) {
                    continue;
                }

                const name = info.get_name();
                if (!name.endsWith('.code-workspace')) {
                    continue;
                }

                const filePath = GLib.build_filenamev([basePath, name]);
                return `${FILE_URI_PREFIX}${filePath}`;
            }
        } catch (error) {
            console.error(error as object, 'Failed to prefer .code-workspace file');
        } finally {
            enumerator?.close(null);
        }

        return uri;
    }

    private _workspaceDisplay(uri: string): { label: string; displayPath: string } {
        if (uri.startsWith(FILE_URI_PREFIX)) {
            const decoded = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
            const home = GLib.get_home_dir();
            const displayPath = decoded.replace(home, '~');

            let label = GLib.path_get_basename(decoded);
            if (label.endsWith('.code-workspace')) {
                label = label.replace(/\.code-workspace$/, '');
            }

            return { label, displayPath };
        }

        if (uri.startsWith('vscode-remote://')) {
            const withoutPrefix = uri.replace('vscode-remote://', '');
            const firstSlash = withoutPrefix.indexOf('/');
            const remoteName = firstSlash >= 0 ? withoutPrefix.substring(0, firstSlash) : withoutPrefix;
            const remotePath = firstSlash >= 0 ? withoutPrefix.substring(firstSlash + 1) : '';
            const label = remotePath ? GLib.path_get_basename(remotePath) : remoteName;
            const displayPath = `[${remoteName}] ${remotePath}`.trim();
            return { label, displayPath };
        }

        const label = GLib.path_get_basename(uri);
        return { label, displayPath: uri };
    }

    private _buildMenu(): void {
        if (!this._indicator) return;

        const menu = this._indicator.menu as PopupMenu.PopupMenu;
        menu.removeAll();

        this._appendWorkspaceSections(menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._appendActions(menu);

        if (this._availableEditors.length > 1) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._appendEditorSelector(menu);
        }
    }

    private _appendWorkspaceSections(menu: PopupMenu.PopupMenu): void {
        if (this._workspaces.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem(_('No workspaces found'));
            emptyItem.reactive = false;
            menu.addMenuItem(emptyItem);
            return;
        }

        const favorites = this._workspaces.filter(entry => this._favorites.has(entry.uri));
        const recents = this._workspaces.filter(entry => !this._favorites.has(entry.uri));

        if (favorites.length > 0) {
            const favoriteSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Favorites'));
            for (const entry of favorites) {
                favoriteSubmenu.menu.addMenuItem(this._createWorkspaceMenuItem(entry));
            }
            menu.addMenuItem(favoriteSubmenu);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const recentSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Recent Workspaces'));
        for (const entry of recents) {
            recentSubmenu.menu.addMenuItem(this._createWorkspaceMenuItem(entry));
        }
        menu.addMenuItem(recentSubmenu);
    }

    private _createWorkspaceMenuItem(entry: WorkspaceEntry): PopupMenu.PopupBaseMenuItem {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_style_class_name('workspace-entry');

        const row = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER });

        const label = new St.Label({
            text: entry.label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'workspace-entry-label',
        });

        const favoriteButton = new St.Button({
            style_class: 'workspace-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: new St.Icon({
                icon_name: this._favorites.has(entry.uri) ? 'starred-symbolic' : 'non-starred-symbolic',
                style_class: 'workspace-entry-icon',
            }),
        });

        favoriteButton.connect('clicked', () => {
            this._toggleFavorite(entry.uri);
        });
        favoriteButton.connect('button-press-event', () => Clutter.EVENT_STOP);

        const removeButton = new St.Button({
            style_class: 'workspace-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'workspace-entry-icon workspace-remove-icon',
            }),
        });

        removeButton.connect('clicked', () => {
            this._removeWorkspaceEntry(entry);
        });
        removeButton.connect('button-press-event', () => Clutter.EVENT_STOP);

        row.add_child(label);
        row.add_child(favoriteButton);
        row.add_child(removeButton);

        item.add_child(row);

        item.connect('activate', () => {
            // Explicitly clear tooltip before launching to avoid stale overlay actors.
            this._destroyTooltip();
            this._openWorkspace(entry.uri);
        });

        item.connect('enter-event', () => {
            this._showTooltip(item, entry.displayPath);
            return Clutter.EVENT_PROPAGATE;
        });

        item.connect('leave-event', () => {
            this._destroyTooltip();
            return Clutter.EVENT_PROPAGATE;
        });

        item.connect('destroy', () => {
            this._destroyTooltip();
        });

        return item;
    }

    private _showTooltip(anchor: PopupMenu.PopupBaseMenuItem, text: string): void {
        this._destroyTooltip();

        const tooltip = new St.Label({
            text,
            style_class: 'workspace-tooltip',
        });

        this._tooltipActor = tooltip;
        Main.layoutManager.addChrome(tooltip);

        const [x, y] = anchor.get_transformed_position();
        const [width] = anchor.get_transformed_size();
        tooltip.set_position(x + Math.floor(width) + 10, y);
        tooltip.add_style_class_name('show');
    }

    private _destroyTooltip(): void {
        if (!this._tooltipActor) return;

        try {
            Main.layoutManager.removeChrome(this._tooltipActor);
        } catch {
            // Ignore if actor was already removed by shell.
        }

        this._tooltipActor.destroy();
        this._tooltipActor = null;
    }

    private _appendActions(menu: PopupMenu.PopupMenu): void {
        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh'));
        refreshItem.connect('activate', () => this._refresh(true));

        const clearItem = new PopupMenu.PopupMenuItem(_('Clear Workspaces'));
        clearItem.connect('activate', () => this._clearWorkspaceStorage());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Extension Preferences'));
        prefsItem.connect('activate', () => {
            this._destroyTooltip();
            this._openPreferences();
        });

        menu.addMenuItem(refreshItem);
        menu.addMenuItem(clearItem);
        menu.addMenuItem(prefsItem);
    }

    private _appendEditorSelector(menu: PopupMenu.PopupMenu): void {
        const editorSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Select Editor'));

        for (const editor of this._availableEditors) {
            const item = new PopupMenu.PopupMenuItem(editor.name);
            if (this._activeEditor?.binary === editor.binary) {
                item.setOrnament(PopupMenu.Ornament.DOT);
            }

            item.connect('activate', () => {
                this._editorLocation = editor.binary;
                this._settings?.set_string('editor-location', editor.binary);
                this._refresh(true);
            });

            editorSubmenu.menu.addMenuItem(item);
        }

        menu.addMenuItem(editorSubmenu);
    }

    private _toggleFavorite(uri: string): void {
        if (this._favorites.has(uri)) {
            this._favorites.delete(uri);
        } else {
            this._favorites.add(uri);
        }

        this._persistDynamicSettings();
        this._buildMenu();
    }

    private _removeWorkspaceEntry(entry: WorkspaceEntry): void {
        try {
            entry.storeDir.trash(null);
        } catch (error) {
            console.error(error as object, `Failed to trash workspace store for ${entry.uri}`);
        }

        this._workspaces = this._workspaces.filter(workspace => workspace.uri !== entry.uri);
        this._favorites.delete(entry.uri);
        this._persistDynamicSettings();
        this._buildMenu();
    }

    private _clearWorkspaceStorage(): void {
        const editor = this._activeEditor;
        if (!editor) return;

        const storage = Gio.File.new_for_path(editor.workspacePath);
        if (!storage.query_exists(null)) return;

        let enumerator: Gio.FileEnumerator | null = null;
        try {
            enumerator = storage.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);

            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
                const child = enumerator.get_child(info);
                child.trash(null);
            }
        } catch (error) {
            console.error(error as object, 'Failed to clear workspace storage');
        } finally {
            enumerator?.close(null);
        }

        this._workspaces = [];
        this._buildMenu();
    }

    private _openWorkspace(uri: string): void {
        const editor = this._activeEditor;
        if (!editor) return;

        this._destroyTooltip();
        this._indicator?.menu.close();

        const args = this._buildLaunchArgv(editor.binary, uri);
        if (!args) return;

        try {
            const [, pid] = GLib.spawn_async(
                null,
                args,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            this._log(`spawned ${editor.binary} with pid ${pid}`);
        } catch (error) {
            console.error(error as object, 'Failed to launch editor');
        }
    }

    private _buildLaunchArgv(binary: string, uri: string): string[] | null {
        const argv = [binary];

        if (this._newWindow) {
            argv.push('--new-window');
        }

        if (uri.startsWith('vscode-remote://') || uri.startsWith('docker://')) {
            argv.push('--folder-uri', uri);
        } else {
            argv.push(this._isDirectoryUri(uri) ? '--folder-uri' : '--file-uri', uri);
        }

        if (this._customCmdArgs.trim().length > 0) {
            try {
                const [ok, parsedArgv] = GLib.shell_parse_argv(this._customCmdArgs);
                if (ok) {
                    argv.push(...parsedArgv);
                }
            } catch (error) {
                console.error(error as object, 'Failed to parse custom command args');
            }
        }

        return argv;
    }

    private _isDirectoryUri(uri: string): boolean {
        if (!uri.startsWith(FILE_URI_PREFIX)) {
            return false;
        }

        const decoded = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        return GLib.file_test(decoded, GLib.FileTest.IS_DIR);
    }

    private _createIcon(): St.Icon {
        const customIcon = this._customIcon.trim();

        if (customIcon.length > 0) {
            const asFile = Gio.File.new_for_path(customIcon);
            if (asFile.query_exists(null)) {
                return new St.Icon({
                    gicon: Gio.icon_new_for_string(customIcon),
                    style_class: 'system-status-icon',
                });
            }

            if (St.IconTheme.new().has_icon(customIcon)) {
                return new St.Icon({
                    icon_name: customIcon,
                    style_class: 'system-status-icon',
                });
            }
        }

        for (const iconName of KNOWN_ICON_NAMES) {
            if (St.IconTheme.new().has_icon(iconName)) {
                return new St.Icon({
                    icon_name: iconName,
                    style_class: 'system-status-icon',
                });
            }
        }

        return new St.Icon({
            icon_name: 'applications-development-symbolic',
            style_class: 'system-status-icon',
        });
    }

    private _replaceIndicatorIcon(): void {
        if (!this._indicator) return;

        this._indicator.remove_all_children();
        this._indicator.add_child(this._createIcon());
    }

    private _log(message: string): void {
        if (!this._debug) return;
        console.log(_(`[${this._metadata.name}] ${message}`));
    }
}

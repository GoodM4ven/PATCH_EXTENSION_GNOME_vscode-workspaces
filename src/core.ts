import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
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
    identityKey: string;
    entryKind: 'directory' | 'workspace' | 'other';
    label: string;
    displayPath: string;
    storeDir: Gio.File | null;
    source: 'storage' | 'discovered';
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
const DEFAULT_VSCODIUM_ICON_PATH = '/usr/share/pixmaps/vscodium.png';
const KNOWN_ICON_NAMES = ['code', 'vscodium', 'codium', 'code-insiders'];
const MAX_VISIBLE_WORKSPACES = 75;
const DISCOVERY_MAX_DEPTH = 6;
const DISCOVERY_MAX_RESULTS = 500;

export class VSCodiumWorkspacesCore {
    private readonly _metadata: { name: string; uuid: string };
    private readonly _openPreferences: () => void;
    private _settings?: Gio.Settings;

    private _indicator?: PanelMenu.Button;
    private _refreshTimeoutId: number | null = null;
    private _settingsChangedId: number | null = null;
    private _refreshRequestId = 0;

    private _editorLocation = 'auto';
    private _refreshInterval = 30;
    private _workspaceFilesOnly = false;
    private _debug = false;
    private _cleanupOrphanedWorkspaces = false;
    private _nofailList: string[] = [];
    private _customCmdArgs = '';
    private _favorites = new Set<string>();
    private _customIcon = '';
    private _customLabels = new Map<string, string>();

    private readonly _userConfigDir = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    private readonly _knownEditors: Editor[] = [
        {
            name: 'VSCodium',
            binary: 'codium',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/VSCodium/User/workspaceStorage']),
            isDefault: true,
        },
        {
            name: 'Code OSS',
            binary: 'code',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/Code/User/workspaceStorage']),
        },
        {
            name: 'Code - Insiders',
            binary: 'code-insiders',
            workspacePath: GLib.build_filenamev([GLib.get_home_dir(), '.config/Code - Insiders/User/workspaceStorage']),
        },
    ];

    private _availableEditors: Editor[] = [];
    private _activeEditor: Editor | null = null;
    private _workspaces: WorkspaceEntry[] = [];
    private _discoveredWorkspaceFiles: WorkspaceEntry[] = [];

    private _tooltipActor: St.Label | null = null;

    constructor(metadata: { name: string; uuid: string }, openPreferences: () => void, settings?: Gio.Settings) {
        this._metadata = metadata;
        this._openPreferences = openPreferences;
        this._settings = settings;
    }

    enable(): void {
        this._setSettings();

        this._indicator = new PanelMenu.Button(0.0, this._metadata.name, false);
        this._indicator.add_child(this._createIcon());
        Main.panel.addToStatusArea(this._metadata.uuid, this._indicator);

        this._attachMenuSignals();

        if (this._settings) {
            this._settingsChangedId = this._settings.connect('changed', () => {
                const oldIcon = this._customIcon;
                this._setSettings();

                if (oldIcon !== this._customIcon) {
                    this._replaceIndicatorIcon();
                }

                void this._refresh(true);
                this._startRefreshLoop();
            });
        }

        void this._refresh(true);
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
        this._discoveredWorkspaceFiles = [];
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

        this._editorLocation = this._settings.get_string('editor-location') || 'auto';
        this._refreshInterval = Math.max(5, this._settings.get_int('refresh-interval'));
        this._workspaceFilesOnly = this._settings.get_boolean('prefer-workspace-file');
        this._debug = this._settings.get_boolean('debug');
        this._cleanupOrphanedWorkspaces = this._settings.get_boolean('cleanup-orphaned-workspaces');
        this._nofailList = this._settings.get_strv('nofail-workspaces');
        this._customCmdArgs = this._settings.get_string('custom-cmd-args');
        this._favorites = new Set(this._settings.get_strv('favorite-workspaces'));
        this._customIcon = this._settings.get_string('custom-icon');
        this._customLabels = this._parseCustomLabels(
            this._settings.get_string('custom-workspace-labels')
        );
    }

    private _persistDynamicSettings(): void {
        if (!this._settings) return;

        this._settings.set_strv('favorite-workspaces', Array.from(this._favorites));
        this._settings.set_string('custom-workspace-labels', this._stringifyCustomLabels());
    }

    private _startRefreshLoop(): void {
        this._stopRefreshLoop();

        this._refreshTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                void this._refresh(false);
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

    private async _refresh(forceRebuildEditors: boolean): Promise<void> {
        const refreshRequestId = ++this._refreshRequestId;

        if (forceRebuildEditors || this._availableEditors.length === 0) {
            this._availableEditors = this._detectEditors();
            this._activeEditor = this._resolveActiveEditor();
        }

        const scannedStorage = await this._scanWorkspaces();

        // Ignore stale refresh results if a newer refresh started while awaiting file IO.
        if (refreshRequestId !== this._refreshRequestId) {
            return;
        }

        const deduped = this._dedupeWorkspaceEntries([
            ...scannedStorage,
            ...this._discoveredWorkspaceFiles,
        ]);
        this._normalizeFavoriteUris(deduped);
        this._workspaces = deduped.slice(0, MAX_VISIBLE_WORKSPACES);
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

        return GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']);
    }

    private async _scanWorkspaces(): Promise<WorkspaceEntry[]> {
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
                const workspace = await this._parseWorkspaceFromStorage(storeDir, info);
                if (workspace) entries.push(workspace);
            }
        } catch (error) {
            this._logError('Failed to scan workspace storage', error);
        } finally {
            enumerator?.close(null);
        }

        entries.sort((a, b) => b.modifiedUsec - a.modifiedUsec);
        return this._dedupeWorkspaceEntries(entries);
    }

    private _dedupeWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
        const deduped = new Map<string, WorkspaceEntry>();
        const favoriteIdentityKeys = this._favoriteIdentityKeys(entries);

        for (const entry of entries) {
            const existing = deduped.get(entry.identityKey);
            if (!existing) {
                deduped.set(entry.identityKey, entry);
                continue;
            }

            deduped.set(
                entry.identityKey,
                this._pickPreferredEntry(existing, entry, favoriteIdentityKeys)
            );
        }

        return Array.from(deduped.values()).sort((a, b) => b.modifiedUsec - a.modifiedUsec);
    }

    private _pickPreferredEntry(
        first: WorkspaceEntry,
        second: WorkspaceEntry,
        favoriteIdentityKeys: Set<string>
    ): WorkspaceEntry {
        const firstUriFavorited = this._favorites.has(first.uri);
        const secondUriFavorited = this._favorites.has(second.uri);

        if (firstUriFavorited !== secondUriFavorited) {
            return firstUriFavorited ? first : second;
        }

        const identityIsFavorited = favoriteIdentityKeys.has(first.identityKey);
        if (identityIsFavorited && first.source !== second.source) {
            return first.source === 'storage' ? first : second;
        }

        if (first.modifiedUsec !== second.modifiedUsec) {
            return first.modifiedUsec > second.modifiedUsec ? first : second;
        }

        if (first.source !== second.source) {
            return first.source === 'storage' ? first : second;
        }

        return first;
    }

    private _favoriteIdentityKeys(entries: WorkspaceEntry[]): Set<string> {
        const favoriteIdentityKeys = new Set<string>();

        for (const entry of entries) {
            if (this._favorites.has(entry.uri)) {
                favoriteIdentityKeys.add(entry.identityKey);
            }
        }

        for (const favoriteUri of this._favorites) {
            favoriteIdentityKeys.add(this._identityKeyFromUri(favoriteUri));
        }

        return favoriteIdentityKeys;
    }

    private async _parseWorkspaceFromStorage(storeDir: Gio.File, info: Gio.FileInfo): Promise<WorkspaceEntry | null> {
        const workspaceJsonPath = GLib.build_filenamev([storeDir.get_path()!, 'workspace.json']);
        const workspaceJsonFile = Gio.File.new_for_path(workspaceJsonPath);

        if (!workspaceJsonFile.query_exists(null)) {
            return null;
        }

        try {
            const [bytes] = await workspaceJsonFile.load_contents_async(null);

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

            const uriToOpen = this._workspaceFilesOnly ? this._codeWorkspaceOnlyUri(uri) : uri;
            if (!uriToOpen) {
                return null;
            }
            const { label, displayPath } = this._workspaceDisplay(uriToOpen);

            return {
                uri: uriToOpen,
                identityKey: this._identityKeyFromUri(uriToOpen),
                entryKind: this._entryKindFromUri(uriToOpen),
                label,
                displayPath,
                storeDir,
                source: 'storage',
                modifiedUsec: info.get_attribute_uint64('time::modified-usec'),
                remote,
                nofail,
            };
        } catch (error) {
            this._logError('Failed to parse workspace entry', error);
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
            this._logError(`Failed to trash orphaned workspace store: ${uri}`, error);
        }
    }

    private _codeWorkspaceOnlyUri(uri: string): string | null {
        if (!uri.startsWith(FILE_URI_PREFIX)) {
            return uri.endsWith('.code-workspace') ? uri : null;
        }

        if (uri.endsWith('.code-workspace')) {
            return uri;
        }

        const basePath = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        const base = Gio.File.new_for_path(basePath);

        if (base.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
            return null;
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
            this._logError('Failed to resolve .code-workspace-only URI', error);
        } finally {
            enumerator?.close(null);
        }

        return null;
    }

    private _scanWorkspaceFilesFromDisk(): WorkspaceEntry[] {
        const excludedDirNames = new Set([
            '.git',
            'node_modules',
            '.cache',
            '.npm',
            '.cargo',
            '.rustup',
            'venv',
            '.venv',
        ]);
        const home = GLib.get_home_dir();
        const root = Gio.File.new_for_path(home);
        const queue: Array<{ dir: Gio.File; depth: number }> = [{ dir: root, depth: 0 }];
        const entries: WorkspaceEntry[] = [];

        while (queue.length > 0 && entries.length < DISCOVERY_MAX_RESULTS) {
            const current = queue.pop();
            if (!current) break;

            let enumerator: Gio.FileEnumerator | null = null;
            try {
                enumerator = current.dir.enumerate_children(
                    'standard::name,standard::type,time::modified-usec',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                let info: Gio.FileInfo | null;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    const fileType = info.get_file_type();
                    const child = enumerator.get_child(info);

                    if (fileType === Gio.FileType.DIRECTORY) {
                        if (current.depth >= DISCOVERY_MAX_DEPTH) {
                            continue;
                        }

                        const childPath = child.get_path() ?? '';
                        if (excludedDirNames.has(name)) {
                            continue;
                        }
                        if (childPath.includes('/.local/share/Trash')) {
                            continue;
                        }

                        queue.push({ dir: child, depth: current.depth + 1 });
                        continue;
                    }

                    if (fileType !== Gio.FileType.REGULAR || !name.endsWith('.code-workspace')) {
                        continue;
                    }

                    const uri = child.get_uri();
                    const { label, displayPath } = this._workspaceDisplay(uri);

                    entries.push({
                        uri,
                        identityKey: this._identityKeyFromUri(uri),
                        entryKind: this._entryKindFromUri(uri),
                        label,
                        displayPath,
                        storeDir: null,
                        source: 'discovered',
                        modifiedUsec: info.get_attribute_uint64('time::modified-usec'),
                        remote: false,
                        nofail: false,
                    });

                    if (entries.length >= DISCOVERY_MAX_RESULTS) {
                        break;
                    }
                }
            } catch (error) {
                this._logError('Failed while walking directory for .code-workspace files', error);
            } finally {
                enumerator?.close(null);
            }
        }

        const deduped = this._dedupeWorkspaceEntries(entries);
        this._log(`disk scan discovered ${deduped.length} .code-workspace files`);
        return deduped;
    }

    private _identityKeyFromUri(uri: string): string {
        if (!uri.startsWith(FILE_URI_PREFIX)) {
            return `uri:${uri}`;
        }

        const localPath = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        if (localPath.endsWith('.code-workspace')) {
            return `workspace:${this._normalizeLocalPath(localPath)}`;
        }

        if (GLib.file_test(localPath, GLib.FileTest.IS_DIR)) {
            return `dir:${this._normalizeLocalPath(localPath)}`;
        }

        return `file:${this._normalizeLocalPath(localPath)}`;
    }

    private _entryKindFromUri(uri: string): 'directory' | 'workspace' | 'other' {
        if (!uri.startsWith(FILE_URI_PREFIX)) {
            return 'other';
        }

        const localPath = decodeURIComponent(uri.replace(FILE_URI_PREFIX, ''));
        if (localPath.endsWith('.code-workspace')) {
            return 'workspace';
        }

        if (GLib.file_test(localPath, GLib.FileTest.IS_DIR)) {
            return 'directory';
        }

        return 'other';
    }

    private _normalizeLocalPath(path: string): string {
        let normalized = Gio.File.new_for_path(path).get_path() ?? path;
        if (normalized.length > 1) {
            normalized = normalized.replace(/\/+$/, '');
        }
        return normalized;
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

        const favorites = this._workspaces.filter(entry => this._isEntryFavorited(entry));
        const recents = this._workspaces.filter(entry => !this._isEntryFavorited(entry));

        if (favorites.length > 0) {
            const favoriteSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Favorites'));
            for (const entry of favorites) {
                favoriteSubmenu.menu.addMenuItem(this._createWorkspaceMenuItem(entry));
            }
            menu.addMenuItem(favoriteSubmenu);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const recentSubmenu = new PopupMenu.PopupSubMenuMenuItem(_('Recently Found'));
        for (const entry of recents) {
            recentSubmenu.menu.addMenuItem(this._createWorkspaceMenuItem(entry));
        }
        menu.addMenuItem(recentSubmenu);
    }

    private _createWorkspaceMenuItem(entry: WorkspaceEntry): PopupMenu.PopupBaseMenuItem {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_style_class_name('workspace-entry');

        const row = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const effectiveLabel = this._effectiveLabelForEntry(entry);

        const label = new St.Label({
            text: effectiveLabel,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'workspace-entry-label',
        });

        const favoriteButton = new St.Button({
            style_class: 'workspace-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
            child: new St.Icon({
                icon_name: this._isEntryFavorited(entry) ? 'starred-symbolic' : 'non-starred-symbolic',
                style_class: 'workspace-entry-icon',
            }),
        });

        favoriteButton.clear_actions();
        favoriteButton.connect('button-press-event', () => {
            this._toggleFavorite(entry);
            this._log(`favorite toggled: ${entry.uri}`);
            return Clutter.EVENT_STOP;
        });

        const renameButton = new St.Button({
            style_class: 'workspace-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
            child: new St.Icon({
                icon_name: 'document-edit-symbolic',
                style_class: 'workspace-entry-icon',
            }),
        });

        renameButton.clear_actions();
        renameButton.connect('button-press-event', () => {
            this._promptRenameWorkspace(entry);
            return Clutter.EVENT_STOP;
        });

        const removeButton = new St.Button({
            style_class: 'workspace-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'workspace-entry-icon workspace-remove-icon',
            }),
        });

        removeButton.clear_actions();
        removeButton.connect('button-press-event', () => {
            this._removeWorkspaceEntry(entry);
            this._log(`workspace removed: ${entry.uri}`);
            return Clutter.EVENT_STOP;
        });

        row.add_child(label);
        row.add_child(favoriteButton);
        row.add_child(renameButton);
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
        const [minWidth, naturalWidth] = tooltip.get_preferred_width(-1);
        const tooltipWidth = Math.max(minWidth, naturalWidth);
        const monitor = Main.layoutManager.currentMonitor;
        const leftEdge = monitor?.x ?? 0;
        const tooltipX = Math.max(leftEdge, x - Math.floor(tooltipWidth) - 10);
        tooltip.set_position(tooltipX, y);
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
        refreshItem.connect('activate', () => {
            void this._refresh(false);
        });

        const scanItem = new PopupMenu.PopupMenuItem(_('Scan'));
        scanItem.connect('activate', () => {
            this._confirmAction(
                _('Scan all files?'),
                _('You are about to scan your whole home directory for workspace files...'),
                () => {
                    this._destroyTooltip();
                    this._indicator?.menu.close();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._log('manual scan requested');
                        this._discoveredWorkspaceFiles = this._scanWorkspaceFilesFromDisk();
                        void this._refresh(true);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            );
        });

        const clearItem = new PopupMenu.PopupMenuItem(_('Clear'));
        clearItem.connect('activate', () => {
            this._confirmAction(
                _('Clear all saved records?'),
                _('You are about to clear all found and saved workspaces.'),
                () => this._clearWorkspaceStorage()
            );
        });

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connect('activate', () => {
            this._destroyTooltip();
            this._openPreferences();
        });

        menu.addMenuItem(refreshItem);
        menu.addMenuItem(scanItem);
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
                void this._refresh(true);
            });

            editorSubmenu.menu.addMenuItem(item);
        }

        menu.addMenuItem(editorSubmenu);
    }

    private _isEntryFavorited(entry: WorkspaceEntry): boolean {
        if (this._favorites.has(entry.uri)) {
            return true;
        }

        for (const favoriteUri of this._favorites) {
            if (this._identityKeyFromUri(favoriteUri) === entry.identityKey) {
                return true;
            }
        }

        return false;
    }

    private _toggleFavorite(entry: WorkspaceEntry): void {
        const identityKey = entry.identityKey;
        const relatedFavoriteUris = Array.from(this._favorites).filter(
            favoriteUri => this._identityKeyFromUri(favoriteUri) === identityKey
        );

        if (relatedFavoriteUris.length > 0) {
            for (const favoriteUri of relatedFavoriteUris) {
                this._favorites.delete(favoriteUri);
            }
        } else {
            this._favorites.add(entry.uri);
        }

        this._persistDynamicSettings();
        void this._refresh(false);
    }

    private _normalizeFavoriteUris(entries: WorkspaceEntry[]): void {
        const sortedWorkspaces = [...entries].sort((a, b) => b.modifiedUsec - a.modifiedUsec);
        const preservedByIdentity = new Map<string, WorkspaceEntry>();

        for (const entry of sortedWorkspaces) {
            if (this._isEntryFavorited(entry) && !preservedByIdentity.has(entry.identityKey)) {
                preservedByIdentity.set(entry.identityKey, entry);
            }
        }

        const normalizedFavorites = new Set<string>();
        for (const entry of preservedByIdentity.values()) {
            normalizedFavorites.add(entry.uri);
        }

        const changed = normalizedFavorites.size !== this._favorites.size
            || Array.from(normalizedFavorites).some(uri => !this._favorites.has(uri));

        if (changed) {
            this._favorites = normalizedFavorites;
            this._persistDynamicSettings();
        }
    }

    private _effectiveLabelForEntry(entry: WorkspaceEntry): string {
        const base = this._baseLabelForEntry(entry);
        const suffix = this._labelSuffixForEntry(entry);
        return suffix.length > 0 ? `${base} ${suffix}` : base;
    }

    private _baseLabelForEntry(entry: WorkspaceEntry): string {
        const custom = this._customLabels.get(entry.identityKey);
        if (custom && custom.trim().length > 0) {
            return custom;
        }
        return entry.label;
    }

    private _labelSuffixForEntry(entry: WorkspaceEntry): string {
        if (this._workspaceFilesOnly) {
            return '';
        }

        if (entry.entryKind === 'directory') {
            return '(D)';
        }

        if (entry.entryKind === 'workspace') {
            return '(W)';
        }

        return '';
    }

    private _setCustomLabel(entry: WorkspaceEntry, label: string): void {
        const trimmed = label.trim();
        if (trimmed.length === 0 || trimmed === entry.label) {
            this._customLabels.delete(entry.identityKey);
        } else {
            this._customLabels.set(entry.identityKey, trimmed);
        }

        this._persistDynamicSettings();
        this._buildMenu();
    }

    private _removeWorkspaceEntry(entry: WorkspaceEntry): void {
        if (entry.source === 'storage' && entry.storeDir) {
            try {
                entry.storeDir.trash(null);
            } catch (error) {
                this._logError(`Failed to trash workspace store for ${entry.uri}`, error);
            }
        }

        this._discoveredWorkspaceFiles = this._discoveredWorkspaceFiles.filter(
            workspace => workspace.identityKey !== entry.identityKey
        );

        this._workspaces = this._workspaces.filter(workspace => workspace.identityKey !== entry.identityKey);
        for (const favoriteUri of Array.from(this._favorites)) {
            if (this._identityKeyFromUri(favoriteUri) === entry.identityKey) {
                this._favorites.delete(favoriteUri);
            }
        }
        this._customLabels.delete(entry.identityKey);
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
            this._logError('Failed to clear workspace storage', error);
        } finally {
            enumerator?.close(null);
        }

        this._workspaces = [];
        this._discoveredWorkspaceFiles = [];
        this._favorites.clear();
        this._customLabels.clear();
        this._persistDynamicSettings();
        this._buildMenu();
    }

    private _confirmAction(title: string, description: string, onConfirm: () => void): void {
        this._destroyTooltip();

        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({ title, description }));

        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => {
                    this._closeDialog(dialog);
                },
                key: Clutter.KEY_Escape,
            },
            {
                label: _('Continue'),
                action: () => {
                    this._closeDialog(dialog);
                    onConfirm();
                },
            },
        ]);

        dialog.open();
    }

    private _promptRenameWorkspace(entry: WorkspaceEntry): void {
        this._destroyTooltip();
        const currentLabel = this._baseLabelForEntry(entry);

        const dialog = new ModalDialog.ModalDialog();
        const content = new Dialog.MessageDialogContent({
            title: _('Rename workspace'),
            description: _('Set a custom display name for this workspace.'),
        });
        dialog.contentLayout.add_child(content);

        const labelEntry = new St.Entry({
            text: currentLabel,
            can_focus: true,
            x_expand: true,
            style_class: 'prompt-dialog-entry',
        });
        content.add_child(labelEntry);

        const submit = () => {
            this._setCustomLabel(entry, labelEntry.get_text());
            this._closeDialog(dialog);
        };

        labelEntry.clutter_text.connect('activate', () => {
            submit();
        });

        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => this._closeDialog(dialog),
                key: Clutter.KEY_Escape,
            },
            {
                label: _('Save'),
                action: submit,
                default: true,
            },
        ]);

        dialog.open();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            labelEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _closeDialog(dialog: ModalDialog.ModalDialog): void {
        dialog.close();
        dialog.destroy();
    }

    private _parseCustomLabels(raw: string): Map<string, string> {
        if (!raw || raw.trim().length === 0) {
            return new Map<string, string>();
        }

        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const map = new Map<string, string>();
            for (const [identityKey, value] of Object.entries(parsed)) {
                if (typeof value !== 'string') {
                    continue;
                }

                const trimmed = value.trim();
                if (trimmed.length === 0) {
                    continue;
                }

                map.set(identityKey, trimmed);
            }
            return map;
        } catch {
            return new Map<string, string>();
        }
    }

    private _stringifyCustomLabels(): string {
        const sorted = Array.from(this._customLabels.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const plain: Record<string, string> = {};
        for (const [identityKey, label] of sorted) {
            plain[identityKey] = label;
        }
        return JSON.stringify(plain);
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
            this._logError('Failed to launch editor', error);
        }
    }

    private _buildLaunchArgv(binary: string, uri: string): string[] | null {
        const argv = [binary];

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
                this._logError('Failed to parse custom command args', error);
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
                this._log(`using custom icon file: ${customIcon}`);
                return new St.Icon({
                    gicon: Gio.icon_new_for_string(customIcon),
                    style_class: 'system-status-icon',
                });
            }

            if (St.IconTheme.new().has_icon(customIcon)) {
                this._log(`using custom icon name: ${customIcon}`);
                return new St.Icon({
                    icon_name: customIcon,
                    style_class: 'system-status-icon',
                });
            }
        }

        const defaultVSCodiumIcon = Gio.File.new_for_path(DEFAULT_VSCODIUM_ICON_PATH);
        if (defaultVSCodiumIcon.query_exists(null)) {
            this._log(`using default icon file: ${DEFAULT_VSCODIUM_ICON_PATH}`);
            return new St.Icon({
                gicon: Gio.icon_new_for_string(DEFAULT_VSCODIUM_ICON_PATH),
                style_class: 'system-status-icon',
            });
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

    private _logError(message: string, error: unknown): void {
        if (!this._debug) return;

        const prefixedMessage = `[${this._metadata.name}] ${message}`;

        if (error === null || error === undefined) {
            console.error(prefixedMessage);
            return;
        }

        console.error(error, prefixedMessage);
    }

    private _log(message: string): void {
        if (!this._debug) return;
        console.log(_(`[${this._metadata.name}] ${message}`));
    }
}

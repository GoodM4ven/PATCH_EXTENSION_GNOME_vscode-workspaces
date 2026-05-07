import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VSCodeWorkspacesPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const ui = new SettingsUi(settings);

        const page = new Adw.PreferencesPage();
        page.add(ui.generalGroup);
        page.add(ui.behaviorGroup);
        page.add(ui.cleanupGroup);

        window.add(page);

        window.connect('close-request', () => {
            ui.persistSpecialFields();
            return false;
        });
    }
}

class SettingsUi {
    private readonly _settings: Gio.Settings;

    generalGroup: Adw.PreferencesGroup;
    behaviorGroup: Adw.PreferencesGroup;
    cleanupGroup: Adw.PreferencesGroup;

    private readonly _editorLocation: Adw.EntryRow;
    private readonly _customCmdArgs: Adw.EntryRow;
    private readonly _customIcon: Adw.EntryRow;

    private readonly _newWindow: Adw.SwitchRow;
    private readonly _preferWorkspaceFile: Adw.SwitchRow;
    private readonly _cleanupOrphans: Adw.SwitchRow;
    private readonly _debug: Adw.SwitchRow;

    private readonly _refreshInterval: Adw.SpinRow;

    private readonly _nofailWorkspaces: Adw.EntryRow;
    private readonly _favoriteWorkspaces: Adw.EntryRow;

    constructor(settings: Gio.Settings) {
        this._settings = settings;

        this._editorLocation = new Adw.EntryRow({
            title: _('Editor Location'),
            showApplyButton: false,
        });
        this._customCmdArgs = new Adw.EntryRow({
            title: _('Custom Command Args'),
            showApplyButton: false,
        });
        this._customIcon = new Adw.EntryRow({
            title: _('Custom Icon'),
            showApplyButton: false,
        });

        this._newWindow = new Adw.SwitchRow({ title: _('Open in New Window') });
        this._preferWorkspaceFile = new Adw.SwitchRow({ title: _('Prefer .code-workspace File') });
        this._cleanupOrphans = new Adw.SwitchRow({ title: _('Cleanup Orphaned Workspaces') });
        this._debug = new Adw.SwitchRow({ title: _('Debug Logging') });

        this._refreshInterval = new Adw.SpinRow({
            title: _('Refresh Interval (seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 1,
            }),
        });

        this._nofailWorkspaces = new Adw.EntryRow({
            title: _('No-fail Workspaces'),
            showApplyButton: false,
        });
        this._favoriteWorkspaces = new Adw.EntryRow({
            title: _('Favorite Workspaces'),
            showApplyButton: false,
        });

        this.generalGroup = new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Editor and icon settings'),
        });

        this.behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Launch and refresh behavior'),
        });

        this.cleanupGroup = new Adw.PreferencesGroup({
            title: _('Lists and Cleanup'),
            description: _('List values are comma-separated'),
        });

        this.generalGroup.add(this._editorLocation);
        this.generalGroup.add(this._customCmdArgs);
        this.generalGroup.add(this._customIcon);

        this.behaviorGroup.add(this._newWindow);
        this.behaviorGroup.add(this._preferWorkspaceFile);
        this.behaviorGroup.add(this._refreshInterval);
        this.behaviorGroup.add(this._debug);

        this.cleanupGroup.add(this._cleanupOrphans);
        this.cleanupGroup.add(this._nofailWorkspaces);
        this.cleanupGroup.add(this._favoriteWorkspaces);

        this._bindStandardFields();
        this._loadListFields();
    }

    persistSpecialFields(): void {
        this._settings.set_strv('nofail-workspaces', this._csvToStrv(this._nofailWorkspaces.text));
        this._settings.set_strv('favorite-workspaces', this._csvToStrv(this._favoriteWorkspaces.text));
        Gio.Settings.sync();
    }

    private _bindStandardFields(): void {
        this._settings.bind('editor-location', this._editorLocation, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-cmd-args', this._customCmdArgs, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-icon', this._customIcon, 'text', Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('new-window', this._newWindow, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('prefer-workspace-file', this._preferWorkspaceFile, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('cleanup-orphaned-workspaces', this._cleanupOrphans, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('debug', this._debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('refresh-interval', this._refreshInterval, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    private _loadListFields(): void {
        this._nofailWorkspaces.text = this._settings.get_strv('nofail-workspaces').join(', ');
        this._favoriteWorkspaces.text = this._settings.get_strv('favorite-workspaces').join(', ');
    }

    private _csvToStrv(csv: string): string[] {
        return csv
            .split(',')
            .map(part => part.trim())
            .filter(part => part.length > 0);
    }
}

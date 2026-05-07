import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VSCodiumWorkspacesPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const ui = new SettingsUi(settings);

        const page = new Adw.PreferencesPage();
        page.add(ui.generalGroup);
        page.add(ui.behaviorGroup);

        window.add(page);
    }
}

class SettingsUi {
    private readonly _settings: Gio.Settings;

    generalGroup: Adw.PreferencesGroup;
    behaviorGroup: Adw.PreferencesGroup;

    private readonly _editorLocation: Adw.EntryRow;
    private readonly _customCmdArgs: Adw.EntryRow;
    private readonly _customIcon: Adw.EntryRow;

    private readonly _preferWorkspaceFile: Adw.SwitchRow;
    private readonly _debug: Adw.SwitchRow;

    private readonly _refreshInterval: Adw.SpinRow;

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

        this._preferWorkspaceFile = new Adw.SwitchRow({ title: _('Consider .code-workspace Files Only') });
        this._debug = new Adw.SwitchRow({ title: _('Debug Logging') });

        this._refreshInterval = new Adw.SpinRow({
            title: _('Refresh Interval (seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 1,
            }),
        });

        this.generalGroup = new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Editor and icon settings'),
        });

        this.behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
            description: _('Workspace discovery and refresh behavior'),
        });

        this.generalGroup.add(this._editorLocation);
        this.generalGroup.add(this._customCmdArgs);
        this.generalGroup.add(this._customIcon);

        this.behaviorGroup.add(this._preferWorkspaceFile);
        this.behaviorGroup.add(this._refreshInterval);
        this.behaviorGroup.add(this._debug);

        this._bindStandardFields();
    }

    private _bindStandardFields(): void {
        this._settings.bind('editor-location', this._editorLocation, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-cmd-args', this._customCmdArgs, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-icon', this._customIcon, 'text', Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('prefer-workspace-file', this._preferWorkspaceFile, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('debug', this._debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('refresh-interval', this._refreshInterval, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}

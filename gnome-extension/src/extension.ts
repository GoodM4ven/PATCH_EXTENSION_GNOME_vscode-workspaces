import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { VSCodeWorkspacesCore } from './core.js';

export default class VSCodeWorkspacesExtension extends Extension {
    private _core: VSCodeWorkspacesCore | null = null;

    enable(): void {
        const settings: Gio.Settings = this.getSettings();
        this._core = new VSCodeWorkspacesCore(this.metadata, () => this.openPreferences(), settings);
        this._core.enable();
    }

    disable(): void {
        this._core?.disable();
        this._core = null;
    }
}

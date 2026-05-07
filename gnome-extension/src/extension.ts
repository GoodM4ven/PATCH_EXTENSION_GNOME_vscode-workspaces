import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { VSCodiumWorkspacesCore } from './core.js';

export default class VSCodiumWorkspacesExtension extends Extension {
    private _core: VSCodiumWorkspacesCore | null = null;

    enable(): void {
        const settings: Gio.Settings = this.getSettings();
        this._core = new VSCodiumWorkspacesCore(this.metadata, () => this.openPreferences(), settings);
        this._core.enable();
    }

    disable(): void {
        this._core?.disable();
        this._core = null;
    }
}

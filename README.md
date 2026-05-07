# VSCode Workspaces (GNOME 50+ Fork)

![GitHub License](https://img.shields.io/github/license/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces)

Forked for maintenance from [`ZanzyTHEbar/vscode-workspaces`](https://github.com/ZanzyTHEbar/vscode-workspaces).

## Objectives

- Targeting GNOME Shell `v50` initially...
- Rewritten GNOME extension internals for a cleaner code path.
- Fixes the stuck-hover-tooltip bug (tooltip now force-cleans on click, menu close, and disable).

## Installation (from source)

```bash
git clone https://github.com/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces.git
cd PATCH_EXTENSION_GNOME_vscode-workspaces/gnome-extension

make && make install

gnome-extensions enable vscode-workspaces@goodm4ven
```

### Debugging

```bash
journalctl /usr/bin/gnome-shell -f | grep vscode-workspaces
```

### Removal

```bash
gnome-extensions disable vscode-workspaces@goodm4ven
gnome-extensions uninstall vscode-workspaces@goodm4ven
```

Or remove files directly:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/vscode-workspaces@goodm4ven
```

## Optional Nautilus Integration

This repo still ships the optional Nautilus scripts:

- `vscode_nautilus_workspaces.py`
- `vscode-nautilus-open.py`

And an installation helper:

```bash
bash <(wget -qO- https://raw.githubusercontent.com/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces/main/install.sh)
```

## Credits

- [ZanzyTHEbar](https://github.com/ZanzyTHEbar) (the original developer)
- [OpenAI - Codex](https://developers.openai.com/codex/cli)

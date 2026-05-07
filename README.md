# VSCode Workspaces (GNOME 50+ Fork)

![GitHub License](https://img.shields.io/github/license/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces)

Fork of `ZanzyTHEbar/vscode-workspaces`, maintained as `GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces`.

## Scope

- Targets GNOME Shell `50` only in this branch.
- Rewritten GNOME extension internals for a cleaner code path.
- Fixes the stuck-hover-tooltip bug (tooltip now force-cleans on click, menu close, and disable).

## Install from Source

```bash
git clone https://github.com/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces.git
cd PATCH_EXTENSION_GNOME_vscode-workspaces/gnome-extension

make && make install
```

Then enable it:

```bash
gnome-extensions enable vscode-workspaces@goodm4ven
```

## Uninstall

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

Install helper:

```bash
bash <(wget -qO- https://raw.githubusercontent.com/GoodM4ven/PATCH_EXTENSION_GNOME_vscode-workspaces/main/install.sh)
```

## Debugging

```bash
journalctl /usr/bin/gnome-shell -f | grep vscode-workspaces
```

# VSCodium Workspaces

Forked for maintenance from the original project by [ZanzyTHEbar](https://github.com/ZanzyTHEbar), then rebranded for VSCodium-first usage.

## Objectives

- Targeting GNOME Shell `v50` initially...
- Rewritten GNOME extension internals for a cleaner code path.
- Fixes the stuck-hover-tooltip bug (tooltip now force-cleans on click, menu close, and disable).

## Installation (from source)

```bash
git clone https://github.com/GoodM4ven/PATCH_EXTENSION_GNOME_vscodium-workspaces.git
cd PATCH_EXTENSION_GNOME_vscodium-workspaces/gnome-extension

make install

gnome-extensions enable vscodium-workspaces@goodm4ven
```

`zip` is only required for publishing via `make pack`.

### Debugging

```bash
journalctl /usr/bin/gnome-shell -f | grep vscodium-workspaces
```

### Removal

```bash
gnome-extensions disable vscodium-workspaces@goodm4ven
gnome-extensions uninstall vscodium-workspaces@goodm4ven
```

Or remove files directly:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/vscodium-workspaces@goodm4ven
```

## Optional Nautilus Integration

This repo still ships the optional Nautilus scripts:

- `vscodium_nautilus_workspaces.py`
- `vscodium-nautilus-open.py`

Install Nautilus Python bindings (package name varies by distro), then copy scripts to Nautilus extensions:

```bash
mkdir -p ~/.local/share/nautilus-python/extensions
cp vscodium_nautilus_workspaces.py ~/.local/share/nautilus-python/extensions/
cp vscodium-nautilus-open.py ~/.local/share/nautilus-python/extensions/
chmod +x ~/.local/share/nautilus-python/extensions/vscodium_nautilus_workspaces.py
chmod +x ~/.local/share/nautilus-python/extensions/vscodium-nautilus-open.py
nautilus -q
```

## Credits

- [ZanzyTHEbar](https://github.com/ZanzyTHEbar) (the original developer)
- [OpenAI - Codex](https://developers.openai.com/codex/cli)

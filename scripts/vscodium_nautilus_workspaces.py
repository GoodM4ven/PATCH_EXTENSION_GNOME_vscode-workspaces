import json
import logging
import os
from subprocess import call
from urllib.parse import unquote

from gi.repository import GLib, GObject, Nautilus

# Configure logging
logging.basicConfig(
    filename="/tmp/vscodium_workspaces_extension.log", level=logging.DEBUG
)

# Path to the recent workspaces JSON file
RECENT_WORKSPACES_PATH = os.path.expanduser(
    "~/.config/VSCodium/User/globalStorage/storage.json"
)

# path to vscodium
VSCODIUM = "codium"

# what name do you want to see in the context menu?
VSCODIUMNAME = "VSCodium"

# always create new window?
NEWWINDOW = False


class VSCodiumWorkspacesExtension(GObject.GObject, Nautilus.MenuProvider):
    def __init__(self):
        super(VSCodiumWorkspacesExtension, self).__init__()
        logging.info("VSCodiumWorkspacesExtension initialized")

    def launch_vscodium(self, menu, files):
        logging.info(f"Launching {VSCODIUMNAME} with {files}")

        safepaths = ""
        args = ""

        for file in files:
            if file.startswith("file://"):
                file = file.replace("file://", "")
            safepaths += '"' + file + '" '

            logging.info(f"File path: {safepaths}")

            # If one of the files we are trying to open is a folder
            # create a new instance of vscodium
            if os.path.isdir(file) and os.path.exists(file):
                logging.info(f"Found a directory: {file}")
                args = "--new-window "

        args = "--new-window " if NEWWINDOW else ""

        if len(files) == 1 and files[0].startswith("vscode-remote://"):
            args = "--folder-uri"

        command = f"{VSCODIUM} {args} {safepaths} &"
        logging.info(f"Command to execute: {command}")

        try:
            call(command, shell=True)
            logging.info(f"Successfully launched {VSCODIUMNAME} with {safepaths}")
        except Exception as e:
            logging.error(f"Failed to launch {VSCODIUMNAME} with {safepaths}: {e}")

    def _get_recent_workspaces(self):
        if not os.path.exists(RECENT_WORKSPACES_PATH):
            logging.debug("Recent workspaces file not found")
            return []

        with open(RECENT_WORKSPACES_PATH, "r") as f:
            storage_data = json.load(f)

        # logging.debug(f"Read storage data: {storage_data}")

        # Extract workspaces from profileAssociations
        workspaces = storage_data.get("profileAssociations", {}).get("workspaces", {})
        workspace_paths = []
        for ws in workspaces.keys():
            ws = unquote(ws)
            if ws.startswith("file://"):
                if os.path.exists(ws.replace("file://", "")):
                    workspace_paths.append(ws)
            else:
                workspace_paths.append(ws)
        workspace_paths = workspace_paths[::-1]
        logging.info(f"Workspace paths: {workspace_paths}")
        return workspace_paths

    def _open_workspace(self, menu, workspace_path):
        logging.debug(f"Opening workspace: {workspace_path}")
        self.launch_vscodium(menu, [workspace_path])

    def _get_name(self, workspace):
        # Handle file:// paths
        if workspace.startswith("file://"):
            path = workspace.replace("file://", "")
            return path.replace(GLib.get_home_dir(), "~")

        # Early return for non-remote paths
        if not workspace.startswith("vscode-remote://ssh-remote+"):
            return workspace

        # Process SSH remote workspace path
        parts = workspace[len("vscode-remote://ssh-remote+"):].split("/", 3)

        # Validate path structure
        if len(parts) < 2:
            return None
        ssh_host = parts[0]

        # Construct workspace path
        workspace_path = f"~/{parts[3]}" if len(
            parts) >= 4 else "/".join(parts[1:])

        return f"[SSH: {ssh_host}] {workspace_path}"

    def get_background_items(self, window):
        recent_workspaces = self._get_recent_workspaces()
        logging.debug(f"Recent workspaces: {recent_workspaces}")

        if not recent_workspaces:
            return

        menu_item = Nautilus.MenuItem(
            name="VSCodiumWorkspacesExtension::OpenRecent",
            label="Open Recent Workspaces",
            tip="Show recent VSCodium workspaces",
        )

        submenu = Nautilus.Menu()
        menu_item.set_submenu(submenu)

        for workspace in recent_workspaces:
            workspace_name = self._get_name(workspace)
            if workspace_name is None:
                continue
            item = Nautilus.MenuItem(
                name=f"VSCodiumWorkspacesExtension::Open_{workspace_name}",
                label=workspace_name,
                tip=f"Open {workspace_name}",
            )
            item.connect("activate", self._open_workspace, workspace)
            submenu.append_item(item)

        return [menu_item]

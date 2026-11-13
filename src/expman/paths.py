"""Locations and migration for per-log-directory and user-wide app data."""

import json
import os
from pathlib import Path


def user_directory(override=None):
    return (
        Path(override or os.environ.get("EXPMAN_HOME", Path.home() / ".expman"))
        .expanduser()
        .resolve()
    )


def workspace_state_path(logdir: Path, override=None):
    return (
        Path(override).expanduser().absolute()
        if override is not None
        else logdir / ".expman" / "state.json"
    )


def migrate_legacy_state(store, candidates):
    if store.path.exists():
        return None
    for candidate in dict.fromkeys(Path(path).absolute() for path in candidates):
        if candidate == store.path or not candidate.is_file():
            continue
        saved = json.loads(candidate.read_text())
        workspaces = saved.get("workspaces", {}) if isinstance(saved, dict) else {}
        if not isinstance(workspaces, dict) or store.workspace not in workspaces:
            continue
        workspace = workspaces[store.workspace]
        if not isinstance(workspace, dict):
            raise ValueError(f"Invalid legacy workspace state in {candidate}")

        def migrate(state, previous=workspace):
            for key, default in state.items():
                if key in previous and isinstance(previous[key], type(default)):
                    state[key] = previous[key]

        store.update(migrate)
        return str(candidate)
    return None

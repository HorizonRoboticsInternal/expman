"""Atomic, separate persistence for experiment annotations and workspace preferences."""

import copy
import json
import os
import tempfile
import threading
from pathlib import Path


class StateStore:
    def __init__(self, path: Path, workspace="default", defaults=None):
        self.path = Path(path).expanduser().absolute()
        self.workspace = workspace
        self.lock = threading.RLock()
        self.workspaces = {}
        self.state = (
            copy.deepcopy(defaults)
            if defaults is not None
            else {
                "ignored_configs": [],
                "ignored_files": [],
                "json_metrics": ["{experiment}/evaluation_metrics.json"],
                "groups": [],
                "named_filters": [],
                "experiments": {},
                "view": {},
            }
        )
        if self.path.exists():
            try:
                saved = json.loads(self.path.read_text())
                if not isinstance(saved, dict):
                    raise ValueError("state must be a JSON object")
                if workspace is not None:
                    self.workspaces = saved.get("workspaces", {})
                    if not isinstance(self.workspaces, dict):
                        raise ValueError("workspaces must be a JSON object")
                    saved = self.workspaces.get(workspace, saved if workspace == "default" else {})
                if not isinstance(saved, dict):
                    raise ValueError("workspace state must be a JSON object")
                for key, expected in self.state.items():
                    if key in saved and isinstance(saved[key], type(expected)):
                        self.state[key] = saved[key]
            except (OSError, ValueError) as error:
                raise ValueError(f"Cannot read workspace state {path}: {error}") from error

    def read(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def update(self, mutate):
        with self.lock:
            updated = copy.deepcopy(self.state)
            mutate(updated)
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(
                dir=self.path.parent, prefix=".state-", suffix=".json"
            )
            try:
                with os.fdopen(descriptor, "w") as output:
                    workspaces = {**self.workspaces, self.workspace: updated}
                    document = (
                        updated
                        if self.workspace is None
                        else {"version": 1, "workspaces": workspaces}
                    )
                    json.dump(
                        document,
                        output,
                        indent=2,
                        ensure_ascii=False,
                        allow_nan=False,
                    )
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(name, self.path)
            finally:
                Path(name).unlink(missing_ok=True)
            self.state = updated
            self.workspaces = workspaces
            return self.read()

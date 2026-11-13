"""Safe, deterministic YAML and JSON configuration loading and comparison."""

import fnmatch
import json
import math
from collections.abc import Mapping
from datetime import date, datetime
from pathlib import Path

import yaml

_SAFE_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


def normalize(value):
    if isinstance(value, Mapping):
        return {str(key): normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    return str(value)


def flatten(value, prefix=""):
    result = {}
    if isinstance(value, dict) and value:
        for key, item in value.items():
            segment = str(key).replace("\\", "\\\\").replace(".", "\\.")
            result.update(flatten(item, f"{prefix}.{segment}" if prefix else segment))
    else:
        result[prefix or "value"] = value
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def ignored(key, patterns):
    return any(
        key == pattern or key.startswith(pattern + ".") or fnmatch.fnmatchcase(key, pattern)
        for pattern in patterns
    )


def config_paths(directory: Path, excluded_paths=()):
    paths = sorted(
        path
        for pattern in ["*.yaml", "*.yml", "*.json"]
        for path in directory.glob(pattern)
        if path.is_file() and path not in excluded_paths and path.name != "evaluation_metrics.json"
    )
    names = ["config.yaml", "config.yml", "config.json"]
    hydra = [directory / ".hydra" / name for name in names]
    if not any(path.name in names for path in paths):
        paths.extend(path for path in hydra if path.is_file())
    preferred = [directory / name for name in names] + hydra
    paths.sort(key=lambda path: preferred.index(path) if path in preferred else len(preferred))
    return [path for path in paths if path.is_file() and path not in excluded_paths]


def load_configs(directory: Path, excluded_paths=()):
    flat, files, warnings = {}, [], []
    paths = config_paths(directory, excluded_paths)
    paths += sorted(
        path
        for pattern in ["*/hparams.yml", "*/hparams.yaml", "*/hparams.json"]
        for path in directory.glob(pattern)
        if path.is_file() and path not in excluded_paths
    )
    for index, path in enumerate(paths):
        filename = str(path.relative_to(directory))
        try:
            if path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("configuration exceeds the 8 MiB limit")
            content = path.read_text(encoding="utf-8-sig" if path.suffix == ".json" else "utf-8")
            files.append({"name": filename, "content": content, "primary": index == 0})
            value = normalize(
                json.loads(content)
                if path.suffix == ".json"
                else yaml.load(content, Loader=_SAFE_LOADER)
            )
            current = flatten(value)
            if index:
                current = {f"@{filename}::{key}": item for key, item in current.items()}
            flat.update(current)
        except (OSError, UnicodeError, yaml.YAMLError, ValueError, RecursionError) as error:
            warnings.append(f"{filename}: {error}")
    return flat, files, warnings


def excluded_file(key, files, patterns):
    filename = files[0]["name"] if files else ""
    if key.startswith("@") and "::" in key:
        filename = key[1:].split("::", 1)[0]
    basename = Path(filename).name
    return any(
        fnmatch.fnmatchcase(filename if "/" in pattern else basename, pattern)
        for pattern in patterns
    )


def active_config(experiment, patterns, file_patterns=()):
    return {
        key: value
        for key, value in experiment.config.items()
        if not ignored(key, patterns)
        and not excluded_file(key, experiment.config_files, file_patterns)
    }


def compare(experiments, patterns, differences_only=True, show_ignored=False, file_patterns=()):
    rows = []
    keys = sorted({key for experiment in experiments for key in experiment.config})
    for key in keys:
        is_ignored = ignored(key, patterns) or any(
            key in experiment.config and excluded_file(key, experiment.config_files, file_patterns)
            for experiment in experiments
        )
        cells = [
            {"present": key in experiment.config, "value": experiment.config.get(key)}
            for experiment in experiments
        ]
        different = len({canonical(cell) for cell in cells}) > 1
        if (is_ignored and not show_ignored) or (differences_only and not different):
            continue
        rows.append({"key": key, "different": different, "ignored": is_ignored, "cells": cells})
    return rows

"""Typed configuration predicates shared by saved experiment filter sets."""

import json
import math
from fnmatch import fnmatchcase


def text_value(value):
    return (
        value
        if isinstance(value, str)
        else json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )


def equal_values(first, second):
    if isinstance(first, bool) or isinstance(second, bool):
        return type(first) is type(second) and first == second
    if isinstance(first, (int, float)) and isinstance(second, (int, float)):
        return first == second
    if type(first) is not type(second):
        return False
    if isinstance(first, dict):
        return first.keys() == second.keys() and all(
            equal_values(value, second[key]) for key, value in first.items()
        )
    if isinstance(first, list):
        return len(first) == len(second) and all(
            equal_values(left, right) for left, right in zip(first, second, strict=True)
        )
    return first == second


def matches(config, predicates, path=""):
    for predicate in predicates:
        key, operator = predicate["key"], predicate["operator"]
        if operator not in {
            "eq",
            "ne",
            "contains",
            "not_contains",
            "glob",
            "gt",
            "gte",
            "lt",
            "lte",
            "exists",
            "missing",
        }:
            return False
        values = {key: path} if predicate.get("source") == "path" else config
        present = key in values
        if operator == "exists":
            if not present:
                return False
            continue
        if operator == "missing":
            if present:
                return False
            continue
        if not present:
            return False
        actual, expected = values[key], predicate.get("value")
        if operator == "eq" and not equal_values(actual, expected):
            return False
        if operator == "ne" and equal_values(actual, expected):
            return False
        if operator == "glob" and not fnmatchcase(text_value(actual), text_value(expected)):
            return False
        if (
            operator == "contains"
            and text_value(expected).lower() not in text_value(actual).lower()
        ):
            return False
        if (
            operator == "not_contains"
            and text_value(expected).lower() in text_value(actual).lower()
        ):
            return False
        if operator in {"gt", "gte", "lt", "lte"}:
            if not all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
                for value in [actual, expected]
            ):
                return False
            if not {
                "gt": actual > expected,
                "gte": actual >= expected,
                "lt": actual < expected,
                "lte": actual <= expected,
            }[operator]:
                return False
    return True

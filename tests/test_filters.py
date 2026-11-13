import pytest

from expman.app import create_app
from expman.filters import matches


@pytest.mark.parametrize(
    ("config", "rule", "expected"),
    [
        ({"value": True}, {"key": "value", "operator": "eq", "value": 1}, False),
        ({"value": 1.0}, {"key": "value", "operator": "eq", "value": 1}, True),
        ({"value": None}, {"key": "value", "operator": "exists"}, True),
        ({}, {"key": "value", "operator": "eq", "value": None}, False),
        ({}, {"key": "value", "operator": "missing"}, True),
        ({"value": "Transformer"}, {"key": "value", "operator": "contains", "value": "FORM"}, True),
        (
            {"value": [1, {"other": False}]},
            {"key": "value", "operator": "eq", "value": [1.0, {"other": False}]},
            True,
        ),
        ({"value": 2}, {"key": "value", "operator": "gte", "value": 2}, True),
        ({"value": 2}, {"key": "value", "operator": "lte", "value": 2}, True),
        ({"value": "2"}, {"key": "value", "operator": "gt", "value": 1}, False),
    ],
)
def test_typed_filter_predicates(config, rule, expected):
    assert matches(config, [rule]) is expected


@pytest.mark.parametrize(
    ("path", "value", "expected"),
    [
        ("train/exp001", "EXP001", False),
        ("train/exp002", "exp001", True),
        ("train/exp001", "exp00[1]", True),
        ("train/exp001", "", False),
    ],
)
def test_path_does_not_contain_is_literal_and_case_insensitive(path, value, expected):
    predicate = {"source": "path", "key": "path", "operator": "not_contains", "value": value}
    assert matches({}, [predicate], path) is expected


def test_saved_path_exclusion_matches_and_persists(client, client_factory):
    runs = client.get("/api/experiments").json()["experiments"]
    excluded = runs[0]["path"].upper()
    definition = {
        "name": "Exclude experiment path",
        "filters": [
            {"source": "path", "key": "path", "operator": "not_contains", "value": excluded}
        ],
    }
    created = client.post("/api/filters", json=definition)
    assert created.status_code == 201, created.text
    identifier = created.json()["id"]
    expected = [run["id"] for run in runs if excluded.lower() not in run["path"].lower()]
    result = client.post(f"/api/filters/{identifier}/matches").json()
    assert result["experiment_ids"] == expected
    assert result["count"] == len(runs) - 1
    reopened = create_app(
        client.app.state.repository.root, client.app.state.store.path, tensorboard_loader="python"
    )
    with client_factory(reopened) as restored:
        assert restored.get("/api/filters").json()[0]["filters"] == definition["filters"]
        assert restored.post(f"/api/filters/{identifier}/matches").json() == result


def test_named_filter_crud_matching_archives_and_persistence(client):
    definition = {
        "name": "Transformer seeds",
        "filters": [
            {"key": "model.architecture", "operator": "eq", "value": "transformer"},
            {"key": "seed", "operator": "gte", "value": 1},
        ],
    }
    created = client.post("/api/filters", json=definition)
    assert created.status_code == 201
    saved = created.json()
    identifier = saved["id"]
    assert client.get("/api/filters").json() == [saved]
    matching = client.post(f"/api/filters/{identifier}/matches").json()
    assert matching["count"] == 2
    names = [
        client.get("/api/experiments/" + run_id).json()["name"]
        for run_id in matching["experiment_ids"]
    ]
    assert names == ["exp001", "exp002"]
    client.patch("/api/experiments/" + matching["experiment_ids"][0], json={"archived": True})
    assert client.post(f"/api/filters/{identifier}/matches").json()["count"] == 1
    assert (
        client.post("/api/filters", json={**definition, "name": "TRANSFORMER SEEDS"}).status_code
        == 409
    )
    reopened = create_app(client.app.state.repository.root, client.app.state.store.path)
    assert reopened.state.store.read()["named_filters"] == [saved]
    edited = client.put(
        f"/api/filters/{identifier}",
        json={
            "name": "Mixture models",
            "filters": [{"key": "model.architecture", "operator": "eq", "value": "moe"}],
        },
    )
    assert edited.status_code == 200
    assert client.post(f"/api/filters/{identifier}/matches").json()["count"] == 3
    assert client.delete(f"/api/filters/{identifier}").json() == []
    assert client.post(f"/api/filters/{identifier}/matches").status_code == 404


def test_named_filters_are_log_directory_specific(tmp_path, client_factory):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    with client_factory(create_app(first)) as client:
        result = client.post(
            "/api/filters",
            json={"name": "Baseline", "filters": [{"key": "seed", "operator": "eq", "value": 0}]},
        )
        assert result.status_code == 201
    assert create_app(first).state.store.read()["named_filters"]
    assert not create_app(second).state.store.read()["named_filters"]


def test_invalid_named_filter_definitions_and_unknown_ids(client):
    assert client.post("/api/filters", json={"name": "Empty", "filters": []}).status_code == 422
    assert (
        client.post(
            "/api/filters", json={"name": " ", "filters": [{"key": "seed", "operator": "exists"}]}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/filters",
            json={
                "name": "Invalid numeric",
                "filters": [{"key": "seed", "operator": "gt", "value": True}],
            },
        ).status_code
        == 422
    )
    assert client.delete("/api/filters/unknown").status_code == 404


def test_named_path_filters_combine_with_configuration_and_survive_reload(client):
    definition = {
        "name": "Selected paths",
        "filters": [
            {"source": "path", "key": "path", "operator": "glob", "value": "exp00[12]"},
            {"key": "seed", "operator": "eq", "value": 1},
        ],
    }
    saved = client.post("/api/filters", json=definition).json()
    result = client.post(f"/api/filters/{saved['id']}/matches").json()
    assert result["count"] == 1
    experiment = client.get("/api/experiments/" + result["experiment_ids"][0]).json()
    assert experiment["path"] == "exp001"
    reopened = create_app(client.app.state.repository.root, client.app.state.store.path)
    assert reopened.state.store.read()["named_filters"][0]["filters"][0]["source"] == "path"

"""Exercise bundled Plotly and native scalar loading through actual browser controls."""

import csv
import os
import re
import statistics
import time
from urllib.parse import urlsplit

import pytest
from tensorboard.compat.proto import event_pb2, summary_pb2
from tensorboard.summary.writer.event_file_writer import EventFileWriter

from expman.demo import generate_demo

from .conftest import STRESS_POINTS, wait_for_overview

playwright = pytest.importorskip("playwright.sync_api", reason="Install tests/ui/requirements.txt")
expect = playwright.expect
pytestmark = pytest.mark.ui


def wait_for_plot(page, selector):
    page.wait_for_function(
        """selector => {
          const plot = document.querySelector(selector);
          return plot && plot._fullData && plot._fullData.length > 0;
        }""",
        arg=selector,
        timeout=60_000,
    )


def main_traces(page, selector="#curve-0"):
    return page.locator(selector).evaluate(
        """plot => plot.data.filter(trace => trace.showlegend !== false).map(trace => ({
          id: trace.legendgroup, x: Array.from(trace.x), y: Array.from(trace.y),
          original: trace.customdata.map(value => value[2]),
          color: trace.line.color, simplify: trace.line.simplify, visible: trace.visible
        }))"""
    )


def assert_full_resolution(page, selector, trace_index=0, positions=None):
    positions = list(range(STRESS_POINTS)) if positions is None else positions
    rendered = page.locator(selector).evaluate(
        """(plot, index) => ({
          inputs: plot.data[index].x.length,
          defaults: plot._fullData[index].x.length,
          calculations: plot.calcdata[index].map(point => point.x),
          simplified: plot._fullData[index].line.simplify,
          vertices: Array.from(plot.querySelectorAll('.scatterlayer .trace')[index]
            .querySelectorAll('.js-line')).reduce(
            (count, path) => count + (path.getAttribute('d').match(/[MLHV]/g) || []).length, 0)
        })""",
        arg=trace_index,
    )
    assert rendered["inputs"] == rendered["defaults"] == len(positions)
    assert rendered["calculations"] == positions
    assert rendered["simplified"] is False
    assert rendered["vertices"] >= len(positions)


def saved_view(response, predicate):
    return (
        urlsplit(response.url).path == "/api/view"
        and response.request.method == "PUT"
        and predicate(response.request.post_data_json["view"])
    )


def change_number(locator, value):
    locator.fill(str(value))
    locator.press("Tab")


def type_smoothing(control, value):
    control.press("ControlOrMeta+a")
    control.press_sequentially(value, delay=100)
    expect(control).to_have_value(value)


def enable_fast_auto_refresh(page):
    page.evaluate("""() => {
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) =>
        interval(callback, delay === 30000 ? 500 : delay, ...args);
    }""")
    with page.expect_response("**/api/settings") as response:
        page.locator("#auto-refresh").check()
    assert response.value.ok


def combined_drag_point(page, tag, index):
    graph = page.locator("#combined-chart")
    graph.scroll_into_view_if_needed()
    point = graph.evaluate(
        """(plot, values) => {
          const trace = plot.data.find(item => item.meta.metric === values[0]);
          const layout = plot._fullLayout, index = values[1];
          return {x: layout.xaxis.l2p(layout.xaxis.d2l(trace.x[index])) + layout.xaxis._offset,
                  y: layout.yaxis.l2p(trace.y[index]) + layout.yaxis._offset};
        }""",
        arg=[tag, index],
    )
    box = graph.bounding_box()
    return box["x"] + point["x"], box["y"] + point["y"]


def expand_and_close(page, tag):
    page.locator(f'[data-action="expand-panel"][data-value="{tag}"]').click()
    dialog = page.locator("#panel-dialog")
    expect(dialog).to_be_visible()
    wait_for_plot(page, "#expanded-panel-plot")
    identities = page.locator("#expanded-panel-plot").evaluate(
        """plot => plot._fullData.map(trace => {
          plot.querySelector('.cb' + trace.uid);
          return trace.uid;
        })"""
    )
    assert len(identities) == len(set(identities))
    assert all(re.fullmatch(r"expman-[0-9a-f]+-[0-9a-f]+", value) for value in identities)
    dialog.get_by_role("button", name="Close", exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.locator("#overview-legend-home #overview-legend")).to_have_count(1)


def test_repeated_expand_close_and_regroup_with_real_plotly(ui_page):
    page = ui_page
    for grouping in ["", "saved", ""]:
        page.locator("#group-mode").select_option(grouping)
        wait_for_overview(page)
        for _ in range(3):
            for tag in ["train/loss", "eval/reward"]:
                expand_and_close(page, tag)
        assert page.locator(".legend").count() == 0
        assert page.locator("#overview-legend-home #overview-legend").count() == 1


def test_curve_hover_spacing_matches_in_expanded_plot(ui_page):
    page = ui_page

    def row_pitch(selector):
        graph = page.locator(selector)
        graph.scroll_into_view_if_needed()
        point = graph.evaluate("""plot => {
          const {xaxis, yaxis} = plot._fullLayout;
          return {x: xaxis.l2p(150) + xaxis._offset, y: yaxis._length / 2 + yaxis._offset};
        }""")
        box = graph.bounding_box()
        page.mouse.move(box["x"] + point["x"], box["y"] + point["y"])
        rows = graph.locator(".hoverlayer g.legend g.traces")
        expect(rows).to_have_count(4)
        positions = rows.evaluate_all("rows => rows.map(row => row.getBoundingClientRect().top)")
        return (positions[-1] - positions[0]) / (len(positions) - 1)

    inline_pitch = row_pitch("#curve-0")
    assert 10 <= inline_pitch <= 18
    page.get_by_role("button", name="Expand panel train/loss", exact=True).click()
    wait_for_plot(page, "#expanded-panel-plot")
    assert row_pitch("#expanded-panel-plot") == pytest.approx(inline_pitch, abs=1)


def test_independent_and_global_smoothing_reuses_observations(ui_page):
    page = ui_page
    calls = []
    page.on(
        "request",
        lambda request: (
            calls.append(request.url)
            if urlsplit(request.url).path in {"/api/curves", "/api/curves/all/jobs"}
            else None
        ),
    )
    before = main_traces(page)
    type_smoothing(page.locator("#smoothing-value"), "0.9")
    assert main_traces(page)[0]["y"] == before[0]["y"]
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["panelSmoothing"].get("train/loss") == 0.9
        )
    ):
        page.get_by_role("button", name="Apply to all panels", exact=True).click()
    for index in [0, 1]:
        traces = main_traces(page, f"#curve-{index}")
        first = traces[0]
        assert first["y"][1] == pytest.approx(
            (0.9 * first["original"][0] + first["original"][1]) / 1.9
        )
    first_control = page.locator('#view input[type="number"][data-panel-smoothing="train/loss"]')
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["panelSmoothing"].get("train/loss") == 0.2
        )
    ):
        type_smoothing(first_control, "0.2")
        first_control.press("Tab")
    expect(page.locator('input[type="number"][data-panel-smoothing="eval/reward"]')).to_have_value(
        "0.9"
    )
    expect(page.locator("#smoothing-value")).to_have_value("0.9")
    first = main_traces(page)[0]
    assert first["y"][1] == pytest.approx((0.2 * first["original"][0] + first["original"][1]) / 1.2)
    page.get_by_role("button", name="Expand panel train/loss", exact=True).click()
    dialog = page.locator("#panel-dialog")
    expanded_control = dialog.locator('input[type="number"][data-panel-smoothing="train/loss"]')
    type_smoothing(expanded_control, "0.9")
    expect(first_control).to_have_value("0.9")
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["panelSmoothing"].get("train/loss") == 0.2
        )
    ):
        type_smoothing(expanded_control, "0.2")
        expanded_control.press("Tab")
    dialog.get_by_role("button", name="Close", exact=True).click()
    assert not calls, "Smoothing changes must reuse the browser's loaded observations"
    page.reload()
    wait_for_overview(page)
    expect(page.locator('input[type="number"][data-panel-smoothing="train/loss"]')).to_have_value(
        "0.2"
    )
    expect(page.locator('input[type="number"][data-panel-smoothing="eval/reward"]')).to_have_value(
        "0.9"
    )


def test_shared_legend_isolation_colors_and_persistence(ui_page):
    page = ui_page
    button = page.locator('#overview-legend [data-action="toggle-overview-curve"]').first
    identifier = button.get_attribute("data-value")
    button.click()
    expect(button).to_have_attribute("aria-pressed", "false")
    for index in [0, 1]:
        assert (
            next(item for item in main_traces(page, f"#curve-{index}") if item["id"] == identifier)[
                "visible"
            ]
            == "legendonly"
        )
    button.dblclick()
    expect(button).to_have_attribute("aria-pressed", "true")
    for index in [0, 1]:
        traces = main_traces(page, f"#curve-{index}")
        assert all(
            item["visible"] == (True if item["id"] == identifier else "legendonly")
            for item in traces
        )
    button.dblclick()
    expect(page.get_by_role("button", name="Show all curves", exact=True)).to_be_disabled()
    color = page.locator(f'[data-overview-color="{identifier}"]')
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["overviewColors"].get(identifier) == "#123456"
        )
    ):
        color.evaluate(
            """input => {
              input.value = '#123456';
              input.dispatchEvent(new Event('change', {bubbles: true}));
            }"""
        )
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: identifier in view["hiddenOverviewCurves"]
        )
    ):
        button.click()
    requests = []
    page.on(
        "request",
        lambda request: (
            requests.append(request.post_data_json)
            if urlsplit(request.url).path == "/api/curves"
            else None
        ),
    )
    page.reload()
    wait_for_overview(page)
    expect(page.locator(f'[data-overview-color="{identifier}"]')).to_have_value("#123456")
    expect(button).to_have_attribute("aria-pressed", "false")
    assert requests and all(identifier not in request["experiment_ids"] for request in requests)
    assert all(item["id"] != identifier for item in main_traces(page))
    requests.clear()
    with page.expect_response("**/api/curves"):
        button.click()
    page.wait_for_function(
        "id => document.getElementById('curve-0').data.some(trace => trace.legendgroup === id)",
        arg=identifier,
    )
    assert requests and all(request["experiment_ids"] == [identifier] for request in requests)
    assert (
        next(item for item in main_traces(page) if item["id"] == identifier)["color"] == "#123456"
    )
    expect(page.locator("#selection-chips .color-dot").first).to_have_css(
        "background-color", "rgb(18, 52, 86)"
    )
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    expect(page.locator(f'.run-name[data-value="{identifier}"] .color-dot')).to_have_css(
        "background-color", "rgb(18, 52, 86)"
    )


@pytest.mark.ui_scenario("plot-refresh")
def test_refresh_updates_only_visible_curves_in_one_panel(ui_page, tmp_path):
    page = ui_page
    panel = page.locator("#curve-0")
    legend = page.locator('#overview-legend [data-action="toggle-overview-curve"]')
    visible = legend.first.get_attribute("data-value")
    hidden = legend.nth(1).get_attribute("data-value")
    legend.first.dblclick()
    expect(legend.nth(1)).to_have_attribute("aria-pressed", "false")
    refresh = page.get_by_role("button", name="Refresh visible curves for train/loss")
    expect(refresh).to_be_enabled()
    panel.evaluate("""plot => {
      window.__otherPanelData = document.getElementById('curve-1').data;
      return Plotly.relayout(plot, {'xaxis.range': [100, 160], 'xaxis.autorange': false});
    }""")

    def append_point(step):
        writer = EventFileWriter(str(tmp_path / "logs" / "exp000"))
        try:
            writer.add_event(
                event_pb2.Event(
                    step=step,
                    wall_time=1_790_004_000 + step,
                    summary=summary_pb2.Summary(
                        value=[summary_pb2.Summary.Value(tag="train/loss", simple_value=0.125)]
                    ),
                )
            )
        finally:
            writer.close()

    append_point(400)
    endpoint = page.url.rstrip("/") + "/api/curves"
    deadline = time.monotonic() + 20
    while True:
        response = page.request.post(
            endpoint,
            data={"experiment_ids": [visible], "tags": ["train/loss"], "source": "tensorboard"},
        )
        curves = response.json()["curves"]["train/loss"]
        if curves and curves[0]["x"][-1] == 400:
            break
        assert time.monotonic() < deadline
        page.wait_for_timeout(200)
    hidden_before = next(trace for trace in main_traces(page) if trace["id"] == hidden)
    calls = []
    page.on("request", lambda request: calls.append(urlsplit(request.url).path))
    with page.expect_response("**/api/curves") as sampled:
        refresh.click()
    assert sampled.value.request.post_data_json["experiment_ids"] == [visible]
    assert sampled.value.request.post_data_json["tags"] == ["train/loss"]
    expect(refresh).to_be_enabled()
    traces = {trace["id"]: trace for trace in main_traces(page)}
    assert traces[visible]["x"][-1] == 400 and traces[visible]["original"][-1] == 0.125
    assert traces[hidden] == hidden_before
    assert panel.evaluate("plot => plot._fullLayout.xaxis.range") == [100, 160]
    assert page.locator("#curve-1").evaluate("plot => plot.data === window.__otherPanelData")
    assert [path for path in calls if path.startswith(("/api/curves", "/api/refresh"))] == [
        "/api/curves"
    ]

    with page.expect_response("**/api/curves/all/jobs") as full:
        page.locator('[data-full-panel="train/loss"] button').click()
    assert full.value.request.post_data_json["experiment_ids"] == [visible]
    expect(page.locator('[data-full-panel="train/loss"]')).to_have_text(
        "All values loaded", timeout=60_000
    )
    page.get_by_role("button", name="Expand panel train/loss", exact=True).click()
    dialog = page.locator("#panel-dialog")
    append_point(401)
    with page.expect_response("**/api/curves/all/jobs") as complete:
        dialog.get_by_role("button", name="Refresh visible curves for train/loss").click()
    assert complete.value.request.post_data_json["experiment_ids"] == [visible]
    expect(
        dialog.get_by_role("button", name="Refresh visible curves for train/loss")
    ).to_be_enabled(timeout=60_000)
    expect(dialog.locator('[data-full-panel="train/loss"]')).to_have_text("All values loaded")
    for selector in ("#curve-0", "#expanded-panel-plot"):
        traces = {trace["id"]: trace for trace in main_traces(page, selector)}
        assert traces[visible]["x"][-1] == 401 and traces[visible]["simplify"] is False
        assert hidden not in traces
    dialog.get_by_role("button", name="Close", exact=True).click()
    legend.first.click()
    expect(refresh).to_be_disabled()
    with page.expect_response("**/api/curves/all/jobs") as revealed:
        page.get_by_role("button", name="Show all curves", exact=True).click()
    assert set(revealed.value.request.post_data_json["experiment_ids"]) == {
        button.get_attribute("data-value") for button in legend.all()
    } - {visible}
    expect(page.locator('[data-full-panel="train/loss"]')).to_have_text(
        "All values loaded", timeout=60_000
    )
    expect(refresh).to_be_enabled()
    assert {trace["id"] for trace in main_traces(page)} == {
        button.get_attribute("data-value") for button in legend.all()
    }
    page.locator("#group-mode").select_option("saved")
    wait_for_plot(page, "#curve-0")
    legend.filter(has_text="Other group").click()
    expect(legend.filter(has_text="Other group")).to_have_attribute("aria-pressed", "false")
    with page.expect_response("**/api/curves") as grouped:
        refresh.click()
    request = grouped.value.request.post_data_json
    assert set(request["experiment_ids"]) == {visible, hidden}
    assert request["group_ids"] == ["control"]
    expect(refresh).to_be_enabled()
    assert any(trace["id"] == "saved:other" for trace in main_traces(page))

    page.locator("#group-mode").select_option("config")
    fields = page.locator("#dialog")
    fields.get_by_label("model.architecture", exact=True).check()
    fields.get_by_role("button", name="Save", exact=True).click()
    transformer = legend.filter(has_text="transformer")
    with page.expect_response(
        lambda response: saved_view(
            response,
            lambda view: any("transformer" in key for key in view["hiddenOverviewCurves"]),
        )
    ):
        transformer.click()
    calls.clear()
    with page.expect_response("**/api/curves") as config_curves:
        page.reload()
    assert len(config_curves.value.request.post_data_json["experiment_ids"]) == 1
    assert config_curves.value.request.post_data_json["group_by"] == ["model.architecture"]
    wait_for_overview(page)
    expect(transformer).to_have_attribute("aria-pressed", "false")
    with page.expect_response("**/api/curves") as shown:
        transformer.click()
    assert {visible, hidden} <= set(shown.value.request.post_data_json["experiment_ids"])
    assert len(shown.value.request.post_data_json["experiment_ids"]) == 3


@pytest.mark.ui_scenario("annotations")
def test_experiment_favorites_details_archiving_and_persistence(ui_page):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    name = page.locator('.run-name[data-action="edit-run"]').first
    identifier = name.get_attribute("data-value")
    favorite = page.locator(f'[data-action="star"][data-value="{identifier}"]')
    page.locator("#result-metric").select_option("JSON/evaluation_metrics/score")
    favorite.click()
    expect(favorite).to_have_text("★")
    expect(page.locator(".experiment-table tbody tr").first.locator("td").nth(3)).to_have_text(
        "0.95"
    )
    page.reload()
    expect(favorite).to_have_text("★")
    page.locator(f'.run-name[data-value="{identifier}"]').click()
    dialog = page.locator("#dialog")
    expect(dialog).to_be_visible()
    dialog.get_by_label("Display name", exact=True).fill("Reference α")
    dialog.get_by_label("Tags · comma separated", exact=True).fill("baseline, keep")
    dialog.get_by_role("textbox", name="Notes", exact=True).fill(
        "Preserve configuration sources and metrics"
    )
    expect(dialog.get_by_label("Favorite", exact=True)).to_be_checked()
    dialog.get_by_label("Archived", exact=True).check()
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.locator(f'.run-name[data-value="{identifier}"]')).to_have_count(0)
    page.locator('[data-action="collection"][data-value="archived"]').click()
    page.locator(f'.run-name[data-value="{identifier}"]').click()
    expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Reference α")
    expect(dialog.get_by_role("textbox", name="Notes", exact=True)).to_have_value(
        "Preserve configuration sources and metrics"
    )
    dialog.get_by_label("Archived", exact=True).uncheck()
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(dialog).not_to_be_visible()
    page.locator('[data-action="collection"][data-value="starred"]').click()
    expect(page.locator(f'.run-name[data-value="{identifier}"]')).to_have_text("Reference α")
    favorite.click()
    expect(page.locator(f'.run-name[data-value="{identifier}"]')).to_have_count(0)
    page.locator('[data-action="collection"][data-value="all"]').click()
    expect(favorite).to_have_text("☆")
    page.reload()
    expect(favorite).to_have_text("☆")
    page.locator(f'.run-name[data-value="{identifier}"]').click()
    expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Reference α")
    expect(dialog.get_by_label("Archived", exact=True)).not_to_be_checked()
    dialog.get_by_role("button", name="Cancel", exact=True).click()


def test_pending_experiment_actions_show_feedback_and_respect_navigation(ui_page):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    name = page.locator('.run-name[data-action="edit-run"]').first
    identifier = name.get_attribute("data-value")
    held = []

    def hold_response(route):
        response = route.fetch()
        held.append((route, response))
        page.evaluate("window.__heldAnnotation = true")

    endpoint = "**/api/experiments/" + identifier
    page.route(endpoint, hold_response, times=1)
    name.click()
    dialog = page.locator("#dialog")
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text("Loading experiment details…")
    page.wait_for_function("window.__heldAnnotation === true")
    dialog.get_by_role("button", name="Close dialog", exact=True).click()
    with page.expect_response(
        lambda response: response.url.endswith("/api/experiments/" + identifier)
    ):
        held[0][0].fulfill(response=held[0][1])
    expect(dialog).not_to_be_visible()
    page.evaluate("window.__heldAnnotation = false")
    page.route(endpoint, hold_response, times=1)
    favorite = page.locator(f'[data-action="star"][data-value="{identifier}"]')
    favorite.click()
    expect(favorite).to_have_text("…")
    expect(favorite).to_be_disabled()
    expect(favorite).to_have_attribute("aria-busy", "true")
    page.wait_for_function("window.__heldAnnotation === true")
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    expect(page.locator("#config-table")).to_be_visible()
    with page.expect_response(
        lambda response: response.url.endswith("/api/experiments/" + identifier)
    ):
        held[1][0].fulfill(response=held[1][1])
    expect(page.locator("#config-table")).to_be_visible()
    expect(page.locator(".experiment-table")).to_have_count(0)
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    expect(favorite).to_have_text("★")
    expect(favorite).to_be_enabled()


def test_metric_discovery_cannot_revert_a_favorite(ui_page):
    page = ui_page
    held = []

    def hold_result(route):
        response = route.fetch()
        held.append((route, response))
        page.evaluate("window.__heldMetricResult = true")

    page.route("**/api/metrics/jobs/*/result", hold_result)
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    page.locator("input[data-select-run]").last.uncheck()
    page.wait_for_function("window.__heldMetricResult === true")
    favorite = page.locator('[data-action="star"]').first
    identifier = favorite.get_attribute("data-value")
    page.locator(f'.run-name[data-value="{identifier}"]').click()
    dialog = page.locator("#dialog")
    dialog.get_by_label("Display name", exact=True).fill("Updated reference")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(dialog).not_to_be_visible()
    favorite = page.locator(f'[data-action="star"][data-value="{identifier}"]')
    favorite.click()
    expect(favorite).to_have_text("★")
    with page.expect_response(
        lambda response: "/api/metrics/jobs/" in response.url and response.url.endswith("/result")
    ):
        held[0][0].fulfill(response=held[0][1])
    page.wait_for_function(
        """() => {
          const activity = document.getElementById('activity');
          return activity && activity.textContent.startsWith('Up to date');
        }"""
    )
    expect(page.locator(f'[data-action="star"][data-value="{identifier}"]')).to_have_text("★")
    expect(page.locator(f'.run-name[data-value="{identifier}"]')).to_have_text("Updated reference")


@pytest.mark.ui_scenario("stress")
def test_load_all_values_keeps_every_vertex_after_smoothing_and_expansion(ui_page):
    page = ui_page
    assert len(main_traces(page)[0]["x"]) < STRESS_POINTS
    page.get_by_role("button", name="Load all values", exact=True).click()
    expect(page.locator('[data-full-panel="stress/loss"]')).to_have_text(
        "All values loaded", timeout=120_000
    )
    page.wait_for_function(
        "count => document.getElementById('curve-0').data[0].x.length === count",
        arg=STRESS_POINTS,
        timeout=60_000,
    )
    first = main_traces(page)[0]
    assert first["x"] == list(range(STRESS_POINTS))
    assert len(first["original"]) == len(first["y"]) == STRESS_POINTS
    assert first["simplify"] is False
    assert first["original"][822] == pytest.approx(0.22)
    assert_full_resolution(page, "#curve-0")
    calls = []
    page.on(
        "request",
        lambda request: (
            calls.append(request.url)
            if urlsplit(request.url).path in {"/api/curves", "/api/curves/all/jobs"}
            else None
        ),
    )
    control = page.locator('input[type="number"][data-panel-smoothing="stress/loss"]')
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["panelSmoothing"].get("stress/loss") == 0.8
        )
    ):
        change_number(control, 0.8)
    assert len(main_traces(page)[0]["x"]) == STRESS_POINTS
    assert_full_resolution(page, "#curve-0")
    for _ in range(3):
        page.locator('[data-action="expand-panel"]').click()
        wait_for_plot(page, "#expanded-panel-plot")
        expanded = main_traces(page, "#expanded-panel-plot")[0]
        assert len(expanded["x"]) == STRESS_POINTS
        assert expanded["simplify"] is False
        assert_full_resolution(page, "#expanded-panel-plot")
        page.locator("#panel-dialog").get_by_role("button", name="Close", exact=True).click()
        expect(page.locator("#panel-dialog")).not_to_be_visible()
        assert_full_resolution(page, "#curve-0")
    assert not calls
    graph = page.locator("#curve-0")
    graph.scroll_into_view_if_needed()
    coordinates = graph.evaluate(
        """plot => {
          const index = 19050, trace = plot.data[0], layout = plot._fullLayout;
          return {x: layout.xaxis.l2p(trace.x[index]) + layout.xaxis._offset,
                  y: layout.yaxis.l2p(trace.y[index]) + layout.yaxis._offset};
        }"""
    )
    bounds = graph.bounding_box()
    page.mouse.move(bounds["x"] + coordinates["x"], bounds["y"] + coordinates["y"])
    hover = graph.locator(".hoverlayer")
    expect(hover).to_contain_text("Smoothed")
    expect(hover).to_contain_text("Original")
    expect(hover).not_to_contain_text("unavailable")
    expect(hover).to_contain_text(re.compile(r"Elapsed -?\d+d \d{2}:\d{2}:\d{2}"))


@pytest.mark.ui_scenario("sections")
def test_expanded_sections_load_offscreen_plots_without_extra_clicks(ui_page):
    page = ui_page
    section = page.locator('[data-panel-prefix="UI"]')
    section.locator(':scope > [data-action="toggle-panel-group"]').click()
    expect(page.locator('.overview-panel .card-title[title^="UI/panel/"]')).to_have_count(40)
    last = page.locator(".overview-panel").filter(
        has=page.locator('.card-title[title="UI/panel/39"]')
    )
    last.scroll_into_view_if_needed()
    last.locator(".chart").evaluate("plot => plot.dataset.uiLast = 'true'")
    wait_for_plot(page, '[data-ui-last="true"]')
    expect(page.locator("#overview-legend")).to_be_in_viewport(ratio=1)
    expect(page.get_by_role("button", name="Show these panels")).to_have_count(0)
    for index in [20, 28, 36, 39]:
        panel = page.locator(".overview-panel").filter(
            has=page.locator(f'.card-title[title="UI/panel/{index:02}"]')
        )
        panel.scroll_into_view_if_needed()
        wait_for_plot(page, "#" + panel.locator(".chart").get_attribute("id"))
        expect(page.locator("#overview-legend")).to_be_in_viewport(ratio=1)
    first = page.locator(".overview-panel").filter(
        has=page.locator('.card-title[title="UI/panel/00"]')
    )
    expect(first.locator(".chart")).to_contain_text("Loading plot when visible…")
    first.scroll_into_view_if_needed()
    wait_for_plot(page, "#" + first.locator(".chart").get_attribute("id"))
    expect(first.locator(".chart")).not_to_contain_text("Loading plot when visible…")
    expect(first.locator(".main-svg").first).to_be_visible()
    change_number(last.locator('input[type="number"][data-panel-smoothing]'), 0.6)
    section.locator(':scope > [data-action="toggle-panel-group"]').click()
    expect(page.locator('.overview-panel .card-title[title^="UI/panel/"]')).to_have_count(0)
    section.locator(':scope > [data-action="toggle-panel-group"]').click()
    last.scroll_into_view_if_needed()
    expect(last.locator('input[type="number"][data-panel-smoothing]')).to_have_value("0.6")
    last.locator(".chart").evaluate("plot => plot.dataset.uiLast = 'true'")
    wait_for_plot(page, '[data-ui-last="true"]')


@pytest.mark.ui_scenario("sections")
def test_metric_filter_shows_all_matching_plots_below_legend(ui_page):
    page = ui_page
    search = page.get_by_role("searchbox", name="Filter panels by metric tag")
    controls = page.locator(".toolbar").filter(has=search)
    chart_cards = page.locator("#overview-legend-home + #overview-panels .overview-panel")
    section = page.locator('[data-panel-prefix="UI"] > .panel-group-heading')
    expect(section).to_have_attribute("aria-expanded", "false")
    assert search.evaluate(
        "input => input.compareDocumentPosition(document.getElementById('overview-legend')) "
        "& Node.DOCUMENT_POSITION_FOLLOWING"
    )
    search.fill("  Ui/PaNeL/  ")
    expect(controls.get_by_role("status")).to_have_text("40 matching panels")
    expect(search).to_be_focused()
    expect(chart_cards).to_have_count(40)
    expect(page.locator("#overview-panels .panel-group")).to_have_count(0)
    expect(page.locator("#panels-per-page")).to_have_count(0)
    last = chart_cards.filter(has=page.locator('.card-title[title="UI/panel/39"]'))
    last.scroll_into_view_if_needed()
    wait_for_plot(page, "#" + last.locator(".chart").get_attribute("id"))

    search.fill("")
    expect(section).to_have_attribute("aria-expanded", "false")
    page.get_by_role("button", name="Choose panels", exact=True).click()
    dialog = page.locator("#dialog")
    dialog.get_by_label("train/loss", exact=True).uncheck()
    dialog.get_by_role("button", name="Save", exact=True).click()
    page.locator("#panels-per-page").select_option("8")
    page.locator('[data-action="panels-next"]').click()
    expect(controls.get_by_role("status")).to_contain_text("Showing 9–16")
    search.fill("ui/panel/")
    expect(chart_cards).to_have_count(40)
    expect(page.locator('[data-action="panels-next"]')).to_have_count(0)
    search.fill("no-such-metric")
    expect(chart_cards).to_have_count(0)
    expect(page.get_by_role("heading", name="No panels match this filter")).to_be_visible()
    search.fill("")
    expect(controls.get_by_role("status")).to_contain_text("Showing 9–16")


@pytest.mark.ui_scenario("stress")
def test_combined_load_all_keeps_dense_sparse_values_and_rejects_stale_samples(ui_page):
    page = ui_page
    tags = {"stress/loss", "stress/reward"}
    sampled, submissions = [], []

    def hold_sample(route):
        request = route.request.post_data_json
        if set(request["tags"]) == tags and not sampled:
            sampled.append((route, route.fetch()))
            page.evaluate("window.__combinedSampleHeld = true")
        else:
            route.continue_()

    def hold_submission(route):
        submissions.append((route, route.fetch()))
        page.evaluate("window.__combinedSubmissionHeld = true")

    page.route("**/api/curves", hold_sample)
    page.get_by_role("button", name="Combine metrics", exact=True).click()
    dialog = page.locator("#dialog")
    for checkbox in dialog.locator('input[name="choices"]').all():
        checkbox.set_checked(checkbox.get_attribute("value") in tags)
    dialog.get_by_role("button", name="Show plot", exact=True).click()
    page.wait_for_function("window.__combinedSampleHeld === true")
    retained = sampled[0][1].json()["curves"]["stress/loss"][0]["members"][0]["points"]
    assert len(retained) < STRESS_POINTS
    panel = page.locator(".combined-panel")
    page.route("**/api/curves/all/jobs", hold_submission, times=1)
    panel.get_by_role("button", name="Load all values", exact=True).click()
    page.wait_for_function("window.__combinedSubmissionHeld === true")
    expect(
        panel.get_by_role("progressbar", name="Load all combined values progress")
    ).to_be_visible()
    panel.get_by_role("button", name=re.compile(r"Cancel · \d+%")).click()
    expect(panel.get_by_role("button", name="Load all values", exact=True)).to_be_visible()
    with page.expect_response(lambda response: response.url.endswith("/cancel")):
        submissions[0][0].fulfill(response=submissions[0][1])
    panel.get_by_role("button", name="Load all values", exact=True).click()
    expect(page.locator("#combined-full-control")).to_have_text(
        "All values loaded", timeout=120_000
    )
    with page.expect_response(lambda response: urlsplit(response.url).path == "/api/curves"):
        sampled[0][0].fulfill(response=sampled[0][1])
    page.unroute("**/api/curves", hold_sample)

    def assert_complete(axis_scale=1):
        names = page.locator("#combined-chart").evaluate(
            "plot => plot.data.map(trace => trace.name)"
        )
        assert set(names) == tags
        for index, name in enumerate(names):
            origin = page.locator("#combined-chart").evaluate(
                "(plot, index) => plot.data[index].x[0]", arg=index
            )
            positions = [
                origin + step * axis_scale
                for step in range(0, STRESS_POINTS, 2 if name == "stress/reward" else 1)
            ]
            assert_full_resolution(page, "#combined-chart", index, positions)
        expect(page.locator("#combined-status")).to_contain_text("all values loaded")

    assert_complete()
    requests = []
    page.on(
        "request",
        lambda request: (
            requests.append(request.url)
            if urlsplit(request.url).path in {"/api/curves", "/api/curves/all/jobs"}
            else None
        ),
    )
    for scale in ["standard", "raw", "minmax"]:
        page.locator("#combined-scale").select_option(scale)
        page.wait_for_function(
            "title => document.getElementById('combined-chart').layout.yaxis.title.text === title",
            arg={
                "standard": "Standard score · each metric's mean and SD",
                "raw": "Original units · shared axis",
                "minmax": "Each metric scaled to 0–1",
            }[scale],
        )
        assert_complete()
    change_number(page.locator("#combined-smoothing"), 0.8)
    page.wait_for_function("""() => {
      const plot = document.getElementById('combined-chart');
      return plot.data.every(trace => {
        const first = trace.customdata[0][1], second = trace.customdata[1][1];
        return Math.abs(trace.customdata[1][0] - (.8 * first + second) / 1.8) < 1e-8;
      });
    }""")
    assert_complete()
    page.get_by_role("button", name="Move curves", exact=True).click()
    x, y = combined_drag_point(page, "stress/loss", 5050)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y - 15, steps=5)
    page.mouse.up()
    page.wait_for_function(
        "document.getElementById('combined-chart').data.some(trace => trace.meta.offset > 0)"
    )
    assert_complete()
    page.get_by_role("button", name="Reset offsets", exact=True).click()
    page.wait_for_function(
        "document.getElementById('combined-chart').data.every(trace => trace.meta.offset === 0)"
    )
    page.get_by_role("button", name="Move curves", exact=True).click()
    assert_complete()
    assert not requests, "Full-value scaling and smoothing must reuse the complete observations"
    page.locator("#x-axis").select_option("relative")
    page.wait_for_function("""() => {
      const plot = document.getElementById('combined-chart');
      return plot && plot.layout && plot.layout.xaxis.title.text === 'Elapsed seconds';
    }""")
    assert_complete(axis_scale=10)
    assert not any(url.endswith("/api/curves/all/jobs") for url in requests)
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    page.locator('#navigation [data-action="tab"][data-value="overview"]').click()
    expect(page.locator("#combined-full-control")).to_have_text("All values loaded", timeout=60_000)
    assert_complete(axis_scale=10)
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view.get("combinedPlot", {}).get("smoothing") == 0.8
        )
    ):
        page.locator("#combined-scale").select_option("raw")
    page.reload()
    wait_for_overview(page)
    wait_for_plot(page, "#combined-chart")
    expect(page.locator("#combined-full-control")).to_have_text("Load all values")
    assert page.locator("#combined-chart").evaluate("plot => plot.data[0].x.length") < STRESS_POINTS


@pytest.mark.ui_scenario("combined-indexing")
def test_restored_combined_plot_recovers_when_indexed_observations_arrive(
    ui_page, ui_server, tmp_path, request
):
    page = ui_page
    expect(page.locator("#combined-status")).to_contain_text("indexing")
    app = request.node.expman_ui_app
    identifier = app.state.store.read()["view"]["combinedPlot"]["experiment"]
    writer = EventFileWriter(str(tmp_path / "logs" / "exp000"))
    try:
        for step in range(21):
            writer.add_event(
                event_pb2.Event(
                    step=step,
                    wall_time=1_790_000_000 + step,
                    summary=summary_pb2.Summary(
                        value=[
                            summary_pb2.Summary.Value(tag="train/loss", simple_value=step),
                            summary_pb2.Summary.Value(tag="eval/reward", simple_value=100 - step),
                        ]
                    ),
                )
            )
    finally:
        writer.close()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = page.request.post(
            ui_server + "/api/curves",
            data={
                "experiment_ids": [identifier],
                "tags": ["train/loss"],
                "source": "tensorboard",
                "client_smoothing": True,
            },
        )
        if response.json()["curves"]["train/loss"]:
            break
        page.wait_for_timeout(100)
    else:
        pytest.fail("The native reader did not index the new events")
    app.state.ui_metadata_gate.set()
    wait_for_overview(page)
    page.wait_for_function("""() => {
      const plot = document.getElementById('combined-chart');
      return plot && plot._fullData && plot._fullData.length === 2;
    }""")
    expect(page.locator("#combined-status")).not_to_contain_text("No observations")
    assert page.locator("#combined-chart").evaluate(
        "plot => plot.data.map(trace => trace.x.length)"
    ) == [21, 21]
    page.reload()
    wait_for_overview(page)
    page.wait_for_function("""() => {
      const plot = document.getElementById('combined-chart');
      return plot && plot._fullData && plot._fullData.length === 2;
    }""")
    assert page.locator("#combined-chart").evaluate(
        "plot => plot.data.map(trace => trace.x.length)"
    ) == [21, 21]


def test_combined_metrics_scaling_smoothing_and_persistence(ui_page):
    page = ui_page
    requests = []
    page.on(
        "request",
        lambda request: (
            requests.append(request.post_data_json)
            if urlsplit(request.url).path == "/api/curves"
            else None
        ),
    )
    page.get_by_role("button", name="Combine metrics", exact=True).click()
    dialog = page.locator("#dialog")
    tags = ["train/loss", "eval/reward", "train/learning_rate"]
    for checkbox in dialog.locator('input[name="choices"]').all():
        checkbox.set_checked(checkbox.get_attribute("value") in tags)
    experiment = dialog.locator('[name="combined_experiment"]').input_value()
    dialog.get_by_role("button", name="Show plot", exact=True).click()
    wait_for_plot(page, "#combined-chart")

    def traces():
        return page.locator("#combined-chart").evaluate(
            """plot => plot.data.map(trace => ({
              name: trace.name, x: Array.from(trace.x), y: Array.from(trace.y),
              smoothed: trace.customdata.map(value => value[0]),
              original: trace.customdata.map(value => value[1]), hover: trace.hovertemplate
            }))"""
        )

    first = traces()
    assert {trace["name"] for trace in first} == set(tags)
    for trace in first:
        assert trace["x"] == list(range(400))
        assert (
            "Smoothed" in trace["hover"]
            and "Original" in trace["hover"]
            and "Elapsed" in trace["hover"]
        )
        if trace["name"] == "train/learning_rate":
            assert set(trace["y"]) == {0.5}
        else:
            assert min(trace["y"]) == 0 and max(trace["y"]) == 1
    assert any(
        request["experiment_ids"] == [experiment] and set(request["tags"]) == set(tags)
        for request in requests
    )
    count = len(requests)
    page.locator("#combined-scale").select_option("standard")
    for trace in traces():
        assert statistics.fmean(trace["y"]) == pytest.approx(0, abs=1e-10)
        if trace["name"] != "train/learning_rate":
            assert statistics.pstdev(trace["y"]) == pytest.approx(1)
    page.locator("#combined-scale").select_option("raw")
    for trace in traces():
        assert trace["y"] == trace["smoothed"]
    type_smoothing(page.locator("#combined-smoothing"), "0.9")
    page.locator("#combined-smoothing").press("Tab")
    for trace in traces():
        assert trace["smoothed"][1] == pytest.approx(
            (0.9 * trace["original"][0] + trace["original"][1]) / 1.9
        )
    assert len(requests) == count, "Scaling and smoothing must reuse loaded observations"
    graph = page.locator("#combined-chart")
    graph.locator(".legend .traces").filter(has_text="eval/reward").click()
    page.wait_for_function(
        "document.getElementById('combined-chart').data.find(trace => "
        "trace.meta.metric === 'eval/reward').visible === 'legendonly'"
    )
    combined_refresh = page.get_by_role("button", name="Refresh visible combined curves")
    with page.expect_response("**/api/curves") as partial:
        combined_refresh.click()
    assert set(partial.value.request.post_data_json["tags"]) == set(tags) - {"eval/reward"}
    assert partial.value.request.post_data_json["experiment_ids"] == [experiment]
    expect(combined_refresh).to_be_enabled()
    assert (
        graph.evaluate(
            "plot => plot.data.find(trace => trace.meta.metric === 'eval/reward').visible"
        )
        == "legendonly"
    )
    change_number(page.locator("#smoothing-value"), 0.2)
    page.get_by_role("button", name="Apply to all panels", exact=True).click()
    expect(page.locator("#combined-smoothing")).to_have_value("0.2")
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view.get("combinedPlot", {}).get("scale") == "standard"
        )
    ):
        page.locator("#combined-scale").select_option("standard")
    legend = page.locator(
        f'#overview-legend [data-action="toggle-overview-curve"][data-value="{experiment}"]'
    )
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: experiment in view["hiddenOverviewCurves"]
        )
    ):
        legend.click()
    expect(graph).not_to_be_visible()
    requests.clear()
    page.reload()
    wait_for_overview(page)
    expect(page.locator("#combined-status")).to_contain_text("Show this experiment")
    assert requests and all(experiment not in request["experiment_ids"] for request in requests)
    legend.click()
    wait_for_plot(page, "#combined-chart")
    expect(page.locator("#combined-scale")).to_have_value("standard")
    expect(page.locator("#combined-smoothing")).to_have_value("0.2")
    assert {trace["name"] for trace in traces()} == set(tags)
    page.set_viewport_size({"width": 375, "height": 1000})
    page.wait_for_function(
        "document.getElementById('combined-chart')._fullLayout.width "
        "<= document.getElementById('combined-chart').clientWidth + 1"
    )
    assert page.locator(".combined-controls").evaluate(
        "element => element.scrollWidth <= element.clientWidth"
    )
    page.set_viewport_size({"width": 1600, "height": 1100})
    page.get_by_role("button", name="Edit metrics", exact=True).click()
    dialog.locator('[name="combined_experiment"]').select_option(index=1)
    dialog.get_by_role("button", name="Show plot", exact=True).click()
    wait_for_plot(page, "#combined-chart")
    assert traces()[0]["original"] != first[0]["original"]
    with page.expect_response(
        lambda response: saved_view(response, lambda view: view.get("combinedPlot") is None)
    ):
        page.get_by_role("button", name="Remove combined metrics plot", exact=True).click()
    expect(page.locator("#combined-chart")).to_have_count(0)


def test_combined_fit_y_and_vertical_curve_movement(ui_page):
    page = ui_page
    page.get_by_role("button", name="Combine metrics", exact=True).click()
    page.locator("#dialog").get_by_role("button", name="Show plot", exact=True).click()
    wait_for_plot(page, "#combined-chart")
    graph = page.locator("#combined-chart")

    def traces():
        return graph.evaluate(
            """plot => plot.data.map(trace => ({tag: trace.meta.metric,
              offset: trace.meta.offset, y: Array.from(trace.y),
              custom: trace.customdata, visible: trace.visible}))"""
        )

    def fit_and_check():
        before = graph.evaluate("plot => plot._fullLayout.xaxis.range.slice()")
        page.get_by_role("button", name="Fit Y to view", exact=True).click()
        expect(page.locator("#combined-fit-y")).to_have_text("Fit Y to view")
        expect(page.locator("#combined-fit-y")).to_be_enabled()
        page.wait_for_function(
            "document.getElementById('combined-chart').layout.yaxis.title.text"
            ".startsWith('Each metric scaled')"
        )
        visible = graph.evaluate("""plot => {
          const axis = plot._fullLayout.xaxis, low = axis.r2l(axis.range[0]);
          const high = axis.r2l(axis.range[1]);
          return plot.data.filter(trace =>
            trace.visible !== false && trace.visible !== 'legendonly')
            .flatMap(trace => trace.y.filter((value, index) => {
              const position = axis.d2l(trace.x[index]);
              return position >= low && position <= high;
            }));
        }""")
        ranges = graph.evaluate("""plot => {
          const axis = plot._fullLayout.xaxis, bounds = axis.range.map(value => axis.r2l(value));
          return plot.data.filter(trace =>
            trace.visible !== false && trace.visible !== 'legendonly')
            .map(trace => ({offset: trace.meta.offset, values: trace.y.filter((value, index) => {
              const position = axis.d2l(trace.x[index]);
              return position >= bounds[0] && position <= bounds[1];
            })}));
        }""")
        for item in ranges:
            assert min(item["values"]) - item["offset"] == pytest.approx(0, abs=1e-10)
            assert max(item["values"]) - item["offset"] == pytest.approx(1, abs=1e-10)
        after = graph.evaluate(
            "plot => ({x: plot._fullLayout.xaxis.range, y: plot._fullLayout.yaxis.range})"
        )
        assert after["x"] == before
        span = max(visible) - min(visible)
        assert after["y"] == pytest.approx([min(visible) - 0.05 * span, max(visible) + 0.05 * span])

    page.locator("#combined-scale").select_option("raw")
    graph.locator(".legend .traces").filter(has_text="eval/reward").click()
    page.wait_for_function(
        "document.getElementById('combined-chart').data"
        ".find(trace => trace.meta.metric === 'eval/reward').visible === 'legendonly'"
    )
    graph.evaluate(
        """plot => Plotly.relayout(plot, {'xaxis.range': [200, 260],
          'xaxis.autorange': false, 'yaxis.range': [-5, 5], 'yaxis.autorange': false})"""
    )
    requests = []
    page.on(
        "request",
        lambda request: (
            requests.append(request.url)
            if urlsplit(request.url).path in {"/api/curves", "/api/curves/all/jobs"}
            else None
        ),
    )
    fit_and_check()
    before = traces()
    window = graph.evaluate("plot => plot._fullLayout.xaxis.range.slice()")
    page.get_by_role("button", name="Move curves", exact=True).click()
    expect(page.locator("#combined-drag-toggle")).to_have_attribute("aria-pressed", "true")
    x, y = combined_drag_point(page, "train/loss", 230)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 15, y - 24, steps=6)
    with page.expect_response(
        lambda response: saved_view(
            response,
            lambda view: (
                view.get("combinedPlot", {})
                .get("offsets", {})
                .get("minmax", {})
                .get("train/loss", 0)
                > 0
            ),
        )
    ):
        page.mouse.up()
    after = traces()
    shifted = next(trace for trace in after if trace["tag"] == "train/loss")
    original = next(trace for trace in before if trace["tag"] == "train/loss")
    assert shifted["offset"] > 0
    assert shifted["y"] == pytest.approx([value + shifted["offset"] for value in original["y"]])
    assert shifted["custom"] == original["custom"]
    assert next(trace for trace in before if trace["tag"] == "eval/reward") == next(
        trace for trace in after if trace["tag"] == "eval/reward"
    )
    assert graph.evaluate("plot => plot._fullLayout.xaxis.range") == window
    x, y = combined_drag_point(page, "train/loss", 230)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x, y + 15, steps=4)
    page.keyboard.press("Escape")
    page.mouse.up()
    assert traces() == after
    page.get_by_role("button", name="Move curves", exact=True).click()
    fit_and_check()
    assert not requests, "Fitting and shifting must not reload observations"
    page.reload()
    wait_for_overview(page)
    wait_for_plot(page, "#combined-chart")
    assert (
        next(trace for trace in traces() if trace["tag"] == "train/loss")["offset"]
        == shifted["offset"]
    )
    page.get_by_role("button", name="Reset offsets", exact=True).click()
    page.wait_for_function(
        "document.getElementById('combined-chart').data.every(trace => trace.meta.offset === 0)"
    )
    expect(page.get_by_role("button", name="Reset offsets", exact=True)).to_be_disabled()
    for axis in ["relative", "wall"]:
        page.locator("#x-axis").select_option(axis)
        title = "Elapsed seconds" if axis == "relative" else "Wall time"
        page.wait_for_function(
            "title => document.getElementById('combined-chart').layout.xaxis.title.text === title",
            arg=title,
        )
        graph.evaluate("""plot => {
          const trace = plot.data.find(item => item.meta.metric === 'train/loss');
          return Plotly.relayout(plot, {'xaxis.range': [trace.x[200], trace.x[260]],
            'xaxis.autorange': false, 'yaxis.range': [-5, 5], 'yaxis.autorange': false});
        }""")
        fit_and_check()


@pytest.mark.ui_scenario("refresh")
def test_background_refresh_preserves_charts_and_only_announces_new_warnings(ui_page, tmp_path):
    page = ui_page
    page.add_init_script("""(() => {
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 30000) window.__expmanRefreshTick = callback;
        return interval(callback, delay, ...args);
      };
    })();""")
    page.reload()
    wait_for_overview(page)
    page.wait_for_function("typeof window.__expmanRefreshTick === 'function'")
    page.get_by_role("button", name="Load all values", exact=True).first.click()
    full_values = page.locator('[data-full-panel="train/loss"]')
    expect(full_values).to_have_text("All values loaded", timeout=60_000)
    page.locator("#curve-0").evaluate("""plot => {
      window.__retainedChart = plot;
      window.__retainedData = plot.data;
      return Plotly.relayout(plot, {'xaxis.range': [100, 160], 'xaxis.autorange': false});
    }""")
    calls = []
    page.on(
        "request",
        lambda request: (
            calls.append(request.url)
            if urlsplit(request.url).path in {"/api/metrics/jobs", "/api/curves"}
            else None
        ),
    )

    def refresh_after_interval():
        with page.expect_response("**/api/refresh") as response:
            page.evaluate("window.__expmanRefreshTick()")
        assert response.value.ok

    refresh_after_interval()
    toast = page.locator("#toast")
    expect(toast).to_contain_text("9 discovery warnings")
    expect(toast).to_contain_text("How this workspace works ↗")
    expect(toast).to_contain_text("at the bottom of the left sidebar")
    expect(toast).not_to_be_visible(timeout=10_000)
    refresh_after_interval()
    expect(toast).not_to_be_visible()
    expect(full_values).to_have_text("All values loaded")
    assert page.locator("#curve-0").evaluate("""plot =>
      plot === window.__retainedChart && plot.data === window.__retainedData &&
      plot.layout.xaxis.range[0] === 100 && plot.layout.xaxis.range[1] === 160
    """)
    assert not calls
    writer = EventFileWriter(str(tmp_path / "logs" / "exp000"))
    writer.add_event(
        event_pb2.Event(
            step=400,
            wall_time=1_790_004_000,
            summary=summary_pb2.Summary(
                value=[summary_pb2.Summary.Value(tag="train/loss", simple_value=0.1)]
            ),
        )
    )
    writer.close()
    refresh_after_interval()
    expect(full_values).to_have_text("All values loaded")
    assert page.locator("#curve-0").evaluate("plot => plot === window.__retainedChart")
    assert not calls
    (tmp_path / "logs" / "broken-9").symlink_to(tmp_path / "missing-9")
    refresh_after_interval()
    expect(toast).to_contain_text("10 discovery warnings")
    assert not calls
    page.locator('[data-action="help"]').click()
    dialog = page.locator("#dialog")
    expect(dialog.get_by_role("heading", name="Discovery warnings", exact=True)).to_be_visible()
    expect(dialog.locator(".notice.warning")).to_have_count(10)
    source = tmp_path / "new"
    generate_demo(source, count=1)
    (source / "exp000").rename(tmp_path / "logs" / "exp004")
    page.evaluate("window.__expmanRefreshTick()")
    expect(dialog).to_be_visible()
    expect(page.locator("#selected-count")).to_have_text("4")
    dialog.get_by_role("button", name="Close", exact=True).click()
    refresh_after_interval()
    expect(page.locator("#selected-count")).to_have_text("5", timeout=60_000)
    wait_for_overview(page)
    assert calls
    expect(toast).not_to_be_visible()
    calls.clear()
    with page.expect_response("**/api/settings") as response:
        page.locator("#auto-refresh").check()
    assert response.value.ok
    writer = EventFileWriter(str(tmp_path / "logs" / "exp000"))
    writer.add_event(
        event_pb2.Event(
            step=401,
            wall_time=1_790_004_010,
            summary=summary_pb2.Summary(
                value=[summary_pb2.Summary.Value(tag="train/loss", simple_value=0.09)]
            ),
        )
    )
    writer.close()
    refresh_after_interval()
    wait_for_overview(page)
    assert calls


@pytest.mark.ui_scenario("json-refresh")
def test_json_summary_refresh_recovers_preserved_timestamp_updates(ui_page, tmp_path):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    table = page.locator("#config-table")
    cell = table.locator("tbody tr").first.locator(
        'td[data-config-field="scalar:evaluation-score"]'
    )
    expect(cell).to_have_text("0.95")
    path = tmp_path / "logs" / "exp000" / "evaluation_metrics.json"
    before = path.stat()

    def replace_contents(document):
        previous = path.stat()
        path.write_text(document)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        after = path.stat()
        assert (after.st_ino, after.st_size, after.st_mtime_ns) == (
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        )
        assert after.st_ctime_ns != previous.st_ctime_ns

    def refresh():
        with page.expect_response("**/api/refresh") as response:
            page.locator('[data-action="refresh"]').click()
        assert response.value.ok

    replace_contents('x"metrics": {"score": 0.95}}')
    refresh()
    expect(cell).to_have_text("")
    status = page.request.get(page.url + "api/json-metrics").json()
    assert any("exp000/evaluation_metrics.json" in error for error in status["errors"])
    replace_contents('{"metrics": {"score": 0.85}}')
    refresh()
    expect(cell).to_have_text("0.85")
    assert not page.request.get(page.url + "api/json-metrics").json()["errors"]
    enable_fast_auto_refresh(page)
    replace_contents('{"metrics": {"score": 0.75}}')
    expect(cell).to_have_text("0.75")
    revision = page.request.get(page.url + "api/workspace").json()["revision"]
    with page.expect_response("**/api/refresh") as response:
        pass
    assert response.value.ok
    assert response.value.json()["revision"] == revision
    expect(cell).to_have_text("0.75")


def test_named_views_explicit_updates_and_following_new_experiments(ui_page, tmp_path):
    page = ui_page
    help_button = page.get_by_role("button", name="About named views", exact=True)
    tooltip = page.locator("#named-view-help")
    for show in [help_button.hover, help_button.focus, help_button.click]:
        show()
        expect(tooltip).to_be_visible()
        for text in ["working copy", "Update view", "Revert", "Follow filters", "30 seconds"]:
            expect(tooltip).to_contain_text(text)
        page.keyboard.press("Escape")
        expect(tooltip).not_to_be_visible()
    page.locator("#page-title").click()
    page.get_by_role("button", name="Save as new view", exact=True).click()
    dialog = page.locator("#dialog")
    dialog.get_by_label("View name", exact=True).fill("Baseline")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    baseline = page.locator("#named-view-choice").input_value()
    change_number(page.locator("#smoothing-value"), 0.9)
    expect(page.locator("#named-view-status")).to_have_text("Modified")
    stored = page.request.get(page.url.rstrip("/") + "/api/named-views").json()
    assert stored[0]["view"]["options"]["smoothing"] == 0.4
    page.get_by_role("button", name="Revert", exact=True).click()
    wait_for_overview(page)
    expect(page.locator("#smoothing-value")).to_have_value("0.4")
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.locator("#selection-mode").select_option("filters")
    page.get_by_role("button", name="Save as new view", exact=True).click()
    dialog.get_by_label("View name", exact=True).fill("Following")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    following = page.locator("#named-view-choice").input_value()
    source = tmp_path / "new"
    generate_demo(source, count=1)
    (source / "exp000").rename(tmp_path / "logs" / "exp004")
    page.clock.install()
    page.clock.fast_forward(30_100)
    expect(page.locator("#selected-count")).to_have_text("5", timeout=60_000)
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    expect(page.locator("#config-table")).to_be_visible()
    page.locator("#diff-only").uncheck()
    page.locator("#show-ignored").check()
    page.get_by_role("button", name="Update view", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.locator("#named-view-choice").select_option(baseline)
    wait_for_overview(page)
    expect(page.locator("#selection-mode")).to_have_value("manual")
    expect(page.locator("#selected-count")).to_have_text("4")
    page.locator("#named-view-choice").select_option(following)
    expect(page.locator("#config-table")).to_be_visible()
    expect(page.locator("#diff-only")).not_to_be_checked()
    expect(page.locator("#show-ignored")).to_be_checked()
    expect(page.locator("#selected-count")).to_have_text("5")
    page.get_by_role("button", name="Rename view", exact=True).click()
    dialog.get_by_label("View name", exact=True).fill("Live comparisons")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-choice option:checked")).to_have_text("Live comparisons")
    page.get_by_role("button", name="Delete view", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Working copy")
    expect(page.locator("#selected-count")).to_have_text("5")


def test_experiment_filters_apply_live_and_disclose_selection_outside_filters(ui_page):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    rows = page.locator(".experiment-table tbody tr")
    notice = page.locator("#outside-filter-selection")
    dialog = page.locator("#dialog")
    expect(rows).to_have_count(4)
    expect(page.get_by_role("button", name="Apply view", exact=True)).to_have_count(0)
    page.get_by_role("button", name="+ New named filter", exact=True).click()
    dialog.locator('[name="filter_name"]').fill("One experiment")
    dialog.get_by_label("Filter target", exact=True).select_option("path")
    dialog.get_by_label("Comparison operator", exact=True).select_option("contains")
    dialog.get_by_label("Comparison value", exact=True).fill("exp000")
    expect(rows).to_have_count(1)
    expect(notice).to_have_text(
        "3 additional experiments are selected outside the current filters (4 selected in total)."
    )
    dialog.get_by_role("button", name="Save filter", exact=True).click()
    expect(dialog).not_to_be_visible()
    identifier = page.locator("#named-filter-choice").input_value()
    assert identifier
    page.get_by_role("button", name="Clear all filters", exact=True).click()
    expect(rows).to_have_count(4)
    expect(notice).not_to_be_visible()
    page.locator("#named-filter-choice").select_option(identifier)
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text("exp000")
    expect(page.locator("#selected-count")).to_have_text("4")
    page.locator("#edit-named-filter").click()
    expect(page.locator("#named-filter-choice")).to_have_value(identifier)
    value = dialog.get_by_label("Comparison value", exact=True)
    value.fill("exp001")
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text("exp001")
    expect(page.locator("#named-filter-choice")).to_have_value("")
    value.fill("exp000")
    expect(page.locator("#named-filter-choice")).to_have_value(identifier)
    value.fill("exp00")
    expect(rows).to_have_count(4)
    expect(notice).not_to_be_visible()
    dialog.get_by_role("button", name="+ Add condition", exact=True).click()
    second = dialog.locator(".filter-rule").nth(1)
    second.get_by_label("Configuration path", exact=True).fill("model.architecture")
    second.get_by_label("Comparison value", exact=True).fill("transformer")
    expect(rows).to_have_count(3)
    expect(notice).to_contain_text("1 additional experiment is selected")
    second.get_by_label("Comparison value", exact=True).fill("moe")
    expect(rows).to_have_count(1)
    second.get_by_role("button", name="Remove condition", exact=True).click()
    expect(rows).to_have_count(4)
    dialog.get_by_label("Comparison operator", exact=True).select_option("not_contains")
    value.fill("exp000")
    expect(rows).to_have_count(3)
    dialog.get_by_role("button", name="Remove condition", exact=True).click()
    expect(rows).to_have_count(4)
    dialog.get_by_role("button", name="Cancel", exact=True).click()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text("exp000")
    expect(page.locator("#named-filter-choice")).to_have_value(identifier)
    page.locator("#edit-named-filter").click()
    dialog.get_by_label("Comparison value", exact=True).fill("exp003")
    dialog.get_by_role("button", name="Save filter", exact=True).click()
    expect(dialog).not_to_be_visible()
    saved = page.request.get(page.url.rstrip("/") + "/api/filters").json()
    assert saved[0]["filters"][0]["value"] == "exp003"
    page.get_by_role("button", name="Clear all filters", exact=True).click()
    page.locator("#named-filter-choice").select_option(identifier)
    expect(rows).to_contain_text("exp003")
    page.locator("#selection-mode").select_option("filters")
    expect(page.locator("#selected-count")).to_have_text("1")
    expect(notice).not_to_be_visible()
    page.locator("#edit-named-filter").click()
    dialog.get_by_label("Comparison value", exact=True).fill("exp00")
    expect(page.locator("#selected-count")).to_have_text("4")
    dialog.get_by_role("button", name="Cancel", exact=True).click()
    expect(page.locator("#selected-count")).to_have_text("1")
    expect(rows).to_have_count(1)
    page.locator("#selection-mode").select_option("manual")
    page.get_by_role("button", name="Clear all filters", exact=True).click()
    page.locator('[data-action="filters"]').click()
    dialog.get_by_label("Filter target", exact=True).select_option("path")
    dialog.get_by_label("Comparison operator", exact=True).select_option("contains")
    dialog.get_by_label("Comparison value", exact=True).fill("exp002")
    expect(rows).to_have_count(1)
    expect(notice).to_contain_text("1 additional experiment is selected")
    dialog.get_by_role("button", name="Done", exact=True).click()
    expect(dialog).not_to_be_visible()
    page.reload()
    expect(rows).to_have_count(1)
    expect(rows).to_contain_text("exp002")
    expect(page.locator("#selected-count")).to_have_text("1")
    page.locator('[data-action="filters"]').click()
    dialog.get_by_role("button", name="Remove condition", exact=True).click()
    expect(rows).to_have_count(4)
    dialog.get_by_role("button", name="Done", exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(rows).to_have_count(4)


def test_configuration_display_names_values_and_raw_semantics(ui_page, tmp_path):
    page = ui_page
    key = "model.architecture"
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    table = page.locator("#config-table")
    header = table.locator(f'th[data-config-key="config:{key}"]')
    cells = table.locator(f'td[data-config-field="config:{key}"]')
    expect(cells.first).to_have_text("transformer")
    expect(cells.last).to_have_text("moe")
    reads = []
    page.on(
        "request",
        lambda request: (
            reads.append(request.url)
            if urlsplit(request.url).path.startswith(
                ("/api/compare", "/api/metrics", "/api/curves")
            )
            else None
        ),
    )
    header.get_by_role("button", name=f"Customize text for {key}", exact=True).click()
    dialog = page.locator("#dialog")
    custom_name, custom_value = "Architecture <custom>", "Same <b>model</b>"
    dialog.get_by_label("Column name", exact=True).fill(custom_name)
    row = dialog.locator("[data-config-text-rule]").first
    row.get_by_label("Original value", exact=True).fill("transformer")
    row.get_by_label("Display text", exact=True).fill(custom_value)
    dialog.get_by_role("button", name="+ Add value mapping", exact=True).click()
    row = dialog.locator("[data-config-text-rule]").last
    row.get_by_label("Original value", exact=True).fill("moe")
    row.get_by_label("Display text", exact=True).fill(custom_value)
    with page.expect_response(
        lambda response: saved_view(
            response,
            lambda view: view.get("configDisplay", {}).get(key, {}).get("name") == custom_name,
        )
    ):
        dialog.get_by_role("button", name="Save", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text(custom_name)
    expect(header.locator(".config-path-text")).to_have_attribute("title", key)
    expect(cells).to_have_text([custom_value] * 4)
    expect(cells.first).to_have_attribute("title", "string: transformer")
    expect(cells.last).to_have_attribute("title", "string: moe")
    expect(cells.last).to_have_class(re.compile(r"\bchanged\b"))
    expect(cells.locator("b")).to_have_count(0)
    page.locator("#config-full-names").check()
    expect(header.locator(".config-path-text")).to_have_text(custom_name)
    search = page.locator("#config-search")
    search.fill(custom_name)
    expect(table.locator("th[data-config-key]")).to_have_count(1)
    with page.expect_download() as download:
        page.get_by_role("button", name="Export CSV ↓", exact=True).click()
    path = tmp_path / "config-display.csv"
    download.value.save_as(path)
    with path.open(newline="") as stream:
        records = list(csv.reader(stream))
    assert records[0] == ["Experiment", key]
    assert [record[1] for record in records[1:]] == ["transformer"] * 3 + ["moe"]
    assert not reads, "Display edits and label searches must reuse cached configuration data"
    search.fill("")
    page.get_by_role("button", name="Save as new view", exact=True).click()
    dialog.get_by_label("View name", exact=True).fill("Display aliases")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.reload()
    expect(header.locator(".config-path-text")).to_have_text(custom_name)
    expect(cells).to_have_text([custom_value] * 4)
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    header.get_by_role("button", name=f"Customize text for {key}", exact=True).click()
    dialog.get_by_label("Column name", exact=True).fill("Draft name")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text("Draft name")
    expect(page.locator("#named-view-status")).to_have_text("Modified")
    page.get_by_role("button", name="Revert", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text(custom_name)
    header.get_by_role("button", name=f"Customize text for {key}", exact=True).click()
    dialog.get_by_label("Column name", exact=True).fill("Saved architecture")
    dialog.get_by_role("button", name="Save", exact=True).click()
    page.get_by_role("button", name="Update view", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.reload()
    expect(header.locator(".config-path-text")).to_have_text("Saved architecture")
    header.get_by_role("button", name=f"Customize text for {key}", exact=True).click()
    dialog.get_by_role("button", name="Reset this field", exact=True).click()
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text(key)
    expect(cells.first).to_have_text("transformer")
    expect(cells.last).to_have_text("moe")
    page.get_by_role("button", name="Revert", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text("Saved architecture")
    expect(cells.first).to_have_text(custom_value)


@pytest.mark.ui_scenario("config-display")
def test_configuration_text_editor_drafts_types_and_validation(ui_page):
    page = ui_page
    key = "display.value"
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    table = page.locator("#config-table")
    header = table.locator(f'th[data-config-key="config:{key}"]')
    cells = table.locator(f'td[data-config-field="config:{key}"]')
    scalar = table.locator('td[data-config-field="scalar:evaluation-score"]')
    expect(cells).to_have_text(["1", "1", "null", ""])
    expect(scalar.first).to_have_text("0.95")
    header.get_by_role("button", name=f"Customize text for {key}", exact=True).click()
    dialog = page.locator("#dialog")

    def fill_typed_mappings():
        dialog.get_by_label("Column name", exact=True).fill("Typed values")
        rows = dialog.locator("[data-config-text-rule]")
        rows.first.get_by_label("Original value", exact=True).fill("1")
        rows.first.get_by_label("Display text", exact=True).fill("Numeric")
        dialog.get_by_role("button", name="+ Add value mapping", exact=True).click()
        rows.last.get_by_label("Original value", exact=True).fill("1")
        rows.last.get_by_label("Display text", exact=True).fill("String")
        return rows

    rows = fill_typed_mappings()
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(dialog).to_be_visible()
    expect(dialog.locator("#config-display-error")).to_contain_text("only one display mapping")
    rows.last.get_by_label("Original value", exact=True).fill('"1"')
    dialog.get_by_role("button", name="+ Add value mapping", exact=True).click()
    rows.last.get_by_label("Original value", exact=True).fill("null")
    dialog.locator("#config-display-key").select_option("model.architecture")
    dialog.get_by_label("Column name", exact=True).fill("Model")
    dialog.locator("[data-config-text-rule]").first.get_by_label("Original value", exact=True).fill(
        "transformer"
    )
    dialog.locator("[data-config-text-rule]").first.get_by_label("Display text", exact=True).fill(
        "T"
    )
    dialog.locator("#config-display-key").select_option(key)
    expect(dialog.get_by_label("Column name", exact=True)).to_have_value("Typed values")
    expect(rows).to_have_count(3)
    expect(rows.nth(1).get_by_label("Original value", exact=True)).to_have_value('"1"')
    dialog.get_by_role("button", name="Cancel", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text("value")
    expect(cells).to_have_text(["1", "1", "null", ""])
    page.get_by_role("button", name="Customize text", exact=True).click()
    dialog.locator("#config-display-key").select_option(key)
    expect(dialog.get_by_label("Column name", exact=True)).to_have_value("")
    expect(dialog.locator("[data-config-text-rule]")).to_have_count(1)
    rows = fill_typed_mappings()
    rows.last.get_by_label("Original value", exact=True).fill('"1"')
    dialog.get_by_role("button", name="+ Add value mapping", exact=True).click()
    rows.last.get_by_label("Original value", exact=True).fill("null")
    dialog.get_by_role("button", name="+ Add value mapping", exact=True).click()
    rows.last.get_by_role("button", name="Remove value mapping", exact=True).click()
    dialog.locator("#config-display-key").select_option("model.architecture")
    dialog.get_by_label("Column name", exact=True).fill("Model")
    dialog.locator("[data-config-text-rule]").first.get_by_label("Original value", exact=True).fill(
        "transformer"
    )
    dialog.locator("[data-config-text-rule]").first.get_by_label("Display text", exact=True).fill(
        "T"
    )
    with page.expect_response(
        lambda response: saved_view(
            response,
            lambda view: len(view.get("configDisplay", {}).get(key, {}).get("values", [])) == 3,
        )
    ):
        dialog.get_by_role("button", name="Save", exact=True).click()
    expect(header.locator(".config-path-text")).to_have_text("Typed values")
    expect(cells).to_have_text(["Numeric", "String", "", ""])
    expect(cells.nth(2)).to_have_attribute("title", "object: null")
    expect(cells.last).to_have_attribute("title", "Not set")
    expect(cells.last).to_have_class(re.compile(r"\bchanged\b"))
    expect(scalar.first).to_have_text("0.95")
    expect(table.locator('th[data-config-key="config:model.architecture"] code')).to_have_text(
        "Model"
    )
    expect(table.locator('td[data-config-field="config:model.architecture"]').first).to_have_text(
        "T"
    )
    page.reload()
    expect(cells).to_have_text(["Numeric", "String", "", ""])
    expect(scalar.first).to_have_text("0.95")


def test_configuration_baseline_preserves_order_and_highlights(ui_page, tmp_path):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    order = page.locator(".experiment-table input[data-select-run]").evaluate_all(
        "inputs => inputs.map(input => input.dataset.selectRun)"
    )
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    table = page.locator("#config-table")
    expect(table).to_be_visible()

    def row_order():
        return table.locator("tbody tr[data-experiment-id]").evaluate_all(
            "rows => rows.map(row => row.dataset.experimentId)"
        )

    page.locator("#baseline").select_option(order[-1])
    baseline = table.locator(f'tr[data-experiment-id="{order[-1]}"]')
    expect(baseline.locator("th .tag")).to_have_text("BASELINE")
    assert row_order() == order
    for identifier in order:
        cell = table.locator(f'tr[data-experiment-id="{identifier}"]').locator(
            'td[data-config-field="config:model.architecture"]'
        )
        if identifier == order[-1]:
            expect(cell).not_to_have_class(re.compile(r"\bchanged\b"))
        else:
            expect(cell).to_have_class(re.compile(r"\bchanged\b"))
    with page.expect_response(
        lambda response: saved_view(response, lambda view: view.get("baseline") == order[2])
    ):
        page.locator("#baseline").select_option(order[2])
    expect(table.locator(f'tr[data-experiment-id="{order[2]}"] th .tag')).to_have_text("BASELINE")
    assert row_order() == order
    expect(
        table.locator(
            f'tr[data-experiment-id="{order[0]}"] td[data-config-field="config:model.architecture"]'
        )
    ).not_to_have_class(re.compile(r"\bchanged\b"))
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    page.locator("#run-sort").select_option("updated")
    sorted_order = page.locator(".experiment-table input[data-select-run]").evaluate_all(
        "inputs => inputs.map(input => input.dataset.selectRun)"
    )
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view.get("tab") == "configs" and view.get("sort") == "updated"
        )
    ):
        page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    expect(table).to_be_visible()
    assert row_order() == sorted_order
    expect(table.locator(f'tr[data-experiment-id="{order[2]}"] th .tag')).to_have_text("BASELINE")
    with page.expect_download() as downloaded:
        page.get_by_role("button", name="Export CSV ↓", exact=True).click()
    path = tmp_path / "comparison.csv"
    downloaded.value.save_as(path)
    with path.open(newline="") as stream:
        records = list(csv.reader(stream))
    names = {
        run["id"]: run["name"]
        for run in page.request.get(page.url.rstrip("/") + "/api/experiments").json()["experiments"]
    }
    assert [record[0] for record in records[1:]] == [
        names[identifier] for identifier in sorted_order
    ]
    page.reload()
    expect(table).to_be_visible()
    assert row_order() == sorted_order
    expect(table.locator(f'tr[data-experiment-id="{order[2]}"] th .tag')).to_have_text("BASELINE")


@pytest.mark.ui_scenario("config-search")
def test_enter_includes_configuration_path_and_persists_in_named_view(ui_page):
    page = ui_page
    key = "env.config.terrain.generator.seed"
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    experiment_search = page.locator("#run-search")
    placeholder = experiment_search.get_attribute("placeholder")
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    expect(page.locator("#config-table")).to_be_visible()
    expect(experiment_search).to_have_attribute("placeholder", placeholder)
    inclusion_requests = []
    page.on(
        "request",
        lambda request: (
            inclusion_requests.append(request.url)
            if urlsplit(request.url).path == "/api/ignored-configs" and request.method == "PUT"
            else None
        ),
    )
    experiment_search.press("Enter")
    expect(page.locator("#config-search")).to_have_value("")
    assert not inclusion_requests
    workspace = page.request.get(page.url.rstrip("/") + "/api/workspace").json()
    assert key in workspace["state"]["ignored_configs"]
    selected = page.locator("#selected-count").inner_text()
    page.get_by_role("button", name="Save as new view", exact=True).click()
    dialog = page.locator("#dialog")
    dialog.get_by_label("View name", exact=True).fill("Seed comparison")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    header = page.locator('th[data-config-key="config:' + key + '"]')
    checkbox = header.locator("input[data-config-include]")
    pending = []

    def hold_comparison(route):
        pending.append((route, route.fetch()))

    page.locator("#config-search").fill(key)
    page.route("**/api/compare", hold_comparison)
    try:
        with (
            page.expect_response("**/api/ignored-configs") as result,
            page.expect_response(
                lambda response: saved_view(
                    response,
                    lambda view: (
                        view.get("configQuery") == key
                        and key not in view["configurationExclusions"]["patterns"]
                    ),
                )
            ),
        ):
            page.locator("#config-search").press("Enter")
        assert key not in result.value.json()["ignored_configs"]
        expect(header).to_have_count(1)
        expect(checkbox).to_be_checked()
        deadline = time.monotonic() + 10
        while not pending:
            assert time.monotonic() < deadline, "The inclusion comparison did not start"
            page.wait_for_timeout(20)
    finally:
        for route, response in pending:
            route.fulfill(response=response)
        page.unroute("**/api/compare", hold_comparison)
    expect(page.locator("#config-search")).to_have_value(key)
    expect(page.locator("#selected-count")).to_have_text(selected)
    expect(page.locator("#show-ignored")).not_to_be_checked()
    expect(page.locator("#named-view-status")).to_have_text("Modified")
    page.get_by_role("button", name="Update view", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    page.reload()
    expect(checkbox).to_be_checked()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    with page.expect_response("**/api/ignored-configs"):
        checkbox.uncheck()
    expect(header).to_have_count(0)
    expect(page.locator("#named-view-status")).to_have_text("Modified")
    page.get_by_role("button", name="Revert", exact=True).click()
    expect(checkbox).to_be_checked()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    with page.expect_response("**/api/ignored-configs"):
        checkbox.uncheck()
    expect(header).to_have_count(0)
    search = page.locator("#config-search")
    search.fill("  " + key + "  ")
    with page.expect_response("**/api/ignored-configs") as result:
        search.press("Enter")
    assert key not in result.value.json()["ignored_configs"]
    expect(checkbox).to_be_checked()
    expect(search).to_have_value(key)
    expect(page.locator("#selected-count")).to_have_text(selected)


@pytest.mark.ui_scenario("config-search")
def test_configuration_search_reveals_ignored_and_identical_fields_without_including_them(ui_page):
    page = ui_page
    key = "env.config.terrain.generator.seed"
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    table = page.locator("#config-table")
    expect(table).to_be_visible()
    selected = page.locator("#selected-count").inner_text()
    for _ in range(3):
        page.get_by_role("button", name="Next →", exact=True).click()
    expect(page.locator(".table-footer")).to_contain_text("Fields page 4")
    search = page.get_by_role("searchbox", name="Search configuration paths or scalar metrics")
    search.fill("  " + key + "  ")
    expect(page.locator(".table-footer")).to_contain_text("Fields page 1")
    expect(table.locator("th[data-config-key]")).to_have_count(0)
    expect(page.locator("#config-search-notice")).to_contain_text(
        "Search excludes ignored and identical configurations."
    )
    page.get_by_role("button", name="Search all fields", exact=True).click()
    column = table.locator('th[data-config-key="config:' + key + '"]')
    expect(column).to_have_count(1)
    expect(column.locator("input[data-config-include]")).not_to_be_checked()
    expect(page.locator("#show-ignored")).to_be_checked()
    expect(page.locator("#diff-only")).not_to_be_checked()
    expect(search).to_have_value("  " + key + "  ")
    expect(page.locator("#run-search")).to_have_value(key)
    expect(page.locator("#selected-count")).to_have_text(selected)
    expect(page.locator("#selection-mode")).to_have_value("filters")
    workspace = page.request.get(page.url.rstrip("/") + "/api/workspace").json()
    assert workspace["state"]["ignored_configs"] == [key]
    assert table.locator('td[data-config-field="config:' + key + '"]').all_text_contents() == [
        "1",
        "2",
        "3",
        "42",
    ]
    search.fill("")
    page.locator("#diff-only").check()
    expect(table).to_be_visible()
    search.fill("constant.marker")
    expect(table.locator("th[data-config-key]")).to_have_count(0)
    expect(page.locator("#config-search-notice")).to_contain_text(
        "Search excludes identical configurations."
    )
    page.get_by_role("button", name="Search all fields", exact=True).click()
    expect(table.locator('th[data-config-key="config:constant.marker"]')).to_have_count(1)
    search.fill("no.such.configuration")
    expect(page.get_by_role("heading", name="No matching comparison fields")).to_be_visible()
    expect(page.locator("#config-search-notice")).to_have_count(0)
    expect(page.locator("#view")).to_contain_text(
        "No configuration paths or scalar specifications match this search."
    )
    search.fill("")
    pending = []

    def delay_comparison(route):
        pending.append((route, route.fetch()))

    page.route("**/api/compare", delay_comparison)
    page.locator("#diff-only").check()
    deadline = time.monotonic() + 10
    while not pending:
        assert time.monotonic() < deadline, "The comparison reload did not start"
        page.wait_for_timeout(20)
    try:
        expect(search).to_be_visible()
        search.focus()
        page.keyboard.type("env.config.terrain.")
        page.evaluate("window.__previousConfigSearch = document.getElementById('config-search')")
    finally:
        route, response = pending.pop()
        route.fulfill(response=response)
    page.wait_for_function("""() => {
      const search = document.getElementById('config-search');
      return search && search !== window.__previousConfigSearch;
    }""")
    expect(search).to_be_focused()
    page.keyboard.type("generator.seed")
    expect(search).to_have_value(key)
    expect(table.locator('th[data-config-key="config:' + key + '"]')).to_have_count(1)
    expect(page.locator("#selected-count")).to_have_text(selected)
    page.unroute("**/api/compare", delay_comparison)


@pytest.mark.ui_scenario("onsets")
def test_sustained_changes_sort_correlations_onsets_export_and_persist(ui_page, tmp_path):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="time"]').click()
    expect(page.locator("#time-mode")).to_have_value("onsets")
    analyze = page.locator("#analyze-time-button")
    expect(analyze).to_be_disabled()
    reference = page.get_by_role("combobox", name="Reference curve", exact=True)
    choices = page.locator('#time-reference-list [role="option"]')
    menu = page.locator("#time-reference-menu")
    expect(page.locator("#time-reference-search")).to_have_count(0)
    toggle = page.get_by_role("button", name="Show reference curves", exact=True)
    toggle.click()
    expect(menu).to_be_visible()
    expect(reference).to_be_focused()
    toggle.click()
    expect(menu).not_to_be_visible()
    reference.press("ArrowDown")
    expect(menu).to_be_visible()
    reference.press("Escape")
    reference.fill("  ReFeReNcE  ")
    expect(reference).to_have_attribute("aria-expanded", "true")
    expect(choices).to_have_count(2)
    expect(page.locator("#time-reference-count")).to_have_text("1 matching curve")
    expect(analyze).to_be_disabled()
    reference.press("Enter")
    expect(reference).to_have_value("onset/reference")
    expect(menu).not_to_be_visible()
    expect(analyze).to_be_enabled()
    reference.fill("EARLY")
    expect(reference).to_have_attribute("data-reference-value", "onset/reference")
    expect(choices).to_have_count(3)
    expect(page.locator("#time-reference-count")).to_contain_text("selected reference retained")
    reference.press("ArrowUp")
    active = reference.get_attribute("aria-activedescendant")
    assert page.locator("#" + active).get_attribute("aria-selected") == "true"
    reference.press("Escape")
    expect(reference).to_have_value("onset/reference")
    expect(menu).not_to_be_visible()
    reference.fill("no-such-curve")
    expect(choices).to_have_count(2)
    expect(page.locator("#time-reference-count")).to_contain_text("No matching curves")
    reference.press("Enter")
    expect(reference).to_have_attribute("data-reference-value", "onset/reference")
    expect(menu).to_be_visible()
    reference.press("ArrowUp")
    active = reference.get_attribute("aria-activedescendant")
    assert page.locator("#" + active).get_attribute("aria-selected") == "true"
    reference.press("Enter")
    expect(reference).to_have_value("onset/reference")
    expect(menu).not_to_be_visible()
    reference.fill("no-such-curve")
    reference.press("Tab")
    expect(reference).not_to_be_focused()
    expect(reference).to_have_value("onset/reference")
    expect(menu).not_to_be_visible()
    reference.fill("EARLY")
    page.get_by_role("option", name="onset/early", exact=True).click()
    expect(reference).to_have_value("onset/early")
    reference.fill("reference")
    page.get_by_role("option", name="onset/reference", exact=True).click()
    expect(reference).to_have_value("onset/reference")
    reference.fill("")
    eligible_count = choices.count()
    assert eligible_count > 10
    reference.press("Escape")
    expect(page.locator("#onset-smoothing")).to_have_value("10")
    expect(page.locator("#onset-duration")).to_have_value("20")
    requests, pending = [], []

    def hold_start(route):
        response = route.fetch()
        pending.append((route, response))

    page.route("**/api/analysis/jobs", hold_start)
    page.on(
        "request",
        lambda request: (
            requests.append(request) if urlsplit(request.url).path == "/api/analysis/jobs" else None
        ),
    )
    analyze.click()
    expect(page.locator("#time-progress")).to_be_visible()
    expect(analyze).to_be_disabled()
    reference.fill("early")
    expect(reference).to_have_attribute("data-reference-value", "onset/reference")
    expect(page.locator("#time-progress")).to_be_visible()
    deadline = time.monotonic() + 10
    while not pending:
        assert time.monotonic() < deadline
        page.wait_for_timeout(20)
    route, response = pending.pop()
    with page.expect_response("**/api/analysis/jobs/*/result") as completed:
        route.fulfill(response=response)
    page.unroute("**/api/analysis/jobs", hold_start)
    result = completed.value.json()
    assert requests[0].post_data_json["kind"] == "onsets"
    assert requests[0].post_data_json["onset_smoothing"] == 10
    table = page.locator("#onset-results-table")
    expect(table).to_be_visible()
    expect(page.locator("#time-progress")).not_to_be_visible()
    expect(page.locator("#onset-reference-summary")).to_contain_text("onset/reference")
    expect(reference).to_have_value("early")
    expect(choices).to_have_count(3)
    assert len(result["curves"]) == eligible_count - 1
    reference.press("Escape")

    def row_order():
        return table.locator("tbody tr[data-onset-tag]").evaluate_all(
            "rows => rows.map(row => row.dataset.onsetTag)"
        )

    related = [row for row in result["rows"] if row["related"]]
    assert row_order() == [
        row["tag"]
        for row in sorted(related, key=lambda row: (-abs(row["correlation"]), row["tag"]))
    ]
    assert row_order()[0] == "onset/identical"
    page.locator("#onset-curves").evaluate("plot => window.__referenceFilterPlot = plot")
    reference.fill("constant")
    assert row_order()[0] == "onset/identical"
    assert page.locator("#onset-curves").evaluate("plot => plot === window.__referenceFilterPlot")
    reference.press("Escape")
    expect(
        table.locator('tr[data-onset-tag="onset/inverse"] [data-onset-correlation]')
    ).to_contain_text("-")
    page.locator("#onset-sort").select_option("onset")
    expected = [
        row["tag"]
        for row in sorted(
            related,
            key=lambda row: (
                row["onset"] if row["onset"] is not None else float("inf"),
                row["tag"],
            ),
        )
    ]
    assert row_order() == expected
    wait_for_plot(page, "#onset-curves")
    wait_for_plot(page, "#onset-timeline")
    assert page.locator("#onset-curves").evaluate(
        "plot => plot.data.some(trace => trace.name === 'onset/reference')"
    )
    assert page.locator("#onset-curves").evaluate("plot => plot.layout.shapes.length") == 1
    page.screenshot(path=str(tmp_path / "onset-analysis.png"), full_page=True)
    page.locator("#onset-show-all").check()
    search = page.locator("#time-result-filter")
    search.fill("constant")
    expect(table.locator("tbody tr[data-onset-tag]")).to_have_count(1)
    assert row_order() == ["onset/constant"]
    expect(table).to_contain_text("Constant in change interval")
    assert page.locator("#onset-curves").evaluate(
        "plot => plot.data.some(trace => trace.name === 'onset/reference')"
    )
    search.fill("")
    expect(table.locator("tbody tr[data-onset-tag]")).to_have_count(8)
    page.locator("#onset-sort").select_option("correlation")
    page.locator('[data-action="time-next"]').click()
    expect(table.locator("tbody tr[data-onset-tag]")).to_have_count(8)
    with page.expect_download() as downloaded:
        page.get_by_role("button", name="Export results CSV ↓", exact=True).click()
    path = tmp_path / "onsets.csv"
    downloaded.value.save_as(path)
    with path.open(newline="") as stream:
        records = list(csv.reader(stream))
    assert len(records) == len(result["rows"]) + 1
    correlations = [abs(float(row[1])) for row in records[1:] if row[1]]
    assert correlations == sorted(correlations, reverse=True)
    assert len(requests) == 1, "Sorting, browsing, and CSV export must not rerun the analysis"
    page.locator("#onset-sort").select_option("onset")
    page.get_by_role("button", name="Save as new view", exact=True).click()
    dialog = page.locator("#dialog")
    dialog.get_by_label("View name", exact=True).fill("Onset review")
    dialog.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    reference.fill("unmatched-query")
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    expect(reference).to_have_attribute("data-reference-value", "onset/reference")
    reference.press("Escape")
    page.locator("#onset-sort").select_option("correlation")
    expect(page.locator("#named-view-status")).to_have_text("Modified")
    with page.expect_navigation(wait_until="domcontentloaded"):
        page.get_by_role("button", name="Revert", exact=True).click()
    expect(page.locator("#time-mode")).to_have_value("onsets")
    expect(page.locator("#time-reference")).to_have_value("onset/reference")
    expect(page.locator("#onset-smoothing")).to_have_value("10")
    with page.expect_response("**/api/analysis/jobs") as restarted:
        page.locator("#analyze-time-button").click()
    assert restarted.value.json()["reused"]
    expect(page.locator("#onset-sort")).to_have_value("onset")
    expect(page.locator("#onset-show-all")).to_be_checked()
    expect(page.locator("#named-view-status")).to_have_text("Saved")
    for mode in ("events", "periodicity"):
        page.locator("#time-mode").select_option(mode)
        expect(reference).to_have_value("onset/reference")
        reference.fill("EARLY")
        expect(choices).to_have_count(3)
        expect(reference).to_have_attribute("data-reference-value", "onset/reference")
        page.locator("#time-axis").click()
        expect(menu).not_to_be_visible()
        expect(reference).to_have_value("onset/reference")
        page.keyboard.press("Escape")
    reference.click()
    page.get_by_role("option", name="Automatic · strongest activity", exact=True).click()
    expect(reference).to_have_value("")
    expect(reference).to_have_attribute("placeholder", "Automatic · strongest activity")
    page.set_viewport_size({"width": 375, "height": 1000})
    reference.scroll_into_view_if_needed()
    reference.fill("early")
    expect(menu).to_be_visible()
    bounds = menu.bounding_box()
    assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 375
    page.screenshot(path=str(tmp_path / "reference-picker.png"))
    reference.press("Escape")
    page.locator("#time-experiment").select_option(index=1)
    expect(reference).to_have_value("")
    expect(menu).not_to_be_visible()


@pytest.mark.ui_scenario("missing-condition")
def test_experiments_configurations_relationships_and_time_series(ui_page):
    page = ui_page
    page.locator('#navigation [data-action="tab"][data-value="runs"]').click()
    expect(page.locator(".experiment-table tbody tr")).to_have_count(4)
    page.locator('#navigation [data-action="tab"][data-value="configs"]').click()
    expect(page.locator("tr[data-experiment-id]")).to_have_count(4)
    page.locator('#navigation [data-action="tab"][data-value="analysis"]').click()
    wait_for_plot(page, "#condition-chart")
    wait_for_plot(page, "#parallel-chart")
    expect(page.locator("#parallel-error")).not_to_be_visible()
    condition = page.get_by_role("combobox", name="Condition", exact=True)
    condition.click()
    search = page.get_by_role("combobox", name="Filter Condition", exact=True)
    expect(search).to_be_focused()
    initial = condition.input_value()
    search.fill("no-such-condition")
    expect(page.get_by_text("No matching options", exact=True)).to_be_visible()
    search.press("Enter")
    expect(condition).to_have_value(initial)
    search.fill("  ChItEc  ")
    options = page.get_by_role("listbox", name="Condition", exact=True)
    expect(options.get_by_role("option")).to_have_text(["model.architecture"])
    expect(condition).to_have_value(initial)
    search.press("Enter")
    expect(search).to_have_count(0)
    expect(condition).to_have_value("model.architecture")
    page.wait_for_function(
        "() => document.getElementById('condition-chart')._fullLayout.xaxis.type === 'category'"
    )
    labels = page.locator("#condition-chart").evaluate("plot => plot._fullLayout.xaxis.ticktext")
    assert "transformer" in labels and "moe" in labels
    missing_path = "motion.reserve_endpoint_frame"
    association = page.locator(f'.association[data-value="{missing_path}"]')
    expect(association).to_be_visible()
    condition.click()
    search.fill("endpoint")
    search.press("Enter")
    expect(condition).to_have_value(missing_path)
    missing = page.get_by_role("checkbox", name="Include missing as a category")
    expect(missing).to_be_checked()
    expect(page.get_by_role("checkbox", name="Merge missing and null")).to_be_checked()
    page.wait_for_function(
        "document.getElementById('condition-chart').data.some(trace => "
        "trace.name === '(missing or null)' && trace.y.length === 3)"
    )
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: missing_path in view.get("excludedMissingConditions", [])
        )
    ):
        missing.uncheck()
    expect(missing).not_to_be_checked()
    expect(association).to_have_count(0)
    page.reload()
    expect(condition).to_have_value(missing_path)
    expect(missing).not_to_be_checked()
    expect(association).to_have_count(0)
    scope = page.locator("#association-scope")
    scope.press("o")
    scope_search = page.get_by_role("combobox", name="Filter Conditions", exact=True)
    expect(scope_search).to_have_value("o")
    scope_search.press("Escape")
    expect(scope_search).to_have_count(0)
    expect(scope).to_be_focused()
    expect(scope).to_have_value("configurations")
    page.get_by_role("button", name="Appearance", exact=False).click()
    dialog = page.locator("#dialog")
    preset = dialog.locator('select[name="appearance_preset"]')
    preset.click()
    preset_search = dialog.get_by_role("combobox", name="Filter Preset", exact=True)
    preset_search.fill("ntrast")
    dialog.get_by_role("listbox", name="Preset", exact=True).get_by_role(
        "option", name="High contrast", exact=True
    ).click()
    expect(preset).to_have_value("contrast")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Cancel", exact=True).click()
    page.locator('#navigation [data-action="tab"][data-value="time"]').click()
    analyze = page.get_by_role("button", name=re.compile(r"Analyze [1-9]\d* curves"))
    expect(analyze).to_be_enabled(timeout=60_000)
    analyze.click()
    wait_for_plot(page, "#event-curves")
    expect(page.locator("#time-error")).not_to_be_visible()
    reference = (
        page.locator("#time-results > .toolbar .muted").inner_text().split("reference: ", 1)[1]
    )
    for title, identifier in [("Event delays", "events"), ("Lagged correlation", "lag")]:
        button = page.get_by_role("button", name="About " + title, exact=True)
        tooltip = page.locator("#" + identifier + "-timing-help")
        button.hover()
        expect(tooltip).to_be_visible()
        expect(tooltip).to_contain_text(reference)
        page.keyboard.press("Escape")
        expect(tooltip).not_to_be_visible()
        button.focus()
        expect(tooltip).to_be_visible()
        button.press("Escape")
        expect(tooltip).not_to_be_visible()
        button.click()
        expect(tooltip).to_be_visible()
    page.set_viewport_size({"width": 375, "height": 1000})
    button.scroll_into_view_if_needed()
    button.hover()
    button.click()
    expect(page.locator(".panel-help-tooltip:not([hidden])")).to_have_count(1)
    box = tooltip.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 375
    assert box["y"] >= 0 and box["y"] + box["height"] <= 1000

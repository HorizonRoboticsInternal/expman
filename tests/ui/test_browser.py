"""Exercise bundled Plotly and native scalar loading through actual browser controls."""

import re
from urllib.parse import urlsplit

import pytest

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


def assert_full_resolution(page, selector):
    rendered = page.locator(selector).evaluate(
        """plot => ({
          inputs: plot.data[0].x.length,
          defaults: plot._fullData[0].x.length,
          calculations: plot.calcdata[0].map(point => point.x),
          simplified: plot._fullData[0].line.simplify,
          vertices: Array.from(plot.querySelectorAll('.scatterlayer .js-line')).reduce(
            (count, path) => count + (path.getAttribute('d').match(/[MLHV]/g) || []).length, 0)
        })"""
    )
    assert rendered["inputs"] == rendered["defaults"] == STRESS_POINTS
    assert rendered["calculations"] == list(range(STRESS_POINTS))
    assert rendered["simplified"] is False
    assert rendered["vertices"] >= STRESS_POINTS


def saved_view(response, predicate):
    return (
        urlsplit(response.url).path == "/api/view"
        and response.request.method == "PUT"
        and predicate(response.request.post_data_json["view"])
    )


def change_number(locator, value):
    locator.fill(str(value))
    locator.press("Tab")


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
    change_number(page.locator("#smoothing-value"), 0.9)
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
    first_control = page.locator('input[type="number"][data-panel-smoothing="train/loss"]')
    with page.expect_response(
        lambda response: saved_view(
            response, lambda view: view["panelSmoothing"].get("train/loss") == 0.2
        )
    ):
        change_number(first_control, 0.2)
    expect(page.locator('input[type="number"][data-panel-smoothing="eval/reward"]')).to_have_value(
        "0.9"
    )
    expect(page.locator("#smoothing-value")).to_have_value("0.9")
    first = main_traces(page)[0]
    assert first["y"][1] == pytest.approx((0.2 * first["original"][0] + first["original"][1]) / 1.2)
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
    page.reload()
    wait_for_overview(page)
    expect(page.locator(f'[data-overview-color="{identifier}"]')).to_have_value("#123456")
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
    page.locator("#condition-select").select_option("model.architecture")
    page.wait_for_function(
        "() => document.getElementById('condition-chart')._fullLayout.xaxis.type === 'category'"
    )
    labels = page.locator("#condition-chart").evaluate("plot => plot._fullLayout.xaxis.ticktext")
    assert "transformer" in labels and "moe" in labels
    page.locator('#navigation [data-action="tab"][data-value="time"]').click()
    analyze = page.get_by_role("button", name=re.compile(r"Analyze [1-9]\d* curves"))
    expect(analyze).to_be_enabled(timeout=60_000)
    analyze.click()
    wait_for_plot(page, "#event-curves")
    expect(page.locator("#time-error")).not_to_be_visible()

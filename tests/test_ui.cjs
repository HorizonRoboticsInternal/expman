"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const elements = new Map(), requests = [], charts = [], resized = [], relayouts = [], checkboxInputs = [], runInputs = [], fullControls = [];
const documentHandlers = {};
const legendNames = [], legendColors = [], legendShowAll = [];
const smoothingControls = [];
const experimentMarkup = id => elements.get("view").innerHTML.split('data-experiment-id="' + id + '"')[1].split("</tr>")[0];
const configCellMarkup = (id, field) => {
  const match = Array.from(experimentMarkup(id).matchAll(/<td[^>]*data-config-field="([^"]+)"[^>]*>[\s\S]*?<\/td>/g)).find(item => item[1] === field);
  return match ? match[0] : "";
};
const element = identifier => {
  if (!elements.has(identifier)) elements.set(identifier, {innerHTML: "", textContent: "", dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, style: {setProperty() {}}, classList: {add() {}, toggle() {}}, querySelectorAll: () => [], appendChild(child) { child.parentNode = this; return child; }, handlers: {}, on(name, handler) { this.handlers[name] = handler; }, addEventListener(name, handler) { this.handlers[name] = handler; }, showModal() { this.open = true; }, close() { this.open = false; if (this.handlers.close) this.handlers.close(); }});
  return elements.get(identifier);
};
const context = {
  AbortController: class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } },
  window: {addEventListener() {}, clearTimeout() {}, setTimeout() {}, requestAnimationFrame(callback) { return setImmediate(callback); }, Plotly: true},
  document: {getElementById: element, addEventListener(name, handler) { documentHandlers[name] = handler; }, querySelectorAll: selector => selector === "input[data-panel-log-y]" ? checkboxInputs : selector === "input[data-select-run]" ? runInputs : selector === "[data-full-panel]" ? fullControls : selector === '[data-action="toggle-overview-curve"]' ? legendNames : selector === "[data-overview-color]" ? legendColors : selector === "[data-panel-smoothing]" ? smoothingControls : selector === '[data-action="show-all-curves"]' ? legendShowAll : []},
  Plotly: {
    react(target, traces, layout) { target.data = traces; target.layout = layout; charts.push({target, traces, layout}); return Promise.resolve(); },
    Plots: {resize(target) { resized.push(target); return Promise.resolve(); }},
    relayout(target, changes) { relayouts.push({target, changes}); Object.keys(changes).forEach(key => { const parts = key.split("."); target.layout[parts[0]][parts[1]] = changes[key]; }); return Promise.resolve(); },
    restyle(target, changes, indices) {
      const selected = indices || target.data.map((trace, index) => index);
      selected.forEach((index, offset) => Object.keys(changes).forEach(key => {
        const parts = key.split("."), value = Array.isArray(changes[key]) ? changes[key][offset] : changes[key];
        if (parts.length > 1) { target.data[index][parts[0]] = target.data[index][parts[0]] || {}; target.data[index][parts[0]][parts[1]] = value; }
        else target.data[index][key] = value;
      }));
      if (target.handlers.plotly_restyle) target.handlers.plotly_restyle([changes, selected]);
      return Promise.resolve();
    },
    purge(target) { delete target.data; delete target.layout; }
  },
  fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({url, body});
    return {ok: true, json: async () => ({curves: Object.fromEntries(body.tags.map(tag => [tag, []]))})};
  },
  console
};
vm.createContext(context);
for (const filename of ["panels.js", "signals.js", "appearance.js", "filters.js", "configurations.js", "relationships.js", "onsets.js", "views.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/expman/static/", filename), "utf8"), context);
let source = fs.readFileSync(path.join(__dirname, "../src/expman/static/app.js"), "utf8");
source = source.replace(/  boot\(\)\.catch\(error => .*\);/, "  window.testApp = {state, renderOverview, renderTime, renderOnsets, analyzeTime, pollTimeJob, cancelTime, renderEvents, renderPeriodicity, renderConfigTable, renderConfigs, renderAnalysis, renderCondition, renderParallel, renderView, setPanelSize, setPanelLogY, expandPanel, actions, selectionChanged, moveConfigRow, configurationRows, configScalarDialog, saveConfigScalar, updateConfigExclusions, pollConfigScalars, ensureConfigScalars, pollFullPanel, pollRelationships, cancelRelationships, relationshipRequest, loadJSONMetrics, pollJSONMetrics, drawCurvePanel, fullPanelKey};");
vm.runInContext(source, context);

async function main() {
  const {state, renderOverview, renderTime} = context.window.testApp;
  state.workspace = {settings: {appearance: {font_size: 18, font_family: "georgia"}}};
  state.tab = "overview";
  state.serial = 1;
  state.runs = [{id: "sample", name: "Sample", path: "sample", config: {}}];
  state.selected = new Set(["sample"]);
  state.tags = ["Eval/reward", "Train/loss/actor", "Train/loss/critic", "Train/reward"];
  state.panels = state.tags;
  state.showAllPanels = true;
  await renderOverview(1);
  assert(elements.get("view").innerHTML.includes('data-value="Train/loss" aria-expanded="true"'));
  assert(elements.get("view").innerHTML.includes('data-value="Train" aria-expanded="true"'));
  assert.equal(requests[0].body.tags.length, 4);
  assert.equal(charts.length, 4);
  state.collapsedPanelGroups = ["Train/loss"];
  await renderOverview(1);
  assert.deepEqual(Array.from(requests[1].body.tags), ["Eval/reward", "Train/reward"]);
  assert(elements.get("view").innerHTML.includes('data-value="Train/loss" aria-expanded="false"'));
  assert(!elements.get("view").innerHTML.includes('title="Train/loss/critic"'));
  state.collapsedPanelGroups = ["Train", "Eval"];
  await renderOverview(1);
  assert.equal(requests.length, 2);
  assert(elements.get("view").innerHTML.includes("Panel groups are collapsed"));
  state.showAllPanels = false;
  await renderOverview(1);
  assert.equal(requests[2].body.tags.length, 4);
  assert(!elements.get("view").innerHTML.includes("panel-group-heading"));
  assert(elements.get("view").innerHTML.includes('id="panel-size"'));
  assert(!elements.get("view").innerHTML.includes('id="log-y"'));
  assert.equal((elements.get("view").innerHTML.match(/data-panel-log-y=/g) || []).length, 4);
  assert.equal((elements.get("view").innerHTML.match(/data-action="expand-panel"/g) || []).length, 4);
  const loadedRequests = requests.length;
  await context.window.testApp.setPanelSize("large");
  assert.equal(state.panelSize, "large");
  assert.equal(elements.get("overview-panels").dataset.panelSize, "large");
  assert.equal(resized.length, 4);
  assert.equal(requests.length, loadedRequests);
  assert.equal(state.pendingView.panelSize, "large");
  const loggedTag = state.visiblePanelTags[0];
  const checkbox = {dataset: {panelLogY: loggedTag}, checked: false};
  checkboxInputs.push(checkbox);
  await context.window.testApp.setPanelLogY(loggedTag, true);
  assert.equal(checkbox.checked, true);
  assert.equal(elements.get("curve-0").layout.yaxis.type, "log");
  assert.equal(elements.get("curve-1").layout.yaxis.type, "linear");
  assert.equal(relayouts.length, 1);
  assert.deepEqual(Array.from(state.pendingView.logYPanels), [loggedTag]);
  assert.equal(requests.length, loadedRequests);
  elements.get("curve-0").layout.width = 480;
  elements.get("curve-0").layout.height = 300;
  elements.get("curve-0").layout.xaxis.range = [20, 40];
  const initialFont = elements.get("curve-0").layout.font.size;
  await context.window.testApp.expandPanel(loggedTag);
  const expanded = elements.get("expanded-panel-plot");
  assert.equal(elements.get("panel-dialog").open, true);
  assert.equal(state.expandedPanel, loggedTag);
  assert.equal(expanded.layout.width, undefined);
  assert.equal(expanded.layout.height, undefined);
  assert.equal(expanded.layout.autosize, true);
  assert.equal(expanded.layout.font.size, initialFont);
  assert.deepEqual(Array.from(expanded.layout.xaxis.range), [20, 40]);
  assert.notEqual(expanded.layout.xaxis, elements.get("curve-0").layout.xaxis);
  assert.equal(expanded.layout.yaxis.type, "log");
  assert.equal(requests.length, loadedRequests);
  checkboxInputs.push({dataset: {panelLogY: loggedTag}, checked: true});
  await context.window.testApp.setPanelLogY(loggedTag, false);
  assert.equal(expanded.layout.yaxis.type, "linear");
  assert.equal(elements.get("curve-0").layout.yaxis.type, "linear");
  assert(checkboxInputs.every(input => !input.checked));
  expanded.layout.xaxis.range = [25, 35];
  await renderOverview(1);
  assert.deepEqual(Array.from(expanded.layout.xaxis.range), [25, 35]);
  elements.get("panel-dialog").close();
  assert.equal(state.expandedPanel, null);
  assert.equal(expanded.data, undefined);
  assert.equal(elements.get("panel-dialog").innerHTML, "");
  state.selected = new Set(["first", "second"]); state.baseline = "first";
  state.comparison = {experiments: [{id: "first", name: "Baseline"}, {id: "second", name: "Other"}], rows: [{key: "layers", ignored: false, cells: [{present: true, value: [{alpha: 1, beta: 2}]}, {present: true, value: [{beta: 2, alpha: 1}]}]}]};
  context.window.testApp.renderConfigTable();
  assert(!elements.get("view").innerHTML.includes('class="mono changed"'));
  state.comparison.rows[0].cells[1].value = [{beta: 3, alpha: 1}];
  context.window.testApp.renderConfigTable();
  assert(elements.get("view").innerHTML.includes('class="mono changed"'));
  state.runs = [{id: "run", name: "Example"}];
  state.time.experiment = "run";
  state.time.loadedExperiment = "run";
  state.time.available = Array.from({length: 40}, (unused, index) => "Train/metric" + index);
  state.tab = "time";
  await renderTime(1);
  assert.equal(state.time.tags.length, 40);
  assert(elements.get("view").innerHTML.includes("Analyze 40 curves"));
  assert(elements.get("view").innerHTML.includes('id="time-include"'));
  assert(elements.get("view").innerHTML.includes('id="event-period-aware" checked'));
  state.time.include = ["Train/metric?"];
  state.time.exclude = ["*2", "*3"];
  await renderTime(1);
  assert.equal(state.time.tags.length, 8);
  assert(elements.get("view").innerHTML.includes("8 of 40 curves match"));
  state.time.include = ["*"]; state.time.exclude = [];
  await renderTime(1);
  state.workspace.state = {groups: [], ignored_configs: [], ignored_files: [], named_filters: []};
  let complete = false;
  const response = {id: "analysis", status: "queued", percent: 0, stage: "Queued", elapsed: 0};
  const result = {curves: {}, detections: {}, pairs: [], timeline: [], missing_metrics: [], reference: "Train/metric0", note: "Timing"};
  state.time.available.forEach(tag => { result.curves[tag] = {x: [0, 1, 2], y: [1, 2, 1], cadence: 1}; result.detections[tag] = {events: [], total: 0}; });
  result.settings = {threshold: 15, window: 31, detector: "spike"};
  const detectedEvent = {tag: "Train/metric0", x: 1, start: 1, end: 1, value: 2, baseline: 1, deviation: 1, score: 18, kind: "spike"};
  result.detections[detectedEvent.tag] = {events: [detectedEvent], total: 1};
  result.timeline = [detectedEvent];
  const strongerDip = {...detectedEvent, tag: "Train/metric1", x: 2, start: 2, end: 2, value: 1, score: -50, kind: "dip"};
  strongerDip.period = 10; strongerDip.baseline_type = "periodic_phase";
  const smallerSpike = {...detectedEvent, x: 0, start: 0, end: 0, score: 17};
  result.detections[detectedEvent.tag] = {events: [detectedEvent, smallerSpike], total: 2};
  result.detections[strongerDip.tag] = {events: [strongerDip], total: 1};
  result.detections[strongerDip.tag].periodic = {period: 10, cycles: 20, improvement: .9, adjusted_points: 200, source_points: 200};
  result.timeline.push(strongerDip, smallerSpike);
  const binaryEvent = {...detectedEvent, tag: "Train/metric2", score: 16, score_type: "bernoulli", context_window: 1001, value: 1, baseline: .004};
  result.settings.binary_window = 1001;
  result.curves[binaryEvent.tag].y = [0, 1, 0];
  result.detections[binaryEvent.tag] = {events: [binaryEvent], total: 1, data_type: "binary", score_type: "bernoulli", context_window: 1001};
  result.timeline.push(binaryEvent);
  context.fetch = async (url, options) => {
    if (url.endsWith("/result")) return {ok: true, json: async () => result};
    if (options && options.body) requests.push({url, body: JSON.parse(options.body)});
    return {ok: true, json: async () => Object.assign({}, response, {status: url.endsWith("/cancel") ? "cancelled" : complete ? "complete" : "running", percent: complete ? 100 : 20})};
  };
  await context.window.testApp.analyzeTime();
  const submitted = requests.find(request => request.url === "/api/analysis/jobs").body;
  assert.equal(submitted.tags, undefined);
  assert.deepEqual(Array.from(submitted.include), ["*"]);
  assert.equal(state.timeJob.id, "analysis");
  assert.equal(elements.get("time-progress").hidden, false);
  complete = true;
  await context.window.testApp.pollTimeJob("analysis");
  assert.equal(state.timeJob, null);
  assert.equal(Object.keys(state.timeData.curves).length, 40);
  assert(elements.get("time-results").innerHTML.includes("40 curves analyzed"));
  const lastCurveChart = charts.filter(chart => chart.target === elements.get("event-curves")).pop();
  assert(lastCurveChart.traces.length <= 16);
  assert(elements.get("time-results").innerHTML.includes("Applied event threshold: |Event score| ≥ 15"));
  const eventMarker = lastCurveChart.traces.find(trace => trace.mode === "markers");
  assert.equal(eventMarker.customdata[0][1], -50);
  assert.equal(lastCurveChart.traces[0].name, strongerDip.tag, "A stronger dip ranks above a metric with more events");
  assert(eventMarker.hovertemplate.includes("Score:"));
  const binaryMarker = lastCurveChart.traces.find(trace => trace.name === binaryEvent.tag + " events");
  assert(binaryMarker.hovertemplate.includes("Score:"));
  assert.equal(binaryMarker.customdata[0][2], binaryEvent.kind);
  assert(elements.get("time-results").innerHTML.includes("1 binary curves use smoothed Bernoulli scores"));
  assert(elements.get("time-results").innerHTML.includes("Expected probability of 1"));
  assert(elements.get("time-results").innerHTML.includes("1 curves scored relative to periodic fluctuation"));
  assert(elements.get("time-results").innerHTML.includes("Expected value at this phase of a 10-unit cycle"));
  const phaseMarker = lastCurveChart.traces.find(trace => trace.name === strongerDip.tag + " events");
  assert.equal(phaseMarker.customdata[0][2], "dip");
  assert(!phaseMarker.hovertemplate.includes("Context:"));
  assert(Math.abs(eventMarker.y[0]) < 10);
  const orderedEvents = elements.get("time-results").innerHTML.split("<th>EVENT SCORE</th>")[1].split("</tbody>")[0];
  assert(orderedEvents.indexOf(strongerDip.tag) < orderedEvents.indexOf(detectedEvent.tag));
  assert(elements.get("time-results").innerHTML.includes('data-action="time-next"'));
  await context.window.testApp.analyzeTime();
  await new Promise(resolve => setImmediate(resolve));
  assert(state.timeData, "A cached completed analysis must fetch and show its result");
  assert.equal(Object.keys(state.timeData.curves).length, 40);
  state.timeJob = response;
  await context.window.testApp.cancelTime();
  assert.equal(state.timeJob, null);
  assert(requests.some(request => request.url.endsWith("/cancel")));
  await timeLifecycleRegressions(result);
  state.runs = [{id: "chosen", name: "Kept selected", path: "train/exp001", config: {}, tags: [], warnings: [], metrics: {}, modified: 0}];
  state.selected = new Set(["chosen"]);
  const savedFilters = [{id: "named", name: "Saved", filters: [{source: "path", key: "path", operator: "not_contains", value: "EXP001"}]}];
  state.workspace.state.named_filters = savedFilters;
  state.tab = "runs"; state.query = "nonmatching"; state.collection = "starred";
  state.filters = savedFilters[0].filters; state.activeFilter = "named";
  element("run-search").value = state.query;
  const requestsBeforeClear = requests.length;
  await context.window.testApp.actions["clear-all-filters"]();
  assert.equal(state.query, "");
  assert.equal(element("run-search").value, "");
  assert.equal(state.collection, "all");
  assert.equal(state.filters.length, 0);
  assert.equal(state.activeFilter, "");
  assert.equal(state.selected.has("chosen"), true);
  assert.equal(state.workspace.state.named_filters, savedFilters);
  assert.equal(elements.get("clear-all-filters").disabled, true);
  assert.equal(elements.get("clear-all-filters").hidden, false);
  assert(elements.get("view").innerHTML.includes("Kept selected"));
  assert.equal(state.pendingView.collection, "all");
  assert.equal(state.pendingView.filters.length, 0);
  assert.equal(requests.length, requestsBeforeClear);
  assert(elements.get("named-filter-choice").innerHTML.includes("Saved (0 matches)"));
  context.window.testApp.actions["filters"]();
  assert(elements.get("dialog").innerHTML.includes('value="not_contains">Does not contain'));
  await metricDiscoveryRaces();
  await configurationWorkflows();
  await fullPanelWorkflows();
  await selectedPanelCoverage();
  await overviewExperimentSearch();
  state.tab = "native";
  let nativeStatus = {backend: "fast", ready: true, streams_with_data: 12, streams_discovered: null};
  context.fetch = async () => ({ok: true, json: async () => nativeStatus});
  await context.window.testApp.renderView();
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get("native-status-text").textContent.includes("fast reader"));
  assert(elements.get("native-status-text").textContent.includes("12 streams available"));
  assert.equal(elements.get("native-progress").hidden, true);
  assert(elements.get("native-frame").src.includes("streaming="));
  nativeStatus = {backend: "python", ready: false, streams_with_data: 5, streams_discovered: 152, elapsed: 10, fallback_reason: "sockets denied"};
  await context.window.testApp.renderView();
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get("native-status-text").textContent.includes("Python reader"));
  assert(elements.get("native-status-text").textContent.includes("5 of 152"));
  assert(elements.get("native-status-text").textContent.includes("sockets denied"));
  nativeStatus = {backend: "fast", ready: false, error: "reader unavailable"};
  await context.window.testApp.renderView();
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get("native-status-text").textContent.includes("reader unavailable"));
  await relationshipRegressions();
  await conditionGroupingControls();
  await jsonSummaryRegressions();
  await jsonChoicesBeforeTensorBoard();
  await configExclusionRaces();
  transposedConfigRegressions();
  configurationDisplayRegressions();
  await onsetRenderingRegressions();
  await overviewLegendAndElapsed();
  await overviewBrowserSmoothing();
  await fullValueRenderRaces();
  await automaticPanelLoading();
  if (process.argv[2]) await realApiWorkflows(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  console.log("UI rendering: panel sizing, individual log axes, expansion, clear filters, grouped panels, and all-curve analysis verified");
}

async function timeLifecycleRegressions(result) {
  const app = context.window.testApp, state = app.state, calls = [], timers = new Map();
  const originalSetTimeout = context.window.setTimeout, originalClearTimeout = context.window.clearTimeout;
  let timerId = 0, releaseStart, holdStart = false, startError = false, progressFailures = 0, resultFailures = 0, calculationError = false, missing = false;
  context.window.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; };
  context.window.clearTimeout = id => timers.delete(id);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const job = status => ({id: "lifecycle", status, percent: status === "complete" ? 100 : 10, stage: status === "complete" ? "Complete" : "Loading scalar curves", elapsed: 1});
  context.fetch = async (url, options) => {
    calls.push({url, body: options && options.body ? JSON.parse(options.body) : null});
    if (url.endsWith("/cancel")) return {ok: true, json: async () => job("cancelled")};
    if (url === "/api/analysis/jobs") {
      if (holdStart) return new Promise(resolve => { releaseStart = () => resolve({ok: true, json: async () => job("queued")}); });
      return startError ? {ok: false, status: 503, json: async () => ({detail: "analysis worker unavailable"})} : {ok: true, json: async () => job("complete")};
    }
    if (url.endsWith("/result")) {
      if (resultFailures-- > 0) throw new Error("Result connection lost");
      return {ok: true, json: async () => result};
    }
    if (progressFailures-- > 0) throw new Error("Progress connection lost");
    if (missing) return {ok: false, status: 404, json: async () => ({detail: "Unknown job"})};
    return {ok: true, json: async () => calculationError ? {...job("error"), error: "No observations in the requested window"} : job("complete")};
  };
  try {
    holdStart = true;
    const pending = app.analyzeTime();
    assert.equal(state.timeStarting, true);
    assert.equal(elements.get("analyze-time-button").disabled, true);
    assert.equal(elements.get("time-progress").hidden, false);
    assert(elements.get("time-progress-text").textContent.includes("Submitting"));
    await tick(); await app.analyzeTime();
    assert.equal(calls.filter(call => call.url === "/api/analysis/jobs").length, 1);
    holdStart = false; releaseStart(); await pending; await tick();
    assert(state.timeData);
    startError = true;
    await app.analyzeTime();
    assert.equal(state.timeStarting, false);
    assert.equal(elements.get("analyze-time-button").disabled, false);
    assert(elements.get("time-error").innerHTML.includes("analysis worker unavailable"));
    assert(elements.get("time-error").innerHTML.includes("Retry analysis"));
    startError = false; progressFailures = 1;
    await app.actions["retry-time"](); await tick();
    assert(state.timeJob);
    assert(elements.get("time-error").innerHTML.includes("Progress connection lost"));
    const retry = Array.from(timers.entries()).find(([, timer]) => timer.delay === 1000);
    assert(retry, "A failed progress request must schedule a retry");
    timers.delete(retry[0]); await retry[1].callback(); await tick();
    assert(state.timeData);
    assert.equal(elements.get("time-error").hidden, true);
    resultFailures = 1;
    await app.analyzeTime(); await tick();
    assert(elements.get("time-error").innerHTML.includes("Result connection lost"));
    assert(elements.get("time-error").innerHTML.includes("Retry connection"));
    await app.actions["retry-time"](); await tick();
    assert(state.timeData);
    calculationError = true;
    await app.analyzeTime(); await tick();
    assert.equal(state.timeJob, null);
    assert(elements.get("time-error").innerHTML.includes("No observations in the requested window"));
    calculationError = false; missing = true;
    await app.analyzeTime(); await tick();
    assert.equal(state.timeJob, null);
    assert(elements.get("time-error").innerHTML.includes("no longer available"));
    missing = false;
    const plot = context.Plotly.react;
    context.Plotly.react = (target, ...args) => target === elements.get("event-curves") ? Promise.reject(new Error("Chart rendering failed")) : plot(target, ...args);
    await app.analyzeTime(); await tick();
    assert(state.timeData);
    assert(elements.get("time-error").innerHTML.includes("Chart rendering failed"));
    assert(elements.get("time-error").innerHTML.includes("Retry displaying results"));
    context.Plotly.react = plot;
    await app.actions["retry-time"]();
    assert.equal(elements.get("time-error").hidden, true);
    state.time.threshold = 5;
    await app.renderView();
    const serial = state.serial;
    await documentHandlers.change({target: {id: "event-threshold", value: "50", type: "number", dataset: {}, closest: () => null}});
    assert.equal(state.time.threshold, 50);
    assert.equal(state.serial, serial, "Committing an input must not replace the Analyze button before its click");
    await app.analyzeTime();
    assert.equal(calls.filter(call => call.url === "/api/analysis/jobs").pop().body.threshold, 50);
    const beforeBinaryWindow = state.serial;
    await documentHandlers.change({target: {id: "binary-window", value: "2001", type: "number", dataset: {}, closest: () => null}});
    assert.equal(state.serial, beforeBinaryWindow);
    assert.equal(state.time.binary_window, 2001);
    assert.equal(state.pendingView.time.binary_window, 2001);
    await app.analyzeTime();
    assert.equal(calls.filter(call => call.url === "/api/analysis/jobs").pop().body.binary_window, 2001);
    const periodSerial = state.serial;
    await documentHandlers.change({target: {id: "event-period-aware", checked: false, type: "checkbox", dataset: {}, closest: () => null}});
    assert.equal(state.serial, periodSerial);
    assert.equal(state.pendingView.time.period_aware, false);
    await app.analyzeTime();
    assert.equal(calls.filter(call => call.url === "/api/analysis/jobs").pop().body.period_aware, false);
    await documentHandlers.change({target: {id: "event-period-aware", checked: true, type: "checkbox", dataset: {}, closest: () => null}});
    holdStart = true;
    const cancelled = app.analyzeTime(); await tick();
    await app.cancelTime();
    const polls = calls.filter(call => call.url === "/api/analysis/jobs/lifecycle").length;
    holdStart = false; releaseStart(); await cancelled; await tick();
    assert.equal(state.timeJob, null);
    assert.equal(state.timeData, null);
    assert.equal(state.timeStarting, false);
    assert.equal(calls.filter(call => call.url === "/api/analysis/jobs/lifecycle").length, polls);
    assert(calls.some(call => call.url === "/api/analysis/jobs/lifecycle/cancel"));
    await app.renderView();
    console.log("Time analysis: cached completion, immediate submission progress, duplicate clicks, visible errors/retries, blur commits, and stale cancellation verified");
  } finally {
    context.window.setTimeout = originalSetTimeout; context.window.clearTimeout = originalClearTimeout;
  }
}

async function metricDiscoveryRaces() {
  const app = context.window.testApp, state = app.state, pending = [], jobResults = new Map();
  const run = id => ({id, name: id, path: id, config: {}, tags: [], warnings: [], metrics: {}, modified: 0});
  const response = (id, tag) => ({ok: true, json: async () => ({tags: [tag], config_keys: [], experiments: [run(id)]})});
  context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    if (url === "/api/metrics/jobs") return new Promise(resolve => {
      const id = "metadata-" + Math.random();
      pending.push({body, resolve(result) { jobResults.set(id, result); resolve(result.ok ? {ok: true, json: async () => ({id, status: "complete"})} : result); }});
    });
    if (url.endsWith("/cancel")) return {ok: true, json: async () => ({status: "cancelled"})};
    if (url.startsWith("/api/metrics/jobs/")) {
      const id = url.split("/")[4];
      return url.endsWith("/result") ? jobResults.get(id) : {ok: true, json: async () => ({id, status: "complete", percent: 100})};
    }
    assert.equal(url, "/api/curves");
    return {ok: true, json: async () => ({curves: Object.fromEntries(body.tags.map(tag => [tag, []]))})};
  };
  state.runs = [run("first"), run("second")];
  state.selected = new Set(); state.tab = "runs";
  runInputs.push(...state.runs.map(item => ({dataset: {selectRun: item.id}, checked: false})));
  const selectAll = {id: "toggle-visible", dataset: {}, checked: true, closest: () => null};
  const selected = documentHandlers.change({target: selectAll});
  await new Promise(resolve => setImmediate(resolve));
  assert(runInputs.every(input => input.checked), "Select all updates every row before discovery completes");
  assert.equal(state.selected.size, 2);
  pending[0].resolve(response("first", "train/loss"));
  await selected;
  pending.length = 0; runInputs.length = 0;
  state.selected = new Set(["first"]);
  state.tab = "runs";
  state.tags = []; state.panels = []; state.showAllPanels = true;
  const loading = app.selectionChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.metricsLoading, true);
  await app.actions["clear-all-filters"]();
  state.tab = "overview";
  await app.renderView();
  assert(elements.get("view").innerHTML.includes("Discovering scalar metrics"));
  pending.shift().resolve(response("first", "train/loss"));
  await loading;
  assert.equal(state.metricsLoading, false);
  assert.deepEqual(Array.from(state.tags), ["train/loss"]);
  assert(elements.get("view").innerHTML.includes("All panels (1)"));
  const older = app.selectionChanged();
  state.selected = new Set(["second"]);
  const newer = app.selectionChanged();
  pending[1].resolve(response("second", "eval/reward"));
  await newer;
  pending[0].resolve(response("first", "train/loss"));
  await older;
  assert.deepEqual(Array.from(state.tags), ["eval/reward"]);
  assert.equal(state.baseline, "second");
  pending.length = 0;
  const failure = app.selectionChanged();
  pending[0].resolve({ok: false, json: async () => ({detail: "Metric discovery failed"})});
  await failure;
  assert.equal(state.metricsLoading, false);
  assert(elements.get("view").innerHTML.includes("Could not read scalar metrics"));
  assert(elements.get("view").innerHTML.includes('data-action="reload-metrics"'));
  state.metricsError = "";
  console.log("Metric discovery: view changes and filter clearing preserve pending results; stale selections and failures handled");
}

async function configurationWorkflows() {
  const app = context.window.testApp, state = app.state;
  state.workspace.state = {groups: [], ignored_configs: [], ignored_files: [], named_filters: []};
  state.runs = ["a", "b", "stale"].map(id => ({id, name: id, path: id, config: {}, tags: [], warnings: [], metrics: {}, modified: 0}));
  state.selected = new Set(["a", "b"]); state.baseline = "stale";
  state.tab = "configs"; state.diffOnly = false; state.configOrder = []; state.configQuery = ""; state.configPage = 0;
  state.tags = ["loss"]; state.configScalarValues = null; state.configScalarJob = null;
  state.configScalars = [{id: "loss", tag: "loss", mode: "latest", step: null, smoothing: .4, highlight: "largest", highlight_color: "#ffaacc"}];
  let release, started = 0;
  context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    requests.push({url, body});
    if (url === "/api/compare/scalars/jobs") { started += 1; return new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({id: "scalar", status: "complete"})}); }); }
    if (url === "/api/compare/scalars/jobs/scalar") return {ok: true, json: async () => ({id: "scalar", status: "complete", percent: 100})};
    if (url.endsWith("/scalar/result")) return {ok: true, json: async () => ({experiment_ids: ["a", "b"], rows: [{id: "scalar:loss", key: "loss", kind: "scalar", scalar: state.configScalars[0], cells: [{present: true, value: 2}, {present: true, value: 5}]}]})};
    if (url === "/api/ignored-configs") { state.workspace.state.ignored_configs = body.patterns; return {ok: true, json: async () => state.workspace.state}; }
    assert.equal(url, "/api/compare");
    assert.equal(body.scalar_rows.length, 0, "Configuration fetch never waits for scalar histories");
    assert(!body.experiment_ids.includes("stale"));
    return {ok: true, json: async () => ({experiments: body.experiment_ids.map(id => ({id, name: id})), rows: ["model.name", "seed"].filter(key => !state.workspace.state.ignored_configs.includes(key)).map(key => ({id: "config:" + key, key, kind: "config", ignored: false, different: true, cells: body.experiment_ids.map(id => ({present: true, value: key === "model.name" ? id === "a" ? "transformer" : "moe" : id === "a" ? 1 : 2}))}))})};
  };
  await app.renderConfigs(state.serial);
  await new Promise(resolve => setImmediate(resolve));
  assert(elements.get("view").innerHTML.includes("transformer"));
  assert(!elements.get("view").innerHTML.includes("&quot;transformer&quot;"));
  assert(elements.get("view").innerHTML.includes("loading…"));
  assert(elements.get("view").innerHTML.includes('<code class="mono config-path-text" title="model.name">name</code>'));
  assert.deepEqual(Array.from(elements.get("view").innerHTML.matchAll(/<tr data-experiment-id="([^"]+)"/g), item => item[1]), ["a", "b"]);
  assert(experimentMarkup("a").includes("BASELINE"));
  assert(!experimentMarkup("b").includes("BASELINE"));
  assert(configCellMarkup("b", "config:model.name").includes("changed"));
  const beforeNames = requests.length;
  await documentHandlers.change({target: {id: "config-full-names", checked: true, dataset: {}}});
  assert(elements.get("view").innerHTML.includes('title="model.name">model.name</code>'));
  assert.equal(state.pendingView.configFullNames, true);
  assert.equal(requests.length, beforeNames, "Changing label length must reuse the comparison data");
  await documentHandlers.change({target: {id: "config-full-names", checked: false, dataset: {}}});
  assert(elements.get("view").innerHTML.includes('title="model.name">name</code>'));
  assert.equal(state.baseline, "a");
  release(); await new Promise(resolve => setImmediate(resolve));
  const scalarMarkup = () => elements.get("view").innerHTML.split('data-config-key="scalar:loss"')[1].split("</th>")[0] + ["a", "b"].map(id => configCellMarkup(id, "scalar:loss")).join("");
  assert(/class="mono config-path-text" title="TensorBoard scalar: loss\n[\s\S]*Highlight color: #ffaacc">loss<\/code>/.test(scalarMarkup()));
  assert(!scalarMarkup().includes('class="card-subtitle"'));
  assert(!scalarMarkup().includes("mono changed"));
  assert.equal((scalarMarkup().match(/scalar-highlight"/g) || []).length, 1);
  assert(scalarMarkup().includes("--scalar-highlight-background:#ffaacc"));
  assert(configCellMarkup("b", "scalar:loss").includes('class="mono scalar-highlight"'));
  assert(configCellMarkup("b", "scalar:loss").includes('title="number: 5"'));
  const data = new Map(Object.entries({scalar_id: "loss", scalar_tag: "loss", scalar_mode: "latest", scalar_highlight: "smallest", scalar_highlight_color: "#fbcfe8"}));
  app.saveConfigScalar(data);
  await app.renderConfigs(state.serial);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1, "Highlight edits reuse the existing scalar values");
  assert(configCellMarkup("a", "scalar:loss").includes('class="mono scalar-highlight"'));
  assert(configCellMarkup("a", "scalar:loss").includes('title="number: 2"'));
  await documentHandlers.change({target: {id: "baseline", value: "b", dataset: {}, closest: () => null}});
  assert.deepEqual(Array.from(state.comparison.experiments).map(item => item.id), ["a", "b"]);
  assert.equal(state.pendingView.baseline, "b");
  assert(!experimentMarkup("a").includes("BASELINE"));
  assert(experimentMarkup("b").includes("BASELINE"));
  assert(configCellMarkup("a", "config:model.name").includes("changed"));
  assert(!configCellMarkup("b", "config:model.name").includes("changed"));
  assert.equal(state.comparison.rows.find(row => row.kind === "scalar").cells[0].value, 2);
  assert.equal(state.comparison.rows.find(row => row.kind === "scalar").cells[1].value, 5);
  const beforeIgnore = requests.length;
  await documentHandlers.change({target: {id: "", dataset: {configInclude: "seed"}, checked: false}});
  assert(!elements.get("view").innerHTML.includes('data-config-include="seed"'));
  assert.equal(state.configScalars.length, 1);
  assert(!requests.slice(beforeIgnore).some(item => item.url.includes("metrics")));
  state.comparison.rows.push({kind: "config", key: "optional.value", cells: [{present: false, value: null}, {present: true, value: null}]});
  app.renderConfigTable();
  const optional = ["a", "b"].map(id => configCellMarkup(id, "config:optional.value")).join("");
  assert(optional.includes('title="Not set"></td>'), "Missing configuration cells remain empty");
  assert(optional.includes('title="object: null">null</td>'), "Explicit null remains visible");
  assert(!optional.includes("not set</"));
  const scalarRow = state.comparison.rows.find(row => row.kind === "scalar");
  scalarRow.cells[0] = {present: false, value: null};
  app.renderConfigTable();
  const scalarMissing = configCellMarkup(state.comparison.experiments[0].id, scalarRow.id);
  assert(scalarMissing.includes('title="No data at the requested step"></td>'));
  assert(!scalarMissing.includes(">no data<"));
  const rows = [{key: "a"}, {key: "b"}, {key: "c"}].map(row => ({...row, kind: "config", cells: [{present: true, value: 1}, {present: true, value: 2}]}));
  state.comparison.rows = rows;
  app.moveConfigRow("config:c", "config:a", true);
  assert.deepEqual(Array.from(app.configurationRows()).map(row => row.key), ["c", "a", "b"]);
  await documentHandlers.keydown({target: {closest: selector => selector === "[data-config-drag]" ? {dataset: {configDrag: "config:c"}} : null}, altKey: true, key: "ArrowRight", preventDefault() {}});
  assert.deepEqual(Array.from(app.configurationRows()).map(row => row.key), ["a", "c", "b"]);
  let dragged = "";
  const transfer = {setData(type, value) { dragged = value; }};
  documentHandlers.dragstart({target: {closest: () => ({dataset: {configDrag: "config:b"}, closest: () => ({classList: {add() {}}})})}, dataTransfer: transfer});
  documentHandlers.drop({target: {closest: () => ({dataset: {configKey: "config:a"}, getBoundingClientRect: () => ({left: 0, width: 20})})}, dataTransfer: transfer, clientX: 1, preventDefault() {}});
  assert.equal(dragged, "config:b");
  assert.deepEqual(Array.from(app.configurationRows()).map(row => row.key), ["b", "a", "c"]);
  assert.equal(state.pendingView.configOrder[0], "config:b");
  const table = element("config-table"), originalQuery = table.querySelectorAll;
  const columnKeys = ["experiment-name", "config:a", "config:b"], initialWidths = [220, 80, 90];
  state.configAutoWidths = Object.fromEntries(columnKeys.map((key, index) => [key, initialWidths[index]]));
  const cols = columnKeys.map(key => ({dataset: {configColumn: key}, style: {}}));
  const headers = columnKeys.map((key, index) => ({dataset: {configHeading: key}, getBoundingClientRect: () => ({width: parseFloat(cols[index].style.width) || initialWidths[index]})}));
  const handles = columnKeys.map(key => ({dataset: {configResize: key}, values: {}, setAttribute(name, value) { this.values[name] = value; }, focus() {}, setPointerCapture(pointer) { this.pointer = pointer; }}));
  table.querySelectorAll = selector => selector === "[data-config-heading]" ? headers : selector === "col[data-config-column]" ? cols : selector === "[data-config-resize]" ? handles : [];
  const pointer = (handle, x, id = 7) => ({target: {closest: selector => selector === "[data-config-resize]" ? handle : null}, clientX: x, pointerId: id, button: 0, preventDefault() {}});
  documentHandlers.pointerdown(pointer(handles[0], 100));
  assert.equal(handles[0].pointer, 7);
  documentHandlers.pointermove(pointer(handles[0], 150));
  assert.equal(cols[0].style.width, "270px");
  assert.equal(cols[1].style.width, "80px");
  assert.equal(cols[2].style.width, "90px");
  assert.equal(table.style.width, "440px");
  app.renderConfigTable();
  assert.equal(state.configTableNeedsRender, true);
  documentHandlers.pointerup(pointer(handles[0], 150));
  assert.equal(state.configResizing, null);
  assert.equal(state.pendingView.configColumnWidths["experiment-name"], 270);
  const originalFieldWidth = parseFloat(cols[1].style.width);
  const otherFieldWidth = cols[2].style.width;
  await documentHandlers.keydown({...pointer(handles[1], 0), key: "ArrowRight", shiftKey: true});
  assert.equal(state.configColumnWidths["config:a"], originalFieldWidth + 50);
  assert(!Object.prototype.hasOwnProperty.call(state.configColumnWidths, "config:b"));
  assert.equal(cols[2].style.width, otherFieldWidth);
  assert.equal(cols[0].style.width, "270px");
  documentHandlers.pointerdown(pointer(handles[1], 0));
  documentHandlers.pointermove(pointer(handles[1], 55));
  assert.equal(state.configColumnWidths["config:a"], originalFieldWidth + 105);
  documentHandlers.pointercancel(pointer(handles[1], 55));
  assert.equal(state.configColumnWidths["config:a"], originalFieldWidth + 50);
  await app.actions["reset-config-widths"]();
  assert.equal(Object.keys(state.configColumnWidths).length, 0);
  assert.equal(Object.keys(state.pendingView.configColumnWidths).length, 0);
  table.querySelectorAll = originalQuery;
  const viewport = element("config-table-scroll"), topScroll = element("config-top-scroll"), observers = [];
  const originalObserver = context.window.ResizeObserver;
  context.window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  try {
    Object.assign(viewport, {clientWidth: 350, scrollWidth: 1200, scrollLeft: 0, scrollTop: 0});
    app.renderConfigTable();
    assert(elements.get("view").innerHTML.includes('id="config-top-scroll"'));
    assert(!topScroll.hidden);
    assert.equal(topScroll.style.width, "350px");
    assert.equal(element("config-scroll-spacer").style.width, "1200px");
    topScroll.scrollLeft = 150; topScroll.onscroll();
    assert.equal(viewport.scrollLeft, 150);
    viewport.scrollLeft = 230; viewport.scrollTop = 75; viewport.onscroll();
    assert.equal(topScroll.scrollLeft, 230);
    app.renderConfigTable();
    assert.equal(viewport.scrollLeft, 230);
    assert.equal(viewport.scrollTop, 75);
    assert(observers[0].disconnected);
    assert(observers[1].targets.includes(table));
    viewport.scrollWidth = 1600; observers[1].callback();
    assert.equal(element("config-scroll-spacer").style.width, "1600px");
    viewport.clientWidth = 1800; observers[1].callback();
    assert(topScroll.hidden);
  } finally {
    if (state.configScrollObserver) state.configScrollObserver.disconnect();
    state.configScrollObserver = null;
    context.window.ResizeObserver = originalObserver;
    Object.assign(viewport, {clientWidth: 0, scrollWidth: 0, scrollLeft: 0, scrollTop: 0});
    state.configScrollLeft = 0; state.configScrollTop = 0;
  }
  state.configScalars = []; state.configOrder = [];
  console.log("Configuration UI: selectable paths, plain strings, scalar highlighting, baseline, exclusions, and drag/keyboard ordering verified");
}

async function fullPanelWorkflows() {
  const app = context.window.testApp, state = app.state;
  state.tab = "overview"; state.panels = ["loss", "reward"]; state.panelQuery = ""; state.showAllPanels = false;
  state.fullPanels = {}; state.options.group = "";
  let complete = false;
  const curve = y => ({id: "a", name: "a", member_ids: ["a"], x: y.map((unused, index) => index), y, count: y.map(() => 1), missing_members: 0});
  fullControls.push(...state.panels.map(tag => ({dataset: {fullPanel: tag}, innerHTML: ""})));
  context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    requests.push({url, body});
    let result;
    if (url === "/api/curves") { assert.equal(body.source, "tensorboard"); result = {source: "tensorboard", curves: Object.fromEntries(body.tags.map(tag => [tag, [curve([1, 2])]]))}; }
    else if (url === "/api/curves/all/jobs") { assert.deepEqual(Array.from(body.tags), ["loss"]); result = {id: "full", status: "running"}; }
    else if (url.endsWith("/cancel")) result = {status: "cancelled"};
    else if (url.endsWith("/result")) result = {source: "all-values", curves: {loss: [curve([9, 8, 7])]}};
    else result = {id: "full", status: complete ? "complete" : "running", percent: complete ? 100 : 30};
    return {ok: true, json: async () => result};
  };
  await app.renderOverview(state.serial);
  assert(!elements.get("view").innerHTML.includes('id="curve-source"'));
  assert(elements.get("view").innerHTML.includes("Load all values"));
  await app.actions["load-full-panel"]("loss");
  assert(fullControls[0].innerHTML.includes("Cancel · 30%"));
  assert.equal(state.pendingView.fullPanels, undefined);
  complete = true;
  state.overviewColors = {...state.overviewColors, a: "#127788"};
  state.hiddenOverviewCurves = state.hiddenOverviewCurves.concat("a");
  const originalReact = context.Plotly.react;
  context.Plotly.react = () => { throw "container is not an object"; };
  try {
    await app.pollFullPanel("loss", state.fullPanels.loss);
    assert.equal(state.fullPanels.loss.error, "container is not an object");
    assert.equal(element("toast").textContent, "container is not an object");
    assert(!fullControls[0].innerHTML.includes("All values loaded"));
    assert(fullControls[0].innerHTML.includes("Retry all values"));
  } finally { context.Plotly.react = originalReact; }
  const beforeRetry = requests.length;
  await app.actions["load-full-panel"]("loss");
  assert.equal(requests.length, beforeRetry, "A failed full-value redraw must retry the loaded observations without another read");
  assert.equal(state.fullPanels.loss.rendered, true);
  assert(!Object.prototype.hasOwnProperty.call(element("curve-0").layout.yaxis, "range"), "Unset ranges must be omitted from Plotly.react layouts");
  assert.deepEqual(Array.from(elements.get("curve-0").data[0].y), [9, 8, 7]);
  assert.equal(elements.get("curve-0").data[0].line.simplify, false);
  assert.equal(elements.get("curve-1").data[0].line.simplify, true);
  assert.equal(elements.get("curve-0").data[0].line.color, "#127788");
  assert.equal(elements.get("curve-0").data[0].visible, "legendonly");
  await app.actions["show-all-curves"]();
  assert.deepEqual(Array.from(elements.get("curve-1").data[0].y), [1, 2]);
  assert(fullControls[0].innerHTML.includes("All values loaded"));
  state.options.band = "range";
  await app.renderOverview(state.serial);
  assert.equal(state.fullPanels.loss, undefined);
  assert(fullControls[0].innerHTML.includes("Load all values"));
  complete = false;
  await app.actions["load-full-panel"]("loss");
  await app.actions["cancel-full-panel"]("loss");
  assert.equal(state.fullPanels.loss, undefined);
  assert(requests.some(item => item.url === "/api/curves/all/jobs/full/cancel"));
  const chart = elements.get("curve-0"), samples = Array.from({length: 100}, (unused, index) => 1 + index / 100).concat(1e9);
  chart.data[0].y = samples.slice(); chart.data[0].x = samples.map((unused, index) => index);
  chart.layout.xaxis.range = [10, 20];
  const loaded = requests.length;
  await app.expandPanel("loss");
  await documentHandlers.change({target: {id: "ignore-outliers", checked: true, dataset: {}, closest: () => null}});
  assert.equal(state.options.ignoreOutliers, true);
  assert.equal(state.pendingView.options.ignoreOutliers, true);
  assert(chart.layout.yaxis.range[1] < 3);
  assert.deepEqual(Array.from(chart.data[0].y), samples);
  assert.deepEqual(Array.from(chart.layout.xaxis.range), [10, 20]);
  assert.deepEqual(Array.from(elements.get("expanded-panel-plot").layout.yaxis.range), Array.from(chart.layout.yaxis.range));
  await app.setPanelLogY("loss", true);
  assert.equal(chart.layout.yaxis.type, "log");
  assert(chart.layout.yaxis.range[1] < 1);
  chart.handlers.plotly_relayout({"yaxis.autorange": true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chart.layout.yaxis.autorange, false);
  await app.setPanelLogY("loss", false);
  await documentHandlers.change({target: {id: "ignore-outliers", checked: false, dataset: {}, closest: () => null}});
  assert.equal(chart.layout.yaxis.autorange, true);
  assert.equal(chart.layout.yaxis.range, null);
  assert.equal(requests.length, loaded, "Outlier scaling must reuse loaded panel data");
  elements.get("panel-dialog").close();
  fullControls.length = 0;
  console.log("Overview fast loading: temporary per-panel full reads, progress, cancellation, and settings invalidation verified");
}

async function selectedPanelCoverage() {
  const app = context.window.testApp, state = app.state;
  state.tab = "overview"; state.panels = ["loss"]; state.panelQuery = ""; state.options.group = "";
  state.metricsLoading = false; state.fullPanels = {};
  state.runs = Array.from({length: 25}, (unused, index) => ({id: "run" + index, name: "Experiment " + index, path: "run" + index, config: {}, tags: [], loaded: true, metrics: index < 20 ? {loss: {last: 2}} : index === 24 ? {reward: {last: 1}} : {}}));
  state.selected = new Set(state.runs.map(item => item.id));
  let curves = state.runs.slice(0, 20).map(item => ({id: item.id, name: item.name, member_ids: [item.id], x: [0, 1], y: [1, 2], count: [1, 1], missing_members: 0}));
  context.fetch = async (url, options) => {
    assert.equal(url, "/api/curves");
    assert.equal(JSON.parse(options.body).experiment_ids.length, 25);
    return {ok: true, json: async () => ({source: "tensorboard", curves: {loss: curves}})};
  };
  await app.renderOverview(state.serial);
  assert.equal(elements.get("curve-0").data.length, 20);
  assert.equal(new Set(elements.get("curve-0").data.map(trace => trace.line.color)).size, 20, "Selected experiments must not collide in the old eight-color palette");
  assert(elements.get("curve-note-0").textContent.includes("20 of 25 selected experiments plotted"));
  const coverage = elements.get("curve-coverage-0").innerHTML;
  for (const index of [20, 21, 22, 23, 24]) assert(coverage.includes("Experiment " + index));
  assert(coverage.includes("No scalar values recorded"));
  assert(coverage.includes("This metric was not recorded"));
  state.metricsLoading = true;
  await app.renderOverview(state.serial);
  assert(elements.get("curve-coverage-0").innerHTML.includes("indexing logs"));
  state.metricsLoading = false;
  state.options.group = "selected";
  curves = [{id: "selected", name: "All selected", member_ids: state.runs.slice(0, 20).map(item => item.id), x: [], y: [], lower: [], upper: [], count: [], missing_members: 5}];
  await app.renderOverview(state.serial);
  assert(elements.get("curve-note-0").textContent.includes("0 of 25 selected experiments plotted"));
  assert(elements.get("curve-coverage-0").innerHTML.includes("No common overlap within the group"));
  state.options.group = "";
  console.log("Overview selection: all 25 selected IDs requested; every available curve drawn; missing data and empty group overlap disclosed");
}

async function overviewExperimentSearch() {
  const app = context.window.testApp, state = app.state, submitted = [], timers = new Map();
  const setTimeout = context.window.setTimeout, clearTimeout = context.window.clearTimeout;
  let sequence = 0;
  context.window.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, {callback, delay}); return id; };
  context.window.clearTimeout = id => timers.delete(id);
  const typeSearch = value => documentHandlers.input({target: {id: "run-search", value, closest: () => null}});
  const flushSearch = async () => {
    const pending = Array.from(timers.entries()).filter(([, timer]) => timer.delay === 250);
    assert.equal(pending.length, 1);
    timers.delete(pending[0][0]); await pending[0][1].callback();
  };
  try {
    state.workspace.state = {groups: [], ignored_configs: [], ignored_files: [], named_filters: []};
    state.runs = [
      {id: "alpha", name: "Baseline EXP001", path: "jobs/seed-one"},
      {id: "beta", name: "Candidate EXP002", path: "jobs/seed-two"},
      {id: "gamma", name: "Unselected EXP003", path: "jobs/seed-three"}
    ].map(item => ({...item, searchText: (item.name + " " + item.path).toLowerCase(), config: {}, tags: [], metrics: {loss: {}}, loaded: true}));
    state.selected = new Set(["alpha", "beta"]); state.baseline = "alpha";
    state.tab = "overview"; state.options.group = ""; state.query = ""; state.filters = []; state.collection = "all";
    state.panels = ["loss"]; state.tags = ["loss"]; state.showAllPanels = false; state.fullPanels = {};
    context.fetch = async (url, options) => {
      const body = options && options.body ? JSON.parse(options.body) : null;
      submitted.push({url, body});
      if (url.endsWith("/cancel")) return {ok: true, json: async () => ({status: "cancelled"})};
      if (url === "/api/curves/all/jobs") return {ok: true, json: async () => ({id: "search-full", status: "running"})};
      if (url === "/api/curves/all/jobs/search-full") return {ok: true, json: async () => ({id: "search-full", status: "running", percent: 10})};
      assert.equal(url, "/api/curves", "Typing must not rediscover experiment metrics");
      const curves = body.combine_selected ? [{id: "selected", name: "Selected experiments", member_ids: body.experiment_ids}] : body.experiment_ids.map(id => ({id, name: state.runs.find(item => item.id === id).name, member_ids: [id]}));
      return {ok: true, json: async () => ({source: "tensorboard", curves: {loss: curves.map(curve => ({...curve, x: [0, 1], y: [1, 2], lower: [1, 2], upper: [1, 2], count: [1, 1], missing_members: 0}))}})};
    };
    await app.renderView();
    assert.equal(elements.get("curve-0").data.length, 2);
    const defaultExperimentColors = new Map(elements.get("curve-0").data.map(trace => [trace.legendgroup, trace.line.color]));
    const previous = state.viewController;
    typeSearch("EXP0"); typeSearch("  exp001  ");
    assert.equal(previous.signal.aborted, true);
    await flushSearch();
    assert(elements.get("curve-0").data.every(trace => trace.line.color === defaultExperimentColors.get(trace.legendgroup)), "Filtering must preserve colors from the complete experiment selection");
    assert.deepEqual(Array.from(submitted.filter(item => item.url === "/api/curves").pop().body.experiment_ids), ["alpha"]);
    assert.equal(elements.get("curve-0").data.length, 1);
    assert(elements.get("view").innerHTML.includes("Showing 1 of 2 selected experiments"));
    assert(elements.get("curve-note-0").textContent.includes("1 of 1 selected experiments plotted"));
    assert.deepEqual(Array.from(state.selected), ["alpha", "beta"]);
    assert.equal(state.pendingView.query, "  exp001  ");
    await app.actions["load-full-panel"]("loss");
    assert.deepEqual(Array.from(submitted.find(item => item.url === "/api/curves/all/jobs").body.experiment_ids), ["alpha"]);
    typeSearch("jobs/seed-two"); await flushSearch();
    assert.equal(elements.get("curve-0").data[0].name, "Candidate EXP002");
    assert(submitted.some(item => item.url === "/api/curves/all/jobs/search-full/cancel"));
    state.options.group = "selected";
    await app.renderView();
    const grouped = submitted.filter(item => item.url === "/api/curves").pop().body;
    assert.equal(grouped.combine_selected, true);
    assert.deepEqual(Array.from(grouped.experiment_ids), ["beta"]);
    state.options.group = "";
    const beforeEmpty = submitted.length;
    typeSearch("EXP003"); await flushSearch();
    assert(elements.get("view").innerHTML.includes("No selected experiments match"));
    assert(elements.get("view").innerHTML.includes("Select matching experiments"));
    assert.equal(submitted.length, beforeEmpty);
    assert.deepEqual(Array.from(state.selected), ["alpha", "beta"]);
    await app.actions["clear-all-filters"]();
    assert.equal(elements.get("curve-0").data.length, 2);
    assert.equal(state.query, "");
    assert.deepEqual(Array.from(state.selected), ["alpha", "beta"]);
    state.filters = [{source: "path", key: "path", operator: "contains", value: "seed-one"}];
    await app.renderView();
    assert.equal(elements.get("curve-0").data[0].name, "Baseline EXP001");
    state.filters = [];
    assert(elements.get("view").innerHTML.includes('id="smoothing-value" type="number"'));
    const numeric = {id: "smoothing-value", dataset: {}, value: "0.9375", closest: () => null};
    documentHandlers.input({target: numeric});
    assert.equal(element("smoothing").value, "0.9375");
    await documentHandlers.change({target: numeric});
    assert.equal(state.options.smoothing, .9375);
    assert.equal(state.pendingView.options.smoothing, .9375);
    assert.equal(submitted.filter(item => item.url === "/api/curves").pop().body.smoothing, 0);
    const beforeInvalidSmoothing = submitted.length;
    for (const value of ["", "-0.1", "1", "Infinity"]) {
      numeric.value = value; await documentHandlers.change({target: numeric});
      assert.equal(state.options.smoothing, .9375);
      assert.equal(element("smoothing-value").value, "0.9375");
    }
    assert.equal(submitted.length, beforeInvalidSmoothing);
    const slider = {id: "smoothing", dataset: {}, value: "0.999", closest: () => null};
    documentHandlers.input({target: slider});
    assert.equal(element("smoothing-value").value, "0.999");
    await documentHandlers.change({target: slider});
    assert.equal(state.options.smoothing, .999);
    state.tags = ["A/first", "A/second", "Z/nested/target"];
    state.panels = state.tags.slice(); state.showAllPanels = true; state.collapsedPanelGroups = [];
    state.panelPageSize = 1; state.panelPage = 0;
    await app.renderView();
    assert(!elements.get("view").innerHTML.includes('data-action="show-panel-group"'));
    assert.deepEqual(Array.from(state.visiblePanelTags), state.tags);
    assert.equal(state.panelPage, 0);
    assert.equal(state.pendingView.panelPage, 0);
    assert.deepEqual(Array.from(state.visiblePanelTags), state.tags);
    assert.deepEqual(Array.from(submitted.filter(item => item.url === "/api/curves").pop().body.tags), state.tags);
    assert(elements.get("view").innerHTML.includes('title="Z/nested/target"'));
    state.panelPageSize = 16; state.panelPage = 0; state.showAllPanels = false; state.panels = ["loss"]; state.tags = ["loss"];
    console.log("Overview search: debounced names and paths filter plots, means, and full reads; selection retained and clearing restores curves");
  } finally {
    context.window.setTimeout = setTimeout; context.window.clearTimeout = clearTimeout;
  }
}

async function relationshipRegressions() {
  const app = context.window.testApp, state = app.state, calls = [], timers = new Map();
  const originalSetTimeout = context.window.setTimeout, originalClearTimeout = context.window.clearTimeout, originalController = context.AbortController;
  let timerId = 0, mode = "complete", holdStart = false, ignoreAbort = false, releaseStart, startFailures = 0, pollFailures = 0, resultFailures = 0;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  context.AbortController = class { constructor() { this.signal = {aborted: false}; } abort() { this.signal.aborted = true; if (this.signal.onabort) this.signal.onabort(); } };
  context.window.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; };
  context.window.clearTimeout = id => timers.delete(id);
  const result = {records: [{id: "first", name: "First", result: 2, config: {kind: "alpha"}}, {id: "second", name: "Second", result: 3, config: {kind: "beta"}}], associations: [], missing_metric: 0, note: "Descriptive"};
  const status = () => ({id: "relationships", status: mode, stage: "Computing outcomes", percent: mode === "complete" ? 100 : 40, elapsed: 1, error: mode === "error" ? "Outcome calculation failed" : null});
  context.fetch = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/cancel")) return {ok: true, json: async () => ({status: "cancelled"})};
    if (url.startsWith("/api/metrics/jobs")) return {ok: true, json: async () => url.endsWith("/result") ? {experiments: [], tags: ["loss", "reward"], config_keys: []} : {id: "relationship-metrics", status: "complete"}};
    if (url === "/api/relationships/jobs") {
      if (startFailures-- > 0) throw new Error("Server unavailable");
      if (holdStart) return new Promise((resolve, reject) => {
        const heldId = ignoreAbort ? "superseded" : "relationships";
        releaseStart = () => resolve({ok: true, json: async () => ({...status(), id: heldId})});
        options.signal.onabort = () => { if (ignoreAbort) return; const error = new Error("Aborted"); error.name = "AbortError"; reject(error); };
      });
      return {ok: true, json: async () => status()};
    }
    if (url.endsWith("/result")) {
      if (resultFailures-- > 0) throw new Error("Result connection lost");
      return {ok: true, json: async () => result};
    }
    if (pollFailures-- > 0) throw new Error("Progress connection lost");
    if (mode === "missing") return {ok: false, status: 404, json: async () => ({detail: "No such job"})};
    return {ok: true, json: async () => status()};
  };
  const reset = () => { app.cancelRelationships(); state.tab = "analysis"; state.metric = "loss"; state.relationshipMetric = ""; state.relationshipReduction = ""; state.relationshipSmoothing = null; state.configScalars = []; state.configOrder = []; state.associationScope = "configurations"; state.diffOnly = true; state.configQuery = ""; state.parallelKeysConfigured = false; state.reduction = "last"; state.analysisWindow = {}; state.selected = new Set(["first", "second"]); state.condition = "kind"; state.parallelKeys = ["kind"]; mode = "complete"; };
  const noSpinner = () => assert(!element("analysis-content").innerHTML.includes('class="spinner"'));
  const posts = () => calls.filter(url => url === "/api/relationships/jobs").length;
  try {
    reset();
    state.configScalars = [{id: "first", tag: "train/loss"}, {id: "second", tag: "eval/reward"}];
    assert.equal(app.relationshipRequest().metric, "train/loss");
    state.configOrder = ["scalar:second", "scalar:first"];
    assert.equal(app.relationshipRequest().metric, "eval/reward");
    state.relationshipMetric = "manual/metric";
    assert.equal(app.relationshipRequest().metric, "manual/metric");
    state.relationshipMetric = "";
    state.configScalars[1].tag = "eval/updated";
    assert.equal(app.relationshipRequest().metric, "eval/updated");
    state.configScalars = [];
    assert.equal(app.relationshipRequest().metric, "loss");
    assert.equal(app.relationshipRequest().condition_scope, "configurations");
    state.configQuery = "hindsight"; state.diffOnly = false;
    assert.equal(app.relationshipRequest().configuration_query, "hindsight");
    assert.equal(app.relationshipRequest().configuration_differences_only, false);
    state.associationScope = "all";
    assert.equal(app.relationshipRequest().condition_scope, "all");
    for (const [mode, reduction] of [["latest", "last"], ["latest_smoothed", "last_smoothed"], ["at_step", "at_step"], ["smoothed_at_step", "smoothed_at_step"]]) {
      state.configScalars = [{id: "configured", tag: "eval/reward", mode, step: mode.includes("step") ? 120 : null, smoothing: .85}];
      const request = app.relationshipRequest();
      assert.equal(request.metric, "eval/reward");
      assert.equal(request.reduction, reduction);
      assert.equal(request.smoothing, .85);
      assert.equal(request.at_step, mode.includes("step") ? 120 : null);
    }
    state.analysisWindow = {at_step: 42}; state.relationshipSmoothing = .2;
    assert.equal(app.relationshipRequest().at_step, 42);
    assert.equal(app.relationshipRequest().smoothing, .2);
    state.relationshipReduction = "best";
    assert.equal(app.relationshipRequest().reduction, "best");
    state.relationshipReduction = ""; state.analysisWindow = {}; state.relationshipSmoothing = null;
    assert.equal(app.relationshipRequest().reduction, "smoothed_at_step");
    assert.equal(app.relationshipRequest().at_step, 120);
    assert.equal(app.relationshipRequest().smoothing, .85);
    reset(); holdStart = true;
    const pending = app.renderAnalysis(state.serial);
    assert(state.relationshipStarting);
    assert(element("analysis-content").innerHTML.includes("Submitting relationship analysis"));
    const before = posts();
    await app.renderAnalysis(state.serial);
    assert.equal(posts(), before);
    holdStart = false; releaseStart(); await pending;
    assert(state.analysis);
    assert(element("analysis-content").innerHTML.includes("Condition associations"));
    assert(element("analysis-content").innerHTML.includes("https://en.wikipedia.org/wiki/Spearman%27s_rank_correlation_coefficient"));
    assert(element("analysis-content").innerHTML.includes("https://en.wikipedia.org/wiki/Correlation_ratio"));
    assert(calls.some(url => url.endsWith("/result")), "Already-completed jobs must retrieve their results");
    state.tab = "runs"; state.tab = "analysis"; await app.renderAnalysis(state.serial);
    assert.equal(posts(), before, "Navigation must reuse unchanged results");

    reset(); startFailures = 1;
    await app.renderAnalysis(state.serial);
    assert(state.relationshipError.includes("Server unavailable")); noSpinner();
    const failedPosts = posts(); await app.renderAnalysis(state.serial);
    assert.equal(posts(), failedPosts, "A visible error must persist until Retry");
    await app.actions["retry-relationships"](); assert(state.analysis);

    reset(); pollFailures = 1;
    await app.renderAnalysis(state.serial);
    assert(state.relationshipError.includes("Progress connection lost")); noSpinner();
    const pollPosts = posts(); await app.actions["retry-relationships"]();
    assert(state.analysis); assert.equal(posts(), pollPosts);

    reset(); resultFailures = 1;
    await app.renderAnalysis(state.serial);
    assert(state.relationshipError.includes("Result connection lost")); noSpinner();
    await app.actions["retry-relationships"](); assert(state.analysis);

    reset(); mode = "error";
    await app.renderAnalysis(state.serial);
    assert.equal(state.relationshipJob, null);
    assert(state.relationshipError.includes("Outcome calculation failed")); noSpinner();
    mode = "complete"; await app.actions["retry-relationships"](); assert(state.analysis);

    reset(); mode = "missing";
    await app.renderAnalysis(state.serial);
    assert.equal(state.relationshipJob, null);
    assert(state.relationshipError.includes("no longer available")); noSpinner();
    mode = "complete"; await app.actions["retry-relationships"](); assert(state.analysis);

    reset(); context.window.Plotly = false;
    await app.renderAnalysis(state.serial);
    assert(state.relationshipError.includes("Could not display")); noSpinner();
    context.window.Plotly = true;
    const renderPosts = posts(); await app.actions["retry-relationships"]();
    assert.equal(posts(), renderPosts);
    assert(element("analysis-content").innerHTML.includes("Condition associations"));

    reset(); holdStart = true;
    const timeout = app.renderAnalysis(state.serial);
    await tick();
    const deadline = Array.from(timers.values()).find(timer => timer.delay === 30000);
    assert(deadline); deadline.callback(); await timeout;
    assert(state.relationshipError.includes("timed out")); noSpinner();
    holdStart = false; await app.actions["retry-relationships"](); assert(state.analysis);

    reset(); mode = "running";
    await app.renderAnalysis(state.serial);
    assert(element("analysis-content").innerHTML.includes("40%"));
    state.tab = "runs"; mode = "complete";
    await app.pollRelationships("relationships");
    assert(state.analysis, "Completion while another view is open must be retained");
    state.tab = "analysis"; await app.renderAnalysis(state.serial);
    assert(element("analysis-content").innerHTML.includes("Condition associations"));

    reset(); holdStart = true; ignoreAbort = true;
    const obsolete = app.renderAnalysis(state.serial);
    await tick(); const oldRelease = releaseStart;
    state.metric = "reward"; holdStart = false;
    await app.renderAnalysis(state.serial);
    oldRelease(); await obsolete;
    assert(state.analysis, "Superseded submissions cannot replace current results");
    assert(calls.some(url => url.endsWith("/cancel")));

    reset(); mode = "running";
    await app.renderAnalysis(state.serial);
    const selectionPosts = posts(), cancels = calls.filter(url => url.endsWith("/cancel")).length;
    state.selected = new Set(["first"]);
    const changing = app.selectionChanged();
    assert.equal(calls.filter(url => url.endsWith("/cancel")).length, cancels + 1, "Selection changes must cancel obsolete outcomes before metric discovery finishes");
    await changing; await tick();
    assert.equal(posts(), selectionPosts + 1, "Concurrent discovery completion must not duplicate outcome jobs");

    reset();
    const values = ["001", "10", 'O\'Brien "trial" & <b>literal</b>', 1, "1"];
    state.analysis = {records: values.map((value, index) => ({id: String(index), name: "Run " + index, result: index, config: {kind: value}})), associations: []};
    await app.renderCondition(); await app.renderParallel();
    const chart = element("condition-chart");
    assert.equal(chart.layout.xaxis.type, "category");
    assert.deepEqual(Array.from(chart.layout.xaxis.ticktext), ["001", "10", 'O\'Brien "trial" &amp; &lt;b&gt;literal&lt;/b&gt;', "1", "1"]);
    assert.equal(new Set(chart.data.map(trace => trace.x[0])).size, values.length);
    assert.equal(chart.data[0].name, "001");
    assert(chart.data.every(trace => !trace.name.includes("&quot;") && !trace.name.includes("&#39;")));
    assert.deepEqual(Array.from(element("parallel-chart").data[0].dimensions[0].ticktext), Array.from(chart.layout.xaxis.ticktext));
    state.parallelKeys = []; state.parallelKeysConfigured = true;
    await app.renderAnalysis(state.serial);
    assert.equal(state.parallelKeys.length, 0, "An explicit empty dimension choice must not be replaced by defaults");
    assert(element("parallel-chart").innerHTML.includes("Choose varying dimensions"));
    await app.actions["reset-parallel"]();
    assert(state.parallelKeys.length > 0);
    const originalReact = context.Plotly.react;
    context.Plotly.react = (target, traces, layout) => target === element("parallel-chart") ? Promise.reject(new Error("Rendering failed")) : originalReact(target, traces, layout);
    await app.renderParallel();
    assert.equal(element("parallel-error").hidden, false);
    assert(element("parallel-error").innerHTML.includes("Rendering failed"));
    context.Plotly.react = originalReact;
    await app.actions["retry-parallel"]();
    assert.equal(element("parallel-error").hidden, true);
    element("parallel-chart").data[0].dimensions[0].constraintrange = [0, 0];
    element("parallel-chart").handlers.plotly_restyle();
    assert(state.brushed.length > 0);
    await app.actions["clear-parallel-brush"]();
    assert.equal(state.brushed.length, 0);
    assert.equal(element("apply-brush").disabled, true);
    await app.actions["cancel-relationships"]();
    assert.equal(state.relationshipJob, null); assert(state.relationshipError.includes("cancelled")); noSpinner();
  } finally {
    app.cancelRelationships(); context.window.Plotly = true;
    context.window.setTimeout = originalSetTimeout; context.window.clearTimeout = originalClearTimeout; context.AbortController = originalController;
  }
}

async function conditionGroupingControls() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousFetch = context.fetch;
  const requests = [], results = new Map();
  const records = Array.from({length: 6}, (unused, index) => ({id: "group" + index, name: "Run " + index, result: index, config: {numeric: Math.floor(index / 2) + 1, ...(index < 5 ? {nullable: index === 4 ? null : Math.floor(index / 2) + 1} : {})}}));
  try {
    Object.assign(state, {workspace: {name: "Grouping", settings: {appearance: {}}, state: {groups: [], ignored_configs: [], ignored_files: [], named_filters: []}},
      runs: records.map(record => ({...record, path: record.id, metrics: {}, tags: []})), selected: new Set(records.map(record => record.id)), tab: "analysis",
      tags: ["loss"], summaryTags: [], metric: "loss", relationshipMetric: "", relationshipReduction: "", relationshipSmoothing: null,
      categoricalConditions: [], excludedMissingConditions: [], separateNullConditions: [], configScalars: [], configOrder: [], associationScope: "all",
      analysis: null, analysisWindow: {}, relationshipKey: "", relationshipJob: null, relationshipStarting: false, relationshipError: "",
      condition: "numeric", parallelKeys: ["numeric", "nullable"], parallelKeysConfigured: true});
    context.fetch = async (url, options) => {
      if (url === "/api/relationships/jobs") {
        const body = JSON.parse(options.body); requests.push(body);
        const id = "grouping-" + requests.length;
        results.set(id, {metric: "loss", records, condition_keys: ["numeric", "nullable"], missing_metric: 0, note: "Grouped", ...body,
          associations: [{key: "numeric", kind: body.categorical_conditions.includes("numeric") ? "categorical" : "numeric", count: 6, association: .5, pearson: .4, spearman: .5}]});
        return {ok: true, json: async () => ({id, status: "complete", percent: 100, elapsed: 0})};
      }
      const id = url.split("/")[4];
      return {ok: true, json: async () => url.endsWith("/result") ? results.get(id) : {id, status: "complete", percent: 100, elapsed: 0}};
    };
    const change = (id, values) => documentHandlers.change({target: {id, dataset: {}, closest: () => null, ...values}});
    await app.renderAnalysis(state.serial);
    assert.equal(element("condition-chart").data[0].type, "scatter");
    await change("condition-type", {value: "categorical"});
    assert(element("condition-chart").data.some(trace => trace.type === "box"));
    assert.equal(element("condition-chart").data.filter(trace => trace.type === "scatter").length, 1);
    assert(state.pendingView.categoricalConditions.includes("numeric"));
    assert(requests[requests.length - 1].categorical_conditions.includes("numeric"));
    await change("condition-select", {value: "nullable"});
    assert.equal(element("condition-type").value, "auto");
    assert(element("condition-missing").checked);
    assert(element("condition-merge-null").checked && !element("condition-merge-null").disabled);
    const merged = element("condition-chart").data.find(trace => trace.name === "(missing or null)");
    assert(merged && merged.y.length === 2);
    assert.equal(element("parallel-chart").data[0].dimensions[1].values[4], element("parallel-chart").data[0].dimensions[1].values[5]);
    await change("condition-missing", {checked: false});
    assert(element("condition-merge-null").disabled);
    assert(!element("condition-chart").data.some(trace => trace.name === "(missing or null)"));
    assert(state.pendingView.excludedMissingConditions.includes("nullable"));
    assert(requests[requests.length - 1].excluded_missing_conditions.includes("nullable"));
    await change("condition-missing", {checked: true});
    assert(!state.pendingView.excludedMissingConditions.length);
    await change("condition-merge-null", {checked: false});
    assert(element("condition-chart").data.some(trace => trace.name === "(missing)" && trace.y.length === 1));
    assert(element("condition-chart").data.some(trace => trace.name === "null" && trace.y.length === 1));
    assert(state.pendingView.separateNullConditions.includes("nullable"));
    assert(requests[requests.length - 1].separate_null_conditions.includes("nullable"));
    await change("condition-select", {value: "numeric"});
    assert.equal(element("condition-type").value, "categorical");
    assert(element("condition-missing").checked);
    await change("condition-type", {value: "auto"});
    assert.equal(element("condition-chart").data[0].type, "scatter");
    assert(!requests[requests.length - 1].categorical_conditions.length);
  } finally { app.cancelRelationships(); Object.assign(state, previous); context.fetch = previousFetch; }
}

async function jsonSummaryRegressions() {
  const app = context.window.testApp, state = app.state, previousFetch = context.fetch;
  const previous = {tags: state.tags, summaryTags: state.summaryTags, configScalars: state.configScalars, configOrder: state.configOrder, comparison: state.comparison, metric: state.metric};
  const tag = "JSON/evaluation_metrics/Success rate";
  const data = {metric: tag, reduction: "last", summary_only: true, records: [{id: "first", name: "First", result: .9, config: {seed: 1}}, {id: "second", name: "Second", result: .8, config: {seed: 2}}], associations: [], condition_keys: ["seed"], missing_metric: 0, note: "Summary"};
  context.fetch = async url => ({ok: true, json: async () => url === "/api/json-metrics" ? {paths: ["{experiment}/evaluation_metrics.json"], matched_experiments: 2, metric_values: 2, summary_tags: [tag], warnings: [], errors: []} : url.endsWith("/result") ? data : {id: "json-summary", status: "complete", percent: 100, elapsed: 0}});
  try {
    state.tags = []; state.summaryTags = [tag]; state.metric = tag; state.tab = "configs";
    state.relationshipMetric = ""; state.relationshipReduction = "";
    state.configQuery = ""; state.analysisWindow = {};
    state.selected = new Set(["first", "second"]);
    state.configScalars = [{id: "json", tag, mode: "latest", step: null, smoothing: .4}];
    state.configOrder = ["scalar:json"];
    state.comparison = {experiments: [{id: "first", name: "First"}, {id: "second", name: "Second"}], rows: [{id: "scalar:json", kind: "scalar", key: tag, scalar: state.configScalars[0], cells: [{present: true, value: .9}, {present: true, value: .8}]}]};
    app.renderConfigTable();
    assert(!element("view").innerHTML.includes('data-action="add-config-scalar" disabled'));
    app.actions["add-config-scalar"]();
    assert(element("dialog").innerHTML.includes('value="' + tag + '"'));
    await app.actions["json-metrics"]();
    assert(element("dialog").innerHTML.includes("{experiment}/evaluation_metrics.json"));
    assert(element("dialog").innerHTML.includes("2 summary values"));
    assert(element("dialog").innerHTML.includes("automatically loaded"));
    const controls = [{disabled: false}, {disabled: false}], previousQuery = element("dialog").querySelectorAll;
    let posts = 0, failed = false;
    element("dialog").querySelectorAll = () => controls;
    context.fetch = async (url, options) => {
      if (url === "/api/json-metrics/jobs") {
        posts += 1;
        assert(element("json-metric-status").innerHTML.includes("JSON metric loading progress"));
        assert(controls.every(control => control.disabled));
        assert.deepEqual(JSON.parse(options.body), {paths: ["scores.json"]});
      }
      return {ok: true, json: async () => ({id: "json-load", status: failed ? "error" : "running", percent: 40, stage: "Loading JSON source 2 of 5", metric: "exp002/scores.json", elapsed: 2, error: failed ? "Invalid metric source" : null})};
    };
    try {
      await app.loadJSONMetrics(["scores.json"]);
      assert(state.jsonMetricLoading);
      assert(element("json-metric-status").innerHTML.includes('value="40"'));
      assert(element("json-metric-status").innerHTML.includes("exp002/scores.json"));
      await app.loadJSONMetrics(["scores.json"]);
      assert.equal(posts, 1);
      failed = true; await app.pollJSONMetrics();
      assert(!state.jsonMetricLoading && !state.jsonMetricJob);
      assert(element("json-metric-status").innerHTML.includes("Invalid metric source"));
      assert(controls.every(control => !control.disabled));
    } finally {
      element("dialog").querySelectorAll = previousQuery;
    }
    context.fetch = async url => ({ok: true, json: async () => url.endsWith("/result") ? data : {id: "json-summary", status: "complete", percent: 100, elapsed: 0}});
    state.tab = "analysis";
    await app.renderAnalysis(state.serial);
    assert(element("view").innerHTML.includes('value="' + tag + '"'));
    const conditions = element("analysis-content").innerHTML.split('id="condition-select"')[1].split("</select>")[0];
    assert(conditions.includes("seed"));
    assert(!conditions.includes("JSON/"));
    assert.equal(app.relationshipRequest().metric, tag);
    assert.equal(app.relationshipRequest().reduction, "last");
    state.relationshipReduction = "mean"; state.analysisWindow = {start_step: 100, end_step: 200};
    assert.equal(app.relationshipRequest().reduction, "last");
    assert.equal(app.relationshipRequest().start_step, null);
    assert.equal(app.relationshipRequest().end_step, null);
  } finally {
    app.cancelRelationships(); Object.assign(state, previous); context.fetch = previousFetch;
  }
}

async function jsonChoicesBeforeTensorBoard() {
  const app = context.window.testApp, state = app.state, previous = {...state};
  const previousFetch = context.fetch, previousQuery = element("dialog").querySelectorAll;
  const tag = "JSON/evaluation_metrics/Success rate", secondTag = "JSON/evaluation_metrics/Joint error (rad)";
  const runs = [tag, secondTag].map((metric, index) => ({id: String(index), name: "Experiment " + index, path: "exp00" + index, config: {seed: index}, tags: [], archived: false, metrics: {[metric]: {last: index + .5, summary_only: true}}}));
  try {
    Object.assign(state, {
      workspace: {name: "JSON test", logdir: "/logs", state_file: "/logs/.expman/state.json", settings: {appearance: {}}, state: {groups: [], ignored_configs: [], ignored_files: [], named_filters: []}},
      runs, selected: new Set(["0"]), tags: [], summaryTags: [], tab: "runs", comparison: null,
      metricsJob: null, metricsSelectionKey: "", relationshipKey: "", relationshipJob: null,
      relationshipStarting: false, relationshipError: "", configScalarJob: null, configScalars: [],
      fullPanels: {}, query: "", filters: [], activeFilter: "", collection: "all", analysis: null
    });
    context.fetch = async url => {
      if (url === "/api/metrics/preview") throw new Error("TensorBoard index not ready");
      assert(url.startsWith("/api/metrics/jobs") || url.startsWith("/api/relationships/jobs"), url);
      return {ok: true, json: async () => ({id: url.includes("relationships") ? "pending-relationship" : "pending-metrics", status: "running", percent: 0, stage: "Indexing", elapsed: 1})};
    };
    await app.selectionChanged();
    assert(state.metricsLoading);
    assert.deepEqual(Array.from(state.summaryTags), [tag]);
    state.comparison = {experiments: [runs[0]], rows: []};
    app.renderConfigTable();
    assert(!element("view").innerHTML.includes('data-action="add-config-scalar" disabled'));
    app.configScalarDialog();
    assert(element("dialog").innerHTML.includes('value="' + tag + '"'));
    assert(element("dialog").innerHTML.includes("Add scalar"));
    const metricControl = {value: tag, innerHTML: ""};
    element("dialog").querySelectorAll = selector => selector === 'select[name="scalar_tag"]' ? [metricControl] : [];
    state.selected = new Set(["1"]);
    await app.selectionChanged();
    assert(state.metricsLoading);
    assert.deepEqual(Array.from(state.summaryTags), [secondTag]);
    assert.equal(metricControl.value, tag);
    assert(metricControl.innerHTML.includes(secondTag));
    state.tab = "analysis"; state.metric = secondTag; state.relationshipMetric = "";
    await app.renderAnalysis(state.serial);
    assert(element("view").innerHTML.includes('value="' + secondTag + '"'));
    assert.equal(app.relationshipRequest().metric, secondTag);
    assert.equal(app.relationshipRequest().reduction, "last");
  } finally {
    app.cancelRelationships();
    Object.assign(state, previous); context.fetch = previousFetch;
    element("dialog").querySelectorAll = previousQuery;
  }
}

async function configExclusionRaces() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousFetch = context.fetch;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const copy = value => JSON.parse(JSON.stringify(value));
  const writes = [], reads = [], spec = {id: "loss", tag: "loss", mode: "latest", step: null, smoothing: .4};
  const server = {groups: [], ignored_configs: ["already.hidden"], ignored_files: [], named_filters: []};
  const comparison = showIgnored => ({experiments: ["a", "b"].map(id => ({id, name: id})), rows: ["already.hidden", "model.name", "seed", "kept"].map(key => ({key, kind: "config", different: true, ignored: server.ignored_configs.includes(key), cells: [{present: true, value: 1}, {present: true, value: 2}]})).filter(row => showIgnored || !row.ignored)});
  try {
    Object.assign(state, {
      workspace: {name: "Race test", settings: {appearance: {}}, state: copy(server)},
      runs: ["a", "b"].map(id => ({id, name: id, config: {}, tags: [], metrics: {}, path: id})),
      selected: new Set(["a", "b"]), baseline: "a", tab: "configs", diffOnly: false, showIgnored: false,
      configOrder: [], configQuery: "", configPage: 0, comparison: comparison(false), configResizing: null,
      configScalars: [spec], scalarEpoch: 0, configScalarJob: null, configExclusionQueue: null,
      configCompareRequest: 0, options: {...state.options, group: "", groupKeys: []}
    });
    state.configScalarValues = {key: JSON.stringify([["a", "b"], [spec], 0]), experiment_ids: ["a", "b"], rows: [{id: "scalar:loss", key: "loss", kind: "scalar", scalar: spec, cells: [{present: true, value: 3}, {present: true, value: 4}]}]};
    context.fetch = (url, options) => {
      const body = JSON.parse(options.body);
      return new Promise(resolve => {
        if (url === "/api/ignored-configs") writes.push({body, finish(error) {
          if (error) resolve({ok: false, json: async () => ({detail: error})});
          else { Object.assign(server, {ignored_configs: body.patterns, ignored_files: body.files}); resolve({ok: true, json: async () => copy(server)}); }
        }});
        else {
          assert.equal(url, "/api/compare");
          const snapshot = copy(comparison(body.show_ignored));
          reads.push({finish() { resolve({ok: true, json: async () => snapshot}); }});
        }
      });
    };
    const stale = app.renderConfigs(state.serial);
    const first = app.actions["ignore-key"]("seed"), second = app.actions["ignore-key"]("model.name");
    await tick();
    assert.equal(writes.length, 1, "Rapid ignore clicks must serialize saves");
    writes[0].finish(); await tick();
    assert(!app.configurationRows().some(row => row.key === "seed"));
    assert.deepEqual(writes[1].body.patterns, ["already.hidden", "seed", "model.name"]);
    writes[1].finish(); await tick();
    state.configScalarValues.rows[0].cells[0].value = 9;
    reads[2].finish(); await second;
    reads[1].finish(); await first;
    reads[0].finish(); await stale;
    assert.deepEqual(Array.from(state.workspace.state.ignored_configs), ["already.hidden", "seed", "model.name"]);
    assert(!app.configurationRows().some(row => ["seed", "model.name", "already.hidden"].includes(row.key)));
    assert.equal(state.comparison.rows.find(row => row.kind === "scalar").cells[0].value, 9);
    state.showIgnored = true;
    const inspect = app.renderConfigs(state.serial); reads[3].finish(); await inspect; await tick();
    assert(app.configurationRows().some(row => row.key === "seed" && row.ignored));
    assert(element("view").innerHTML.includes('data-config-include="seed"  aria-label="Include configuration seed"'));
    state.showIgnored = false; app.renderConfigTable();
    assert(!element("view").innerHTML.includes('data-config-include="seed"'));
    const failed = app.actions["ignore-key"]("failed.path").then(() => assert.fail("Expected a failed save"), error => error.message);
    const next = app.actions["ignore-key"]("next.path");
    await tick(); writes[2].finish("Cannot save exclusions"); await tick();
    assert.equal(await failed, "Cannot save exclusions");
    assert(!writes[3].body.patterns.includes("failed.path"));
    assert(writes[3].body.patterns.includes("seed"));
    writes[3].finish(); await tick(); reads[4].finish(); await next;
    assert(state.workspace.state.ignored_configs.includes("next.path"));
    server.ignored_files = ["hparams.yml", "extra.json"];
    state.workspace.state.ignored_files = server.ignored_files.slice();
    state.runs.forEach(run => { run.config = {seed: 1}; run.config_files = ["123/hparams.yml"]; });
    state.showIgnored = true;
    let readIndex = reads.length;
    const show = app.renderConfigs(state.serial); reads[readIndex].finish(); await show;
    const seedCheckbox = () => element("view").innerHTML.match(/<input[^>]*data-config-include="seed"[^>]*>/)[0];
    assert(!seedCheckbox().includes(" checked"));
    const dialogBefore = element("dialog").innerHTML;
    let writeIndex = writes.length; readIndex = reads.length;
    const restore = documentHandlers.change({target: {id: "", dataset: {configInclude: "seed"}, checked: true}});
    await tick(); writes[writeIndex].finish(); await tick(); reads[readIndex].finish(); await restore;
    assert(!state.workspace.state.ignored_configs.includes("seed"));
    assert(state.workspace.state.ignored_configs.includes("model.name"));
    assert.deepEqual(Array.from(state.workspace.state.ignored_files), ["extra.json"]);
    assert(seedCheckbox().includes(" checked"));
    assert.equal(element("dialog").innerHTML, dialogBefore, "Checking restores a configuration without opening a dialog");
    assert.equal(state.comparison.rows.find(row => row.kind === "scalar").cells[0].value, 9);
    writeIndex = writes.length;
    const rejected = documentHandlers.change({target: {id: "", dataset: {configInclude: "seed"}, checked: false}});
    await tick(); writes[writeIndex].finish("Cannot save exclusions"); await rejected;
    assert(seedCheckbox().includes(" checked"));
    assert(!state.workspace.state.ignored_configs.includes("seed"));
  } finally { Object.assign(state, previous); context.fetch = previousFetch; }
}

async function overviewLegendAndElapsed() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousFetch = context.fetch;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let calls = 0, omitGroup = false;
  const tags = ["Train/loss", "Train/reward"];
  const curves = [
    {id: "first", name: "First", member_ids: ["first"], missing_members: 0, x: [0, 1], y: [1, 2], original_y: [1, 7], lower: [1, 2], upper: [1, 2], count: [1, 1], elapsed: [0, 3661]},
    {id: "group", name: "Group", member_ids: ["second", "third"], missing_members: 0, x: [0, 1], y: [3, 4], original_y: [3, 12], lower: [2, 3], upper: [4, 5], count: [2, 2], elapsed: [65, 3726]}
  ];
  try {
    Object.assign(state, {workspace: {name: "Legend", logdir: "/logs", settings: {appearance: {}}, state: {groups: [{id: "first", name: "First", experiment_ids: ["first"]}, {id: "group", name: "Group", experiment_ids: ["second", "third"]}], ignored_configs: [], ignored_files: [], named_filters: []}},
      runs: ["first", "second", "third"].map(id => ({id, name: id, path: id, config: {}, metrics: {}, tags: [], warnings: [], modified: 0})), selected: new Set(["first", "second", "third"]),
      tab: "overview", tags, panels: tags, showAllPanels: false, panelPage: 0, panelQuery: "", query: "", filters: [], collection: "all", metricsLoading: false,
      overviewColors: {}, panelSmoothing: {}, panelData: new Map(), hiddenOverviewCurves: [], overviewLegendEntries: new Map(), overviewLegendSignature: "", expandedPanel: null, options: {...state.options, x_axis: "step", group: "saved", ignoreOutliers: false}, fullPanels: {}});
    context.fetch = async (url, options) => {
      if (url === "/api/curves/groups") return {ok: true, json: async () => curves};
      assert.equal(url, "/api/curves"); calls += 1;
      const request = JSON.parse(options.body);
      const matching = (omitGroup ? curves.slice(0, 1) : curves).filter(curve =>
        (!request.group_ids || request.group_ids.includes(curve.id)) && curve.member_ids.some(id => request.experiment_ids.includes(id)));
      return {ok: true, json: async () => ({curves: Object.fromEntries(tags.map((tag, index) => [tag, index ? matching.slice().reverse() : matching]))})};
    };
    await app.renderOverview(state.serial);
    const first = element("curve-0"), other = element("curve-1");
    assert.equal((element("view").innerHTML.match(/id="overview-legend"/g) || []).length, 1);
    assert(!element("view").innerHTML.includes('data-action="show-all-curves"'));
    assert.equal((element("overview-legend").innerHTML.match(/data-action="show-all-curves"/g) || []).length, 1);
    assert.equal((element("overview-legend").innerHTML.match(/data-overview-color=/g) || []).length, 2);
    assert.equal(first.layout.showlegend, false);
    assert.equal(other.layout.showlegend, false);
    for (const id of ["saved:first", "saved:group"]) legendNames.push({dataset: {action: "toggle-overview-curve", value: id}, classList: {toggle(name, enabled) { this[name] = enabled; }}, setAttribute(name, value) { this[name] = value; }});
    const picker = {id: "", dataset: {overviewColor: "saved:first"}, value: "#123ABC"};
    legendColors.push(picker); legendShowAll.push({disabled: true});
    const means = first.data.filter(trace => trace.showlegend !== false);
    assert(means.every(trace => !trace.hovertemplate.includes("<br>")));
    assert(means.every(trace => trace.hovertemplate.endsWith("<extra></extra>")));
    assert.equal(means[0].customdata[1][1], "01:01:01");
    assert.equal(means[0].customdata[1][2], 7);
    assert.equal(means[1].customdata[1][2], 12);
    assert(means[0].hovertemplate.includes("Smoothed %{y:.6g}"));
    assert(means[0].hovertemplate.includes("Original %{customdata[2]:.6g}"));
    assert(means[1].hovertemplate.includes("Smoothed mean %{y:.6g}"));
    assert(means[1].hovertemplate.includes("Original mean %{customdata[2]:.6g}"));
    assert(means[1].hovertemplate.includes("Mean elapsed"));
    const before = calls;
    first.layout.xaxis.range = [0.2, 0.7];
    first.layout.yaxis.range = [0.5, 2.5]; first.layout.yaxis.autorange = false;
    await documentHandlers.change({target: picker});
    assert.deepEqual(Array.from(first.layout.yaxis.range), [0.5, 2.5]);
    assert.equal(first.layout.yaxis.autorange, false);
    assert.equal(state.overviewColors["saved:first"], "#123abc");
    assert.equal(first.data[0].line.color, "#123abc");
    assert.equal(other.data.find(trace => trace.legendgroup === "saved:first").line.color, "#123abc");
    assert(first.data.every(trace => trace.visible === true));
    documentHandlers.click({target: {closest: () => legendNames[0]}}); await tick();
    assert(first.data.every(trace => trace.visible === (trace.legendgroup === "saved:first" ? "legendonly" : true)));
    assert(other.data.every(trace => trace.visible === (trace.legendgroup === "saved:first" ? "legendonly" : true)));
    assert.equal(legendNames[0]["aria-pressed"], "false");
    assert(legendNames[0].classList["is-hidden"]);
    assert.equal(legendShowAll[0].disabled, false);
    assert.deepEqual(Array.from(first.layout.xaxis.range), [0.2, 0.7]);
    assert.deepEqual(Array.from(state.pendingView.hiddenOverviewCurves), ["saved:first"]);
    assert.equal(state.pendingView.overviewColors["saved:first"], "#123abc");
    assert.deepEqual(Array.from(state.selected), ["first", "second", "third"]);
    await app.expandPanel(tags[0]);
    const expanded = element("expanded-panel-plot");
    assert.equal(element("overview-legend").parentNode, element("expanded-legend-slot"));
    assert(!element("panel-dialog").innerHTML.includes('id="overview-legend"'));
    assert.equal(expanded.layout.showlegend, false);
    assert.equal(expanded.data[0].customdata[1][2], 7);
    assert.equal(expanded.data[0].hovertemplate, means[0].hovertemplate);
    assert(expanded.data.every(trace => trace.visible === (trace.legendgroup === "saved:first" ? "legendonly" : true)));
    await app.actions["toggle-overview-curve"]("saved:group");
    assert([first, other, expanded].every(target => target.data.every(trace => trace.visible === "legendonly")));
    await documentHandlers.change({target: {id: "", dataset: {overviewColor: "saved:group"}, value: "#ff0088"}});
    for (const target of [first, other, expanded]) {
      assert(target.data.filter(trace => trace.legendgroup === "saved:group").every(trace => trace.line.color === "#ff0088"));
      assert.equal(target.data.find(trace => trace.fill === "tonexty").fillcolor, "rgba(255,0,136,0.12)");
    }
    await app.actions["toggle-overview-curve"]("saved:first");
    assert([first, other, expanded].every(target => target.data.every(trace => trace.visible === (trace.legendgroup === "saved:group" ? "legendonly" : true))));
    await app.actions["show-all-curves"]();
    assert(first.data.every(trace => trace.visible === true));
    assert(expanded.data.every(trace => trace.visible === true));
    assert.equal(legendNames[0]["aria-pressed"], "true");
    assert.equal(legendShowAll[0].disabled, true);
    const setTimer = context.window.setTimeout, clearTimer = context.window.clearTimeout, timers = new Map();
    let sequence = 0;
    context.window.setTimeout = (callback, delay) => { const timer = ++sequence; timers.set(timer, {callback, delay}); return timer; };
    context.window.clearTimeout = timer => timers.delete(timer);
    const mouseClick = (index, detail) => documentHandlers.click({detail, target: {closest: () => legendNames[index]}});
    const doubleClick = index => documentHandlers.dblclick({target: {closest: () => legendNames[index]}, preventDefault() {}});
    const flushClicks = async () => {
      for (const [timer, pending] of Array.from(timers)) if (pending.delay === 300) { timers.delete(timer); pending.callback(); }
      await tick();
    };
    try {
      mouseClick(0, 1);
      assert(first.data.every(trace => trace.visible === true));
      mouseClick(0, 2); doubleClick(0); await tick();
      assert(!Array.from(timers.values()).some(timer => timer.delay === 300));
      assert([first, other, expanded].every(target => target.data.every(trace => trace.visible === (trace.legendgroup === "saved:first" ? true : "legendonly"))));
      mouseClick(0, 1); await flushClicks();
      assert(first.data.every(trace => trace.visible === "legendonly"));
      mouseClick(0, 2); doubleClick(0); await tick();
      assert([first, other, expanded].every(target => target.data.every(trace => trace.visible === true)), "A second double-click restores all even when the first click timer already fired");
      mouseClick(0, 1); mouseClick(1, 1); await flushClicks();
      assert(first.data.every(trace => trace.visible === "legendonly"), "Fast clicks on different names must both apply");
      await app.actions["show-all-curves"]();
    } finally { context.window.setTimeout = setTimer; context.window.clearTimeout = clearTimer; }
    assert.equal(calls, before, "Legend actions must not request curve data again");
    await app.actions["toggle-overview-curve"]("saved:group");
    await app.renderOverview(state.serial);
    assert(!element("view").innerHTML.includes('id="overview-legend"'), "The expanded dialog owns the only legend");
    assert(first.data.every(trace => trace.visible === (trace.legendgroup === "saved:group" ? "legendonly" : true)));
    assert.equal(first.data[0].line.color, "#123abc");
    element("panel-dialog").close();
    assert.equal(element("overview-legend").parentNode, element("overview-legend-home"));
    omitGroup = true; await app.renderOverview(state.serial);
    assert(first.data.every(trace => trace.visible === true));
    omitGroup = false; await app.renderOverview(state.serial);
    assert(first.data.filter(trace => trace.legendgroup === "saved:group").every(trace => trace.visible === "legendonly"));
    const restored = context.window.ExpmanPanels.preferences(JSON.parse(JSON.stringify(state.pendingView)));
    state.hiddenOverviewCurves = []; state.overviewColors = {};
    Object.assign(state, restored); await app.renderOverview(state.serial);
    assert(first.data.filter(trace => trace.legendgroup === "saved:group").every(trace => trace.visible === "legendonly"));
    assert.equal(first.data[0].line.color, "#123abc");
    state.options.x_axis = "wall"; await app.renderOverview(state.serial);
    assert.equal(first.data[0].customdata[1][1], "01:01:01");
    assert.equal(first.data[0].customdata[1][2], 7);
    state.options.group = "";
    await app.renderOverview(state.serial);
    await app.actions["toggle-overview-curve"]("first");
    assert([first, other].every(target => target.data.find(trace => trace.legendgroup === "first").visible === "legendonly"));
    assert(element("overview-legend").innerHTML.includes('data-overview-color="second"'));
    await documentHandlers.change({target: {id: "", dataset: {overviewColor: "first"}, value: "#008800"}});
    assert.equal(other.data.find(trace => trace.legendgroup === "first").line.color, "#008800");
    assert.equal(state.overviewColors["saved:first"], "#123abc");
    assert(element("selection-chips").innerHTML.includes('style="background:#008800"'));
    const expectedColors = new Map(state.runs.map(run => [run.id, state.experimentDefaultColors[run.id]]));
    expectedColors.set("first", "#008800");
    state.tab = "runs"; await app.renderView();
    for (const [id, shade] of expectedColors) assert(element("view").innerHTML.split('data-action="edit-run" data-value="' + id + '"')[1].split("</button>")[0].includes('background:' + shade));
    state.tab = "analysis"; state.condition = "kind"; state.categoricalConditions = [];
    state.analysis = {metric: "loss", records: state.runs.map((run, index) => ({id: run.id, name: run.name, result: index + 1, config: {kind: index}})), associations: []};
    await app.renderCondition();
    assert.deepEqual(Array.from(element("condition-chart").data[0].marker.color), state.analysis.records.map(record => expectedColors.get(record.id)));
    state.categoricalConditions = ["kind"]; await app.renderCondition();
    const dots = element("condition-chart").data.find(trace => trace.type === "scatter");
    assert.deepEqual(Array.from(dots.marker.color), state.analysis.records.map(record => expectedColors.get(record.id)));
    assert(element("condition-chart").data.filter(trace => trace.type === "box").every(trace => trace.boxpoints === false));
    state.tab = "overview"; state.categoricalConditions = [];
    state.options.group = "config"; state.options.groupKeys = ["learning_rate"];
    await app.renderOverview(state.serial);
    const configKey = first.data[0].legendgroup;
    await app.actions["toggle-overview-curve"](configKey);
    await documentHandlers.change({target: {id: "", dataset: {overviewColor: configKey}, value: "#112233"}});
    curves[0].id = "auto-99";
    state.panelPageSize = 1; state.panelPage = 1;
    await app.renderOverview(state.serial);
    assert.equal(first.data[0].legendgroup, "config:" + JSON.stringify([["learning_rate"], "Group"]));
    const moved = first.data.find(trace => trace.legendgroup === configKey);
    assert.equal(moved, undefined);
    state.panelPage = 0; await app.renderOverview(state.serial);
    assert(!first.data.some(trace => trace.legendgroup === configKey));
    await app.actions["toggle-overview-curve"](configKey);
    const revealed = first.data.find(trace => trace.legendgroup === configKey);
    assert.equal(revealed.visible, true);
    assert.equal(revealed.line.color, "#112233");
    const original = curves[0].original_y;
    delete curves[0].original_y;
    state.options.smoothing = 0.4; await app.renderOverview(state.serial);
    assert(first.data[0].hovertemplate.includes("Original unavailable"));
    assert(element("curve-coverage-0").innerHTML.includes("Restart Expman"));
    state.options.smoothing = 0; state.panelSmoothing[tags[0]] = 0; await app.renderOverview(state.serial);
    assert.equal(first.data[0].customdata[1][2], curves[0].y[1]);
    assert(!element("curve-coverage-0").innerHTML.includes("Original values are missing"));
    curves[0].original_y = original; curves[0].elapsed[1] = 93784;
    state.options.smoothing = 0.4; await app.renderOverview(state.serial);
    assert.equal(first.data[0].customdata[1][2], 7);
    assert.equal(first.data[0].customdata[1][1], "1d 02:03:04");
    console.log("Overview shared legend: global toggles, color pickers, uncertainty bands, restored preferences, pagination, stable group identities, and one movable legend verified");
  } finally {
    element("panel-dialog").close();
    legendNames.length = 0; legendColors.length = 0; legendShowAll.length = 0;
    Object.assign(state, previous); context.fetch = previousFetch;
  }
}

async function overviewBrowserSmoothing() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousFetch = context.fetch;
  const calls = [], tags = ["A/loss", "Z/reward", "Later/hidden"];
  const members = [
    {id: "a", origin: 100, points: [[0, 0, 100], [2, 10, 102], [4, 0, 104]]},
    {id: "b", origin: 200, points: [[0, 10, 200], [1, 0, 201], [4, 10, 204]]}
  ];
  const group = () => ({id: "selected", name: "Selected experiments", member_ids: ["a", "b"], missing_members: 0, members});
  const change = (tag, value) => documentHandlers.change({target: {id: tag == null ? "smoothing-value" : "", value: String(value), dataset: tag == null ? {} : {panelSmoothing: tag}, closest: () => null}});
  const mean = target => target.data.find(trace => trace.showlegend !== false);
  try {
    Object.assign(state, {workspace: {id: "browser", name: "Browser", logdir: "/logs", settings: {appearance: {}}, state: {groups: [], ignored_configs: [], ignored_files: [], named_filters: []}},
      runs: members.map(member => ({id: member.id, name: member.id, path: member.id, config: {}, metrics: {}, tags: [], warnings: [], modified: 0})), selected: new Set(["a", "b"]),
      tab: "overview", tags, panels: tags.slice(), showAllPanels: false, panelPage: 0, panelPageSize: 2, panelQuery: "", query: "", filters: [], collection: "all", metricsLoading: false,
      overviewColors: {selected: "#123456"}, hiddenOverviewCurves: [], overviewLegendEntries: new Map(), overviewLegendSignature: "", panelSmoothing: {}, panelData: new Map(), fullPanels: {}, expandedPanel: null,
      options: {...state.options, x_axis: "step", smoothing: 0, group: "selected", alignment: "union", band: "std", ignoreOutliers: false}});
    context.fetch = async (url, options) => {
      const body = options && options.body ? JSON.parse(options.body) : null;
      calls.push({url, body});
      if (url === "/api/curves") {
        assert.equal(body.smoothing, 0); assert.equal(body.client_smoothing, true);
        return {ok: true, json: async () => ({client_smoothing: true, source: "tensorboard", curves: Object.fromEntries(body.tags.map(tag => [tag, [group()]]))})};
      }
      if (url === "/api/curves/all/jobs") return {ok: true, json: async () => ({id: "browser-full"})};
      if (url.endsWith("/result")) return {ok: true, json: async () => ({client_smoothing: true, source: "all-values", curves: {[tags[0]]: [group()]}})};
      if (url === "/api/curves/all/jobs/browser-full") return {ok: true, json: async () => ({id: "browser-full", status: "complete", percent: 100})};
      throw new Error("Smoothing must not request " + url);
    };
    await app.renderOverview(state.serial);
    const first = element("curve-0"), second = element("curve-1");
    assert(element("view").innerHTML.includes('data-action="apply-global-smoothing"'));
    assert.equal((element("view").innerHTML.match(/data-panel-smoothing=/g) || []).length, 4);
    smoothingControls.push(...[tags[0], tags[0], tags[1]].map(tag => ({dataset: {panelSmoothing: tag}, value: "0"})));
    assert.equal(mean(first).y[1], 2.5);
    const initialCalls = calls.length;
    await change(null, .9);
    assert.equal(mean(first).y[1], 2.5, "Global input must not replace independent panel values");
    await app.actions["apply-global-smoothing"]();
    assert(Math.abs(mean(first).y[1] - 70 / 19) < 1e-12);
    assert(Math.abs(mean(second).y[1] - 70 / 19) < 1e-12);
    assert.equal(state.panelSmoothing[tags[2]], .9, "Apply all includes off-page panels");
    await change(tags[0], .5);
    assert(Math.abs(mean(first).y[1] - 10 / 3) < 1e-12);
    assert(Math.abs(mean(second).y[1] - 70 / 19) < 1e-12);
    assert.equal(state.options.smoothing, .9);
    assert.equal(state.pendingView.panelSmoothing[tags[0]], .5);
    assert.equal(mean(first).customdata[1][2], 2.5);
    assert.equal(calls.length, initialCalls, "Smoothing edits must reuse observations");
    await app.actions["load-full-panel"](tags[0]);
    const full = state.fullPanels[tags[0]], fullCalls = calls.length;
    assert(first.data.every(trace => trace.line.simplify === false), "All full-value bands and lines must retain vertices");
    await change(tags[0], .8);
    assert.equal(state.fullPanels[tags[0]], full, "Smoothing must preserve full-value results");
    assert.equal(calls.length, fullCalls);
    await app.expandPanel(tags[0]);
    const expanded = element("expanded-panel-plot");
    assert(expanded.data.every(trace => trace.line.simplify === false));
    assert(element("panel-dialog").innerHTML.includes('data-panel-smoothing="A/loss"'));
    await change(tags[0], .2);
    assert.deepEqual(Array.from(mean(expanded).y), Array.from(mean(first).y));
    assert(smoothingControls.filter(control => control.dataset.panelSmoothing === tags[0]).every(control => control.value === "0.2"));
    assert.equal(mean(first).line.color, "#123456");
    await app.actions["toggle-overview-curve"]("selected");
    await app.actions["apply-global-smoothing"]();
    assert(first.data.every(trace => trace.visible === "legendonly"));
    assert.equal(calls.length, fullCalls);
    element("panel-dialog").close();
    state.panelPage = 1; await app.renderOverview(state.serial);
    assert.equal(state.panelSmoothing[tags[2]], .9);
    assert.equal(calls.length, fullCalls, "Hidden groups should not be fetched for newly opened panels");
    assert.equal(element("curve-0").data.length, 0);
    await app.actions["show-all-curves"]();
    assert(Math.abs(mean(element("curve-0")).y[1] - 70 / 19) < 1e-12);
    console.log("Browser controls: independent panel smoothing, explicit global apply, expanded controls, original values, cached full reads, colors, hidden curves, and off-page settings verified without smoothing requests");
  } finally {
    element("panel-dialog").close(); smoothingControls.length = 0;
    Object.assign(state, previous); context.fetch = previousFetch;
  }
}

async function fullValueRenderRaces() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousWorker = context.window.Worker;
  class DeferredWorker {
    constructor() { this.jobs = []; }
    postMessage(message) {
      if (message.curves) this.curves = message.curves;
      this.jobs.push({...message, curves: this.curves});
    }
    respond(index) {
      const job = this.jobs[index];
      this.onmessage({data: {id: job.id, result: context.window.ExpmanPanels.prepareCurves(job.curves, job.options)}});
    }
  }
  try {
    const tag = "stress/loss", count = 20050;
    const curve = length => ({id: "a", name: "Run a", member_ids: ["a"], missing_members: 0, members: [{id: "a", origin: 0,
      points: Array.from({length}, (unused, index) => [index, index % 100, index * 10])}]});
    const sampled = {client_smoothing: true, source: "tensorboard", curves: {[tag]: [curve(20000)]}};
    const full = {client_smoothing: true, source: "all-values", curves: {[tag]: [curve(count)]}};
    Object.assign(state, {workspace: {settings: {appearance: {}}, state: {groups: [], ignored_configs: [], ignored_files: []}},
      runs: [{id: "a", name: "Run a", path: "a", metrics: {}, config: {}, tags: []}], selected: new Set(["a"]), tab: "overview", query: "", filters: [], collection: "all",
      tags: [tag], panels: [tag], visiblePanelTags: [tag], overviewObserver: null, overviewLegendEntries: new Map(), hiddenOverviewCurves: [],
      panelSmoothing: {}, panelData: new Map(), panelRenderGeneration: new Map(), fullPanels: {}, expandedPanel: null,
      smoothingWorker: null, smoothingWorkerJobs: new Map(), smoothingWorkerTags: new Map(), smoothingWorkerFailed: false,
      options: {...state.options, smoothing: .4, group: "", x_axis: "step"}});
    context.window.Worker = DeferredWorker;
    const earlier = app.drawCurvePanel(tag, 0, sampled, state.serial), worker = state.smoothingWorker;
    state.fullPanels[tag] = {key: app.fullPanelKey(tag), result: full};
    const latest = app.drawCurvePanel(tag, 0, full, state.serial);
    worker.respond(1); await latest;
    const target = element("curve-0");
    assert.equal(target.data[0].x.length, count);
    assert.equal(target.data[0].line.simplify, false);
    worker.respond(0); await earlier;
    assert.equal(target.data[0].x.length, count, "A stale retained-sample calculation must not replace full observations");
    const lateSample = app.drawCurvePanel(tag, 0, sampled, state.serial);
    worker.respond(2); await lateSample;
    assert.equal(target.data[0].x.length, count, "A late sampled response must reuse the authoritative full result");
    assert.equal(state.panelData.get(tag).result.source, "all-values");
    await app.expandPanel(tag);
    assert.equal(element("expanded-panel-plot").data[0].x.length, count);
    assert.equal(element("expanded-panel-plot").data[0].line.simplify, false);
    console.log("Full-value rendering: 20,050 vertices survive older asynchronous calculations, late sampled replies, and expansion");
  } finally {
    element("panel-dialog").close();
    Object.assign(state, previous); context.window.Worker = previousWorker;
  }
}

async function automaticPanelLoading() {
  const app = context.window.testApp, state = app.state, previous = {...state}, previousFetch = context.fetch, previousObserver = context.window.IntersectionObserver;
  const previousHeight = context.window.innerHeight;
  const observers = [], calls = [], tick = () => new Promise(resolve => setImmediate(resolve));
  const tags = Array.from({length: 40}, (unused, index) => "Train/metric" + String(index).padStart(2, "0"));
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  }
  try {
    context.window.IntersectionObserver = Observer;
    context.window.innerHeight = 800;
    Object.assign(state, {workspace: {id: "scroll", name: "Scroll", logdir: "/logs", settings: {appearance: {}}, state: {groups: [], ignored_configs: [], ignored_files: [], named_filters: []}},
      runs: [{id: "a", name: "a", path: "a", config: {}, metrics: {}, tags: []}], selected: new Set(["a"]), tab: "overview", tags, panels: tags.slice(), showAllPanels: true,
      panelPage: 0, panelPageSize: 8, collapsedPanelGroups: [], panelQuery: "", query: "", filters: [], collection: "all", metricsLoading: false,
      panelSmoothing: {}, panelData: new Map(), fullPanels: {}, overviewLegendSignature: "", overviewLegendEntries: new Map(), options: {...state.options, smoothing: .7, group: "", x_axis: "step"}});
    context.fetch = async (url, options) => {
      assert.equal(url, "/api/curves"); const body = JSON.parse(options.body); calls.push(body);
      assert(body.tags.length <= 32);
      return {ok: true, json: async () => ({client_smoothing: true, source: "tensorboard", curves: Object.fromEntries(body.tags.map(tag => [tag, [{id: "a", name: "a", member_ids: ["a"], missing_members: 0, members: [{id: "a", origin: 100, points: [[0, 1, 100], [1, 2, 101]]}]}]]))})};
    };
    await app.renderOverview(state.serial);
    assert.equal(state.visiblePanelTags.length, 40);
    assert.equal((element("view").innerHTML.match(/data-action="expand-panel"/g) || []).length, 40);
    assert(!element("view").innerHTML.includes("Show these panels"));
    assert(!element("view").innerHTML.includes('data-action="panels-next"'));
    assert.equal(calls[0].tags.length, 8);
    const observer = observers[0], target = element("curve-39");
    assert(observer.targets.has(target));
    observer.callback([{target, isIntersecting: true}]); await tick();
    assert.deepEqual(Array.from(calls[calls.length - 1].tags), [tags[39]]);
    assert.equal(target.data.length, 1, "An off-screen plot loads automatically when it becomes visible");
    assert.equal(state.panelSmoothing[tags[39]], .7);
    for (let index = 0; index < 8; index += 1) element("curve-" + index).getBoundingClientRect = () => ({top: -1000, bottom: -800});
    state.panelSmoothing[tags[0]] = .8;
    observer.callback(Array.from(observer.targets).map(target => ({target, isIntersecting: true}))); await tick();
    assert.equal(state.panelData.size, 32, "Retained observations must be bounded while scrolling");
    assert(!state.panelData.has(tags[0]));
    assert.equal(element("curve-0").data, undefined);
    assert(observer.targets.has(element("curve-0")));
    element("curve-0").getBoundingClientRect = () => ({top: 100, bottom: 380});
    element("curve-8").getBoundingClientRect = () => ({top: -1000, bottom: -800});
    observer.callback([{target: element("curve-0"), isIntersecting: true}]); await tick();
    assert(state.panelData.has(tags[0]));
    assert.equal(state.panelData.size, 32);
    assert(Math.abs(element("curve-0").data[0].y[1] - 14 / 9) < 1e-12);
    assert(!element("curve-0").innerHTML.includes("Loading plot when visible"), "A reloaded chart must remove its cache-eviction placeholder");
    assert.equal(state.panelSmoothing[tags[0]], .8);
    state.collapsedPanelGroups = ["Train"]; await app.renderOverview(state.serial);
    assert(observer.disconnected);
    state.collapsedPanelGroups = []; await app.renderOverview(state.serial);
    assert.equal(state.visiblePanelTags.length, 40);
    assert.equal(element("curve-0").data.length, 1);
    assert.equal(state.panelSmoothing[tags[39]], .7);
    console.log("Expanded sections: all plot cards shown, bounded automatic viewport loading, observer cleanup, and restored panel smoothing verified without Show these panels clicks");
  } finally {
    if (state.overviewObserver) state.overviewObserver.disconnect();
    Object.assign(state, previous); context.fetch = previousFetch; context.window.IntersectionObserver = previousObserver;
    context.window.innerHeight = previousHeight;
    for (let index = 0; index < 9; index += 1) delete element("curve-" + index).getBoundingClientRect;
  }
}

async function onsetRenderingRegressions() {
  const app = context.window.testApp, state = app.state, previous = {...state}, before = requests.length;
  try {
    const rows = [{tag: "early", correlation: .8, change_correlation: .6, onset: 50, delay: -50, direction: "rise", related: true}, {tag: "inverse", correlation: -.98, change_correlation: -.9, onset: 80, delay: -20, direction: "fall", related: true}, {tag: "flat", correlation: null, change_correlation: null, onset: null, delay: null, direction: null, related: false}].map(row => ({...row, onset_bracket: row.onset == null ? null : [row.onset, row.onset], status: row.onset == null ? "Constant in change interval" : "Detected"}));
    const curve = {x: [0, 50, 80, 100, 200], y: [0, 0, .5, 1, 0], raw: [0, 0, .5, 1, 0], baseline: [0, 0, 0, 0, 0], segments: [1, 1, 1, 1, 1]};
    Object.assign(state, {tab: "time", time: {...state.time, ...context.window.ExpmanOnsets.defaults, mode: "onsets"}, timePlotQuery: "", timePlotPage: 0,
      timeData: {reference: "reference", reference_result: {onset: 100, direction: "rise"}, rows, curves: {reference: curve, early: curve, inverse: curve, flat: curve},
        analysis: {start: 0, end: 200, baseline_start: -100, baseline_end: 0, resolution: 10, smoothing_span: 50, sustain_span: 50, related_curves: 2}, note: "Temporal association"}});
    await app.renderOnsets();
    const order = () => Array.from(element("time-results").innerHTML.matchAll(/data-onset-tag="([^"]+)"/g), item => item[1]);
    const lines = element("onset-curves").data.filter(trace => trace.mode === "lines");
    assert.equal(new Set(lines.map(trace => trace.line.color)).size, lines.length);
    assert.deepEqual(order(), ["inverse", "early"]);
    assert(element("time-results").innerHTML.includes("Correlation · strongest |r|"));
    assert(element("time-results").innerHTML.includes("reference"));
    await documentHandlers.change({target: {id: "onset-sort", value: "onset"}});
    assert.deepEqual(order(), ["early", "inverse"]);
    assert.equal(state.pendingView.time.onset_sort, "onset");
    await documentHandlers.change({target: {id: "onset-show-all", checked: true}});
    assert.deepEqual(order(), ["early", "inverse", "flat"]);
    assert(element("time-results").innerHTML.includes("Constant in change interval"));
    state.timePlotQuery = "early";
    await app.renderOnsets();
    assert.deepEqual(order(), ["early"]);
    assert(element("onset-curves").data.some(trace => trace.name === "reference"));
    assert.equal(requests.length, before, "Onset sorting and browsing must reuse cached results");
  } finally { Object.assign(state, previous); }
}

function configurationDisplayRegressions() {
  const app = context.window.testApp, state = app.state, previous = {...state}, before = requests.length;
  try {
    const experiments = [{id: "a", name: "First"}, {id: "b", name: "Second"}];
    const rows = [
      {key: "model.kind", cells: [{present: true, value: "transformer"}, {present: true, value: "moe"}]},
      {key: "typed", cells: [{present: true, value: 1}, {present: true, value: "1"}]},
      {key: "optional", cells: [{present: true, value: null}, {present: false, value: null}]},
      {key: "toString", cells: [{present: true, value: "original"}, {present: true, value: "other"}]}
    ].map(field => ({...field, kind: "config", different: true, ignored: false}));
    const scalar = {key: "loss", id: "scalar:loss", kind: "scalar", scalar: {id: "loss", tag: "loss", mode: "latest", smoothing: .4, highlight: "none"}, cells: [{present: true, value: 1}, {present: true, value: 2}]};
    Object.assign(state, {workspace: {settings: {appearance: {}}, state: {ignored_configs: [], ignored_files: []}},
      runs: experiments.map((item, index) => ({...item, config: Object.fromEntries(rows.filter(row => row.cells[index].present).map(row => [row.key, row.cells[index].value])), metrics: {}})),
      comparison: {experiments, rows: rows.concat(scalar)}, selected: new Set(["a", "b"]), baseline: "a",
      configDisplay: context.window.ExpmanConfigurations.displayPreferences({"model.kind": {name: "<b>Model</b>", values: [{value: "transformer", text: "Same"}, {value: "moe", text: "Same"}]}, typed: {name: "", values: [{value: 1, text: "Numeric"}, {value: "1", text: "<img src=x>"}]}, optional: {name: "", values: [{value: null, text: ""}]}}),
      configPage: 0, configQuery: "", configFullNames: true, configOrder: [], configColumnWidths: {}, configResizing: null, diffOnly: false, showIgnored: false, sort: "name"});
    app.renderConfigTable();
    const html = element("view").innerHTML;
    assert(html.includes('title="model.kind">&lt;b&gt;Model&lt;/b&gt;</code>'));
    assert(configCellMarkup("a", "config:model.kind").includes('>Same</td>'));
    assert(configCellMarkup("b", "config:model.kind").includes("changed"));
    assert(configCellMarkup("a", "config:typed").includes('>Numeric</td>'));
    assert(configCellMarkup("b", "config:typed").includes('&lt;img src=x&gt;'));
    assert(configCellMarkup("b", "config:typed").includes('title="string: 1"'));
    assert(configCellMarkup("a", "config:optional").endsWith('></td>'));
    assert(configCellMarkup("b", "config:optional").endsWith('></td>'));
    assert(configCellMarkup("b", "config:optional").includes("changed"));
    assert(configCellMarkup("a", "scalar:loss").includes('>1</td>'));
    assert(configCellMarkup("a", "config:toString").includes('>original</td>'));
    state.configQuery = "<b>model";
    assert.deepEqual(Array.from(app.configurationRows()).map(row => row.key), ["model.kind"]);
    app.actions["config-display"]("model.kind");
    assert(element("dialog").innerHTML.includes('value="&lt;b&gt;Model&lt;/b&gt;"'));
    assert(element("dialog").innerHTML.includes('value="&quot;transformer&quot;"'));
    assert.equal(requests.length, before, "Display customizations use cached comparison values");
  } finally { Object.assign(state, previous); }
}

function transposedConfigRegressions() {
  const app = context.window.testApp, state = app.state, previous = {...state};
  try {
    const experiments = Array.from({length: 61}, (unused, index) => ({id: "e" + index, name: "Experiment " + index}));
    const fields = Array.from({length: 55}, (unused, field) => ({key: "very.long.configuration.path.value" + field, kind: "config", different: true, ignored: false, cells: experiments.map((item, index) => ({present: true, value: index + field}))}));
    Object.assign(state, {workspace: {settings: {appearance: {}}, state: {ignored_configs: [], ignored_files: []}},
      comparison: {experiments, rows: fields}, selected: new Set(experiments.map(item => item.id)), baseline: "e60",
      configPage: 0, configQuery: "", configFullNames: false, configOrder: [], configColumnWidths: {}, configResizing: null, diffOnly: false, showIgnored: false, sort: "name"});
    app.renderConfigTable();
    let html = element("view").innerHTML;
    assert.equal(Array.from(html.matchAll(/<tr data-experiment-id=/g)).length, 61);
    assert.equal(Array.from(html.matchAll(/data-config-heading=/g)).length, 51);
    assert.deepEqual(Array.from(html.matchAll(/<tr data-experiment-id="([^"]+)"/g), item => item[1]), experiments.map(item => item.id));
    assert(experimentMarkup("e60").includes("BASELINE"));
    assert(!experimentMarkup("e0").includes("BASELINE"));
    assert(configCellMarkup("e0", "config:" + fields[0].key).includes("changed"));
    assert(!configCellMarkup("e60", "config:" + fields[0].key).includes("changed"));
    assert(configCellMarkup("e60", "config:" + fields[0].key).includes('>60</td>'));
    const sizes = JSON.stringify(state.configAutoWidths);
    state.configFullNames = true; app.renderConfigTable();
    assert.equal(JSON.stringify(state.configAutoWidths), sizes, "Wrapping full names must not widen value columns");
    state.configPage = 1; app.renderConfigTable();
    html = element("view").innerHTML;
    assert.equal(Array.from(html.matchAll(/<tr data-experiment-id=/g)).length, 61);
    assert.equal(Array.from(html.matchAll(/data-config-heading=/g)).length, 6);
    assert(html.includes("all 61 experiments"));
    const records = context.window.ExpmanConfigurations.comparisonRecords(state.comparison, app.configurationRows(), (field, cell) => cell.present ? String(cell.value) : "");
    assert.equal(records.length, 62);
    assert.equal(records[0].length, 56);
    assert.equal(records[1][0], "Experiment 0");
    assert.equal(records[1][1], "0");
    assert.equal(records[61][0], "Experiment 60");
    assert.equal(records[61][1], "60");
  } finally { Object.assign(state, previous); }
}

async function realApiWorkflows(fixture) {
  const app = context.window.testApp, state = app.state;
  const ignoredPatterns = fixture.workspace.state.ignored_configs;
  state.workspace = {...fixture.workspace, state: {...fixture.workspace.state, ignored_configs: []}};
  state.runs = fixture.runs;
  state.selected = new Set(fixture.ids);
  state.tags = fixture.metrics.tags;
  state.metric = fixture.metric;
  state.configScalars = []; state.relationshipMetric = "";
  state.baseline = fixture.ids[0];
  state.serial = 50;
  state.tab = "configs";
  state.configPage = 0;
  state.configQuery = "";
  let ignored = false;
  context.fetch = async (url, options) => {
    requests.push({url, body: options && options.body ? JSON.parse(options.body) : null});
    const result = url === "/api/compare" ? ignored ? fixture.ignored : fixture.comparison : url.startsWith("/api/relationships/jobs") ? url.endsWith("/result") ? fixture.analysis : {id: "workflow-relationships", status: "complete", percent: 100, elapsed: 0} : url === "/api/curves" ? fixture.curves : null;
    assert(result, "Unexpected workflow endpoint: " + url);
    return {ok: true, json: async () => JSON.parse(JSON.stringify(result))};
  };
  await app.renderConfigs(50);
  assert(elements.get("view").innerHTML.includes("Reference run"));
  assert(elements.get("view").innerHTML.includes('data-config-include="timestamp"'));
  assert(elements.get("view").innerHTML.includes("BASELINE"));
  ignored = true;
  state.workspace.state.ignored_configs = ignoredPatterns;
  app.renderConfigTable();
  assert(!elements.get("view").innerHTML.includes('data-config-include="timestamp"'), "Current exclusions hide rows from an older comparison snapshot");
  await app.renderConfigs(50);
  assert(!elements.get("view").innerHTML.includes('data-config-include="timestamp"'));
  assert(elements.get("view").innerHTML.includes('data-config-include="model.architecture"'));
  state.tab = "overview";
  state.showAllPanels = false;
  state.panelQuery = "";
  state.panels = [fixture.metric];
  state.options.group = "saved";
  await app.renderOverview(50);
  const groupRequest = requests.filter(request => request.url === "/api/curves").pop();
  assert.deepEqual(Array.from(groupRequest.body.group_ids), fixture.workspace.state.groups.map(group => group.id));
  const mean = fixture.curves.curves[fixture.metric][0];
  assert.equal(mean.member_ids.length, 3);
  const meanTrace = charts.filter(chart => chart.target === elements.get("curve-0")).pop().traces.find(trace => trace.name === "Three seeds");
  assert(meanTrace);
  assert.deepEqual(Array.from(meanTrace.y), mean.y);
  state.tab = "analysis";
  state.condition = "batch_size";
  state.parallelKeys = ["batch_size", "model.architecture"];
  state.reduction = "last";
  await app.renderAnalysis(50);
  assert(elements.get("analysis-content").innerHTML.includes("Condition associations"));
  assert.equal(state.analysis.records.length, fixture.ids.length);
  assert(!state.analysis.records.some(record => Object.prototype.hasOwnProperty.call(record.config, "timestamp")));
  const scatter = charts.filter(chart => chart.target === elements.get("condition-chart")).pop().traces[0];
  assert.equal(scatter.type, "scatter");
  assert.deepEqual(Array.from(scatter.y), fixture.analysis.records.map(record => record.result));
  assert(scatter.text.includes("Reference run"));
  state.condition = "model.architecture";
  await app.renderCondition();
  const boxes = charts.filter(chart => chart.target === elements.get("condition-chart")).pop().traces.filter(trace => trace.type === "box");
  assert.equal(boxes.length, 2);
  assert(boxes.every(trace => trace.type === "box" && trace.y.length === 3));
  const parallel = elements.get("parallel-chart");
  assert.equal(parallel.data[0].type, "parcoords");
  parallel.data[0].dimensions[0].constraintrange = [64, 64];
  parallel.handlers.plotly_restyle();
  assert.equal(state.brushed.length, 3);
  assert.equal(state.selected.size, fixture.ids.length);
  assert.equal(elements.get("apply-brush").disabled, false);
  assert.equal(elements.get("apply-brush").textContent, "Use 3 runs");
  console.log("Real API workflow rendering: renamed runs, exclusions, saved group means, numeric/categorical relations, and brushing verified");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

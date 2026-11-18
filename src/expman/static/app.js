"use strict";

(() => {
  const palette = ["#5475e8", "#e8a45c", "#36a18d", "#a181d6", "#da8196", "#65a8d6", "#a0af5a", "#bf906b"];
  const annotationFields = ["name", "tags", "notes", "starred", "archived"];
  const tabs = {
    overview: ["Overview", "Follow training curves and compare experiments at a glance.", "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z"],
    runs: ["Experiments", "Find the runs that matter. Keep their context close.", "M4 5h16M4 12h16M4 19h16"],
    configs: ["Configurations", "See what changed between runs, down to a single configuration value.", "M8 4H4v16h4m8-16h4v16h-4M10 8h4m-4 4h4m-4 4h4"],
    analysis: ["Relationships", "Explore which experimental conditions are associated with your results.", "M4 20V4m0 16h17M7 15l4-5 4 2 5-8"],
    time: ["Time series", "Compare sustained changes, spikes, event order, and recurring patterns.", "M2 12h4l3-8 5 16 3-8h5"],
    native: ["TensorBoard", "The native TensorBoard interface, with all available logging plugins.", "M5 3h14v18H5zM8 8h8m-8 4h8m-8 4h5"]
  };
  const state = {
    workspace: null, runs: [], selected: new Set(), pendingStars: new Set(), tab: "overview", collection: "all", query: "", filters: [], activeFilter: "",
    activeNamedView: "", selectionMode: "manual", namedViewBusy: false, namedViewLoading: false,
    tags: [], summaryTags: [], jsonMetricLoading: false, jsonMetricJob: null, jsonMetricProgress: null, keys: [], panels: [], showAllPanels: false, panelQuery: "", panelPage: 0, panelPageSize: 16, collapsedPanelGroups: [],
    panelSize: "medium", logYPanels: [], visiblePanelTags: [], expandedPanel: null,
    combinedPlot: null, combinedData: null, combinedFull: null, combinedRenderGeneration: 0,
    combinedDragMode: false, combinedDrag: null, combinedFitting: false,
    panelSmoothing: {}, panelData: new Map(), smoothingRedraw: null, overviewObserver: null,
    panelRenderGeneration: new Map(), curveRefreshes: new Map(),
    overviewLoaded: new Set(), overviewEnqueue: null, overviewGroupMembers: new Map(),
    smoothingWorker: null, smoothingWorkerFailed: false, smoothingWorkerJobs: new Map(), smoothingWorkerTags: new Map(), smoothingWorkerSequence: 0,
    overviewColors: {}, overviewDefaultColors: {}, hiddenOverviewCurves: [], overviewLegendEntries: new Map(), overviewLegendSignature: "",
    experimentDefaultColors: {}, experimentColorSignature: "", overviewLegendClicks: new Map(),
    metric: "", baseline: "", sort: "name", columns: [], configQuery: "",
    configOrder: [], configScalars: [], configDragging: null, configCompareRequest: 0, configExclusionQueue: null,
    configFullNames: false, configColumnWidths: {}, configDisplay: {}, configDisplayEditing: null, configResizing: null,
    configScrollLeft: 0, configScrollTop: 0, configScrollObserver: null,
    diffOnly: true, showIgnored: false, configPage: 0, comparison: null, analysis: null, condition: "",
    associationScope: "configurations", relationshipMetric: "", relationshipReduction: "", relationshipSmoothing: null, parallelKeysConfigured: false,
    categoricalConditions: [], excludedMissingConditions: [], separateNullConditions: [],
    reduction: "last", direction: "max", parallelKeys: [], brushed: [], serial: 0, busy: 0,
    relationshipGeneration: 0, relationshipKey: "", relationshipJob: null, relationshipStarting: false, relationshipError: "",
    options: {x_axis: "step", smoothing: .4, band: "std", alignment: "overlap", group: "", groupKeys: [], ignoreOutliers: false},
    time: {mode: "events", experiment: "", tags: [], available: [], include: ["*"], exclude: [], reference: "", x_axis: "step", start: null,
      end: null, threshold: 5, window: 31, binary_window: 1001, period_aware: true, detector: "spike", tolerance: 10, max_lag: 100,
      min_period: null, max_period: null, phase_period: null, detrend: true, windowed: false, ...window.ExpmanOnsets.defaults},
    timeData: null, timeReferenceQuery: "", timeReferenceExperiment: "", timeReferenceOpen: false, timeReferenceIndex: -1, timeStarting: false, timeError: "", timeGeneration: 0, timePolling: null, autoTimer: null, selectionRequest: 0, metricsLoading: false, metricsError: "", metricsJob: null, metricsProgress: null
  };
  const byId = identifier => document.getElementById(identifier);
  const escape = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]));
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const label = value => JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([first], [second]) => first.localeCompare(second))) : item);
  const configValue = value => typeof value === "string" ? value : label(value);
  const plotText = value => String(value).replace(/[&<>]/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[character]));
  const number = value => value == null || !Number.isFinite(Number(value)) ? "—" : Math.abs(value) >= 10000 || (Math.abs(value) > 0 && Math.abs(value) < .001) ? Number(value).toExponential(3) : Number(value).toLocaleString(undefined, {maximumFractionDigits: 4});
  const option = (value, text, selected) => `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(text)}</option>`;
  const scalarTags = () => Array.from(new Set(state.tags.concat(state.summaryTags)));
  const metricOptions = selected => scalarTags().map(tag => option(tag, tag, selected)).join("");
  const selectedSummaryTags = () => Array.from(new Set(state.runs.filter(run => state.selected.has(run.id)).flatMap(run => Object.keys(run.metrics || {}).filter(tag => run.metrics[tag].summary_only)))).sort();

  function refreshScalarMetricOptions() {
    byId("dialog").querySelectorAll('select[name="scalar_tag"]').forEach(control => {
      const selected = control.value;
      const tags = Array.from(new Set(scalarTags().concat(selected ? [selected] : [])));
      control.innerHTML = tags.map(tag => option(tag, tag, selected)).join("");
      control.value = selected || tags[0] || "";
    });
  }
  const ids = () => Array.from(state.selected);
  const color = identifier => palette[Math.abs(Array.from(identifier).reduce((total, character) => total * 31 + character.charCodeAt(0) | 0, 0)) % palette.length];
  const experimentColor = identifier => has(state.overviewColors, identifier) ? state.overviewColors[identifier] : has(state.experimentDefaultColors, identifier) ? state.experimentDefaultColors[identifier] : has(state.overviewDefaultColors, identifier) ? state.overviewDefaultColors[identifier] : color(identifier);
  const overviewColor = experimentColor;
  const bandColor = shade => `rgba(${shade.slice(1).match(/../g).map(component => parseInt(component, 16)).join(",")},0.12)`;
  const overviewCurveKey = curve => state.options.group === "config" ? "config:" + JSON.stringify([state.options.groupKeys, curve.name]) : state.options.group === "saved" ? "saved:" + curve.id : String(curve.id);
  const icon = path => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
  const empty = (title, text) => `<div class="empty"><h2>${escape(title)}</h2><p>${escape(text)}</p></div>`;
  const loading = text => `<div class="empty"><div class="spinner"></div><p>${escape(text)}</p></div>`;
  const optionalNumber = value => value.trim() === "" ? null : Number(value);
  const validSmoothing = value => Number.isFinite(value) && value >= 0 && value <= .999;
  const notify = (message, error = false) => {
    const toast = byId("toast");
    toast.textContent = message;
    toast.className = "toast" + (error ? " error" : "");
    toast.hidden = false;
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => { toast.hidden = true; }, error ? 10000 : 4000);
  };
  const errorText = error => error && error.message ? error.message : String(error || "An unexpected error occurred");
  const execute = operation => Promise.resolve().then(operation).catch(error => { if (!error || error.name !== "AbortError") notify(errorText(error), true); });

  async function api(path, body, method, signal) {
    state.busy += 1;
    byId("activity").textContent = "Reading experiment data…";
    try {
      const response = await fetch(path, Object.assign(body === undefined ? {} : {method: method || "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}, signal ? {signal} : {}));
      const value = await response.json();
      if (!response.ok) {
        let message = typeof value.detail === "string" ? value.detail : JSON.stringify(value.detail || value);
        if (response.status === 404 && path.startsWith("/api/named-views")) message = "Restart Expman and refresh this page to enable named views.";
        if (message === "Select experiments and one panel to load all values") message = "Restart Expman and refresh this page to load all values for combined metrics.";
        const error = new Error(message);
        error.status = response.status; throw error;
      }
      return value;
    } finally {
      state.busy -= 1;
      if (!state.busy) byId("activity").textContent = "Up to date · " + new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    }
  }

  function viewSnapshot() {
    const snapshot = {selected: ids(), panels: state.panels, showAllPanels: state.showAllPanels,
      namedView: state.activeNamedView, selectionMode: state.selectionMode,
      configurationExclusions: {patterns: (state.workspace.state || {}).ignored_configs || [], files: (state.workspace.state || {}).ignored_files || []},
      sort: state.sort, showIgnored: state.showIgnored, condition: state.condition, analysisWindow: state.analysisWindow || {},
      panelQuery: state.panelQuery, panelPage: state.panelPage, panelPageSize: state.panelPageSize,
      collapsedPanelGroups: state.collapsedPanelGroups,
      panelSize: state.panelSize, logYPanels: state.logYPanels,
      panelSmoothing: state.panelSmoothing,
      combinedPlot: state.combinedPlot,
      overviewColors: state.overviewColors, hiddenOverviewCurves: state.hiddenOverviewCurves,
      configOrder: state.configOrder, configScalars: state.configScalars,
      configFullNames: state.configFullNames, configColumnWidths: state.configColumnWidths, configDisplay: state.configDisplay,
      associationScope: state.associationScope, relationshipMetric: state.relationshipMetric, diffOnly: state.diffOnly, configQuery: state.configQuery, parallelKeysConfigured: state.parallelKeysConfigured,
      relationshipReduction: state.relationshipReduction, relationshipSmoothing: state.relationshipSmoothing,
      categoricalConditions: state.categoricalConditions, excludedMissingConditions: state.excludedMissingConditions, separateNullConditions: state.separateNullConditions,
      tab: state.tab, options: state.options, metric: state.metric, columns: state.columns, baseline: state.baseline,
      parallelKeys: state.parallelKeys, filters: state.filters, activeFilter: state.activeFilter,
      query: state.query, collection: state.collection,
      time: Object.fromEntries(Object.entries(state.time).filter(([key]) => !["tags", "available", "loadedExperiment"].includes(key)))};
    return snapshot;
  }

  function remember() {
    if (!state.workspace || state.namedViewLoading) return;
    const snapshot = viewSnapshot();
    renderNamedViewControls();
    const serialized = JSON.stringify(snapshot);
    if (serialized === state.savedView && !state.pendingView) return;
    state.pendingView = JSON.parse(serialized);
    window.clearTimeout(state.saveViewTimer);
    state.saveViewTimer = window.setTimeout(() => {
      const view = state.pendingView;
      state.saveViewChain = (state.saveViewChain || Promise.resolve()).then(async () => {
        await api("/api/view", {view}, "PUT");
        state.savedView = JSON.stringify(view);
        state.workspace.state.view = view;
        if (JSON.stringify(state.pendingView) === state.savedView) state.pendingView = null;
        try { localStorage.removeItem("expman:" + state.workspace.id); } catch (error) { return; }
      }).catch(error => notify("Could not save workspace view: " + error.message, true));
    }, 500);
  }

  function setAutoRefresh(enabled) {
    window.clearInterval(state.autoTimer);
    byId("auto-refresh").checked = enabled;
    state.autoTimer = enabled || state.selectionMode === "filters" ? window.setInterval(() => execute(() => refresh(true)), 30000) : null;
  }

  function renderNamedViewControls() {
    if (!state.workspace) return;
    const views = (state.workspace.state || {}).named_views || [];
    const active = views.find(view => view.id === state.activeNamedView);
    const dirty = active && window.ExpmanViews.signature(viewSnapshot()) !== window.ExpmanViews.signature(active.view);
    byId("named-view-choice").innerHTML = option("", "Working copy", state.activeNamedView) + views.map(view => option(view.id, view.name, state.activeNamedView)).join("");
    byId("named-view-choice").disabled = state.namedViewBusy;
    byId("named-view-status").textContent = state.namedViewBusy ? "Saving or loading…" : active ? dirty ? "Modified" : "Saved" : "Working copy";
    byId("update-named-view").disabled = !active || !dirty || state.namedViewBusy;
    byId("revert-named-view").disabled = !active || !dirty || state.namedViewBusy;
    for (const id of ["rename-named-view", "delete-named-view"]) byId(id).disabled = !active || state.namedViewBusy;
    byId("new-named-view").disabled = state.namedViewBusy;
    byId("selection-mode").value = state.selectionMode;
    byId("selection-mode").disabled = state.namedViewBusy;
    byId("selection-mode-note").textContent = state.selectionMode === "filters" ? "Following filters · rescans every 30s" : "Explicit experiment selection";
  }

  async function flushWorkingView() {
    window.clearTimeout(state.saveViewTimer);
    if (state.saveViewChain) await state.saveViewChain;
    const view = viewSnapshot();
    await api("/api/view", {view}, "PUT");
    state.pendingView = null; state.savedView = JSON.stringify(view); state.workspace.state.view = view;
    window.clearTimeout(state.saveViewTimer);
  }

  async function loadNamedView(identifier) {
    if (state.namedViewBusy) return;
    if (!identifier) { state.activeNamedView = ""; remember(); return; }
    state.namedViewBusy = true; renderNamedViewControls();
    let loaded = false;
    try {
      await flushWorkingView();
      state.namedViewLoading = true;
      await api("/api/named-views/" + identifier + "/load", {});
      state.pendingView = null; window.clearTimeout(state.saveViewTimer);
      loaded = true; window.location.reload();
    } finally {
      if (!loaded) { state.namedViewLoading = false; state.namedViewBusy = false; renderNamedViewControls(); }
    }
  }

  function namedViewDialog(rename = false) {
    const active = (state.workspace.state.named_views || []).find(view => view.id === state.activeNamedView);
    if (rename && !active) return;
    dialog(rename ? "Rename named view" : "Save as new view", `<p>Save settings across all workspace pages. Edits stay in the working copy until Update view. Loading another view replaces the working copy.</p><label class="field">View name<input name="view_name" required maxlength="120" value="${escape(rename ? active.name : "")}"></label>`, rename ? "rename-view" : "new-view");
  }

  async function writeNamedView(name, identifier, rename = false) {
    if (state.namedViewBusy) return;
    state.namedViewBusy = true; renderNamedViewControls();
    try {
      await flushWorkingView();
      const saved = await api("/api/named-views" + (identifier ? "/" + identifier : ""), {name, ...(!rename ? {view: viewSnapshot()} : {})}, identifier ? "PUT" : "POST");
      state.workspace.state.named_views = (state.workspace.state.named_views || []).filter(view => view.id !== saved.id).concat(saved);
      if (!rename) state.activeNamedView = saved.id;
      byId("dialog").close(); remember();
      notify(rename ? "View renamed" : "Named view saved");
    } finally { state.namedViewBusy = false; renderNamedViewControls(); }
  }

  async function deleteNamedView() {
    if (!state.activeNamedView || state.namedViewBusy) return;
    state.namedViewBusy = true; renderNamedViewControls();
    try {
      await flushWorkingView();
      state.workspace.state.named_views = await api("/api/named-views/" + state.activeNamedView, {}, "DELETE");
      state.activeNamedView = ""; remember(); notify("Named view deleted; current settings retained");
    } finally { state.namedViewBusy = false; renderNamedViewControls(); }
  }

  function followFilterSelection() {
    if (state.selectionMode !== "filters") return false;
    const matching = visibleRuns().map(run => run.id);
    const changed = matching.length !== state.selected.size || matching.some(id => !state.selected.has(id));
    if (changed) state.selected = new Set(matching);
    return changed;
  }

  function manualSelection() {
    if (state.selectionMode === "manual") return;
    state.selectionMode = "manual"; setAutoRefresh(state.workspace.settings.auto_refresh);
  }

  function mergeRuns(runs, preserveAnnotations = false) {
    const merged = new Map(state.runs.map(item => [item.id, item]));
    runs.forEach(item => {
      const current = merged.get(item.id);
      if (current && preserveAnnotations) item = {...item, ...Object.fromEntries(annotationFields.map(key => [key, current[key]]))};
      item.searchText = (item.name + " " + item.path + " " + item.tags.join(" ") + " " + JSON.stringify(item.config)).toLowerCase();
      merged.set(item.id, item);
    });
    state.runs = Array.from(merged.values());
  }

  function mergeRunAnnotations(item) {
    const current = state.runs.find(run => run.id === item.id);
    mergeRuns([current ? {...current, ...Object.fromEntries(annotationFields.map(key => [key, item[key]]))} : item]);
  }

  function prepareExperimentColors() {
    const runs = state.runs.slice().sort((first, second) => String(first.path || first.id).localeCompare(String(second.path || second.id)));
    const identifiers = runs.filter(run => state.selected.has(run.id)).concat(runs.filter(run => !state.selected.has(run.id))).map(run => run.id);
    const groups = ((state.workspace && state.workspace.state || {}).groups || []).map(group => "saved:" + group.id);
    const signature = JSON.stringify([identifiers, groups]);
    if (signature === state.experimentColorSignature) return;
    state.experimentColorSignature = signature;
    state.experimentDefaultColors = {...window.ExpmanPanels.defaultColors(identifiers), ...window.ExpmanPanels.defaultColors(groups)};
  }

  function visibleRuns() {
    const query = state.query.trim().toLowerCase();
    return state.runs.filter(item => {
      if (state.collection === "archived" ? !item.archived : item.archived) return false;
      if (state.collection === "starred" && !item.starred) return false;
      if (query && !item.searchText.includes(query)) return false;
      return window.ExpmanFilters.matches(item.config, state.filters, item.path);
    });
  }

  function overviewRuns() {
    return visibleRuns().filter(item => state.selected.has(item.id));
  }

  function syncSelectionCheckboxes() {
    document.querySelectorAll("input[data-select-run]").forEach(input => { input.checked = state.selected.has(input.dataset.selectRun); });
    const toggle = byId("toggle-visible"), visible = visibleRuns();
    if (toggle) {
      const count = visible.filter(item => state.selected.has(item.id)).length;
      toggle.checked = visible.length > 0 && count === visible.length;
      toggle.indeterminate = count > 0 && count < visible.length;
    }
  }

  function renderChrome() {
    renderNamedViewControls();
    prepareExperimentColors();
    const visible = visibleRuns(), selected = state.runs.filter(item => state.selected.has(item.id));
    const metadata = state.workspace.state;
    byId("navigation").innerHTML = Object.entries(tabs).map(([key, details]) => `<button class="nav-link ${state.tab === key ? "active" : ""}" data-action="tab" data-value="${key}" title="${details[0]}"${state.tab === key ? ' aria-current="page"' : ""}>${icon(details[2])}<span class="label">${details[0]}</span></button>`).join("");
    byId("collections").innerHTML = [["all", "All experiments", "○"], ["starred", "Favorites", "☆"], ["archived", "Archived", "▣"]].map(([key, text, symbol]) => `<button class="nav-link ${state.collection === key && state.tab === "runs" ? "active" : ""}" data-action="collection" data-value="${key}"><span>${symbol}</span><span class="label">${text}</span><span class="badge">${state.runs.filter(item => key === "archived" ? item.archived : !item.archived && (key !== "starred" || item.starred)).length}</span></button>`).join("");
    byId("groups").innerHTML = metadata.groups.map(group => `<div class="group-nav"><button class="nav-link" data-action="select-group" data-value="${escape(group.id)}"><span class="color-dot" style="background:${experimentColor("saved:" + group.id)}"></span><span class="label">${escape(group.name)}</span><span class="badge">${group.experiment_ids.length}</span></button><button class="icon-button" data-action="edit-group" data-value="${escape(group.id)}" aria-label="Edit ${escape(group.name)}">⋯</button></div>`).join("");
    byId("page-title").textContent = tabs[state.tab][0];
    byId("page-description").textContent = tabs[state.tab][1];
    byId("breadcrumb").textContent = tabs[state.tab][0];
    byId("project-name").textContent = state.workspace.name;
    byId("source-path").textContent = state.workspace.logdir;
    byId("source-path").title = state.workspace.logdir;
    byId("selected-count").textContent = selected.length;
    const hidden = selected.filter(item => !visible.some(candidate => candidate.id === item.id)).length;
    byId("hidden-selection").textContent = hidden ? ` · ${hidden} hidden` : "";
    byId("filter-count").textContent = state.filters.length || "";
    byId("clear-all-filters").hidden = state.tab !== "runs";
    byId("clear-all-filters").disabled = !state.query && !state.filters.length && !state.activeFilter && state.collection === "all";
    const named = metadata.named_filters || [];
    byId("named-filter-choice").innerHTML = option("", "Choose a saved filter set…", state.activeFilter) + named.map(saved => {
      const count = state.runs.filter(item => !item.archived && window.ExpmanFilters.matches(item.config, saved.filters, item.path)).length;
      return option(saved.id, `${saved.name} (${count} matches)`, state.activeFilter);
    }).join("");
    for (const identifier of ["select-named-filter", "edit-named-filter"]) byId(identifier).disabled = !named.some(saved => saved.id === state.activeFilter);
    const outside = byId("outside-filter-selection");
    outside.hidden = state.tab !== "runs" || !hidden;
    outside.textContent = hidden ? `${hidden} additional ${hidden === 1 ? "experiment is" : "experiments are"} selected outside the current filters (${state.selected.size} selected in total).` : "";
    byId("selection-chips").innerHTML = selected.slice(0, 10).map(item => `<span class="chip"><span class="color-dot" style="background:${experimentColor(item.id)}"></span>${escape(item.name)}<button data-action="unselect" data-value="${item.id}" aria-label="Deselect ${escape(item.name)}">×</button></span>`).join("") + (selected.length > 10 ? `<button class="text-button" data-action="tab" data-value="runs">+${selected.length - 10} more</button>` : "");
    byId("stats").innerHTML = [["Experiments", state.runs.length, `${visible.length} visible in this collection`, "▦"], ["Selected runs", selected.length, "Shared across comparison views", "◈"], ["Scalar metrics", state.tags.length, "Available in selected experiments", "⌁"], ["Saved groups", metadata.groups.length, `${metadata.ignored_configs.length + metadata.ignored_files.length} configuration exclusions`, "◫"]].map(([title, value, foot, symbol]) => `<div class="stat"><div class="stat-head">${title}<span class="stat-icon">${symbol}</span></div><div class="stat-value">${number(value)}</div><div class="stat-foot">${escape(foot)}</div></div>`).join("");
  }

  function chooseDefaults() {
    state.panels = state.showAllPanels ? state.tags.slice() : state.panels.filter(tag => state.tags.includes(tag));
    if (!state.panels.length) {
      const preferred = [state.tags.find(tag => /reward/i.test(tag)), state.tags.find(tag => /loss/i.test(tag)), state.tags.find(tag => /grad.*norm|kl_/i.test(tag)), state.tags.find(tag => /learning_rate/i.test(tag))].filter(Boolean);
      state.panels = Array.from(new Set(preferred.concat(state.tags))).slice(0, 4);
    }
    if (!scalarTags().includes(state.metric)) state.metric = state.panels[0] || scalarTags()[0] || "";
    if (!state.selected.has(state.baseline)) state.baseline = ids()[0] || "";
  }

  function metricLoading(compact = false) {
    const progress = state.metricsProgress || {percent: 0, stage: "Starting metric discovery", elapsed: 0};
    return `<div class="${compact ? "notice" : "empty"}"><strong>Indexing complete scalar summaries…</strong><p>Discovering scalar metrics for selected experiments… ${escape(progress.stage)}${progress.metric ? " · " + escape(progress.metric) : ""} · ${Math.floor(progress.elapsed || 0)}s</p><progress max="100" value="${progress.percent || 0}" aria-label="Metric discovery progress"></progress><p>${compact ? "TensorBoard curves can be viewed while raw summaries load." : "Large event files take longer on the first scan. Unchanged summaries are reused on subsequent selections."}</p></div>`;
  }

  function cancelMetricJob(identifier) {
    return fetch("/api/metrics/jobs/" + identifier + "/cancel", {method: "POST"}).catch(() => {});
  }

  async function metricDiscoveryFailed(requestId, error) {
    if (requestId !== state.selectionRequest) return;
    state.metricsLoading = false; state.metricsJob = null; state.metricsError = error.message;
    if (state.metricsError === "Not Found") state.metricsError = "Restart Expman to load the updated metric-discovery endpoint.";
    await renderView(); notify(state.metricsError, true);
  }

  async function pollMetricJob(requestId, identifier) {
    try {
      const status = await api("/api/metrics/jobs/" + identifier);
      if (requestId !== state.selectionRequest) return;
      state.metricsProgress = status;
      if (status.status === "error" || status.status === "cancelled") throw new Error(status.error || "Metric discovery was cancelled; retry to continue");
      if (status.status !== "complete") {
        try {
          const preview = await api("/api/metrics/preview", {experiment_ids: ids()});
          if (requestId !== state.selectionRequest) return;
          if (preview.tags.length || (preview.summary_tags || []).length) {
            const changed = state.metricsPreviewSignature !== preview.signature;
            state.metricsPreviewSignature = preview.signature; state.tags = preview.tags; state.summaryTags = preview.summary_tags || [];
            refreshScalarMetricOptions();
            if (state.showAllPanels) state.panels = state.tags.slice();
            else if (!state.panels.length) state.panels = state.tags.slice(0, 4);
            if (changed && state.tab === "overview") await renderView();
          }
        } catch (error) { state.metricsPreviewError = error.message; }
        if (state.tab === "overview") {
          const inline = byId("overview-discovery-progress");
          if (inline) inline.innerHTML = metricLoading(true);
          else if (!state.tags.length) byId("view").innerHTML = metricLoading();
        }
        byId("activity").textContent = Math.floor(status.percent || 0) + "% · " + status.stage + (status.metric ? " · " + status.metric : "");
        state.metricsTimer = window.setTimeout(() => execute(() => pollMetricJob(requestId, identifier)), 1000);
        return;
      }
      const result = await api("/api/metrics/jobs/" + identifier + "/result");
      if (requestId !== state.selectionRequest) return;
      state.metricsLoading = false; state.metricsJob = null; state.metricsError = "";
      mergeRuns(result.experiments, true);
      state.tags = result.tags; state.summaryTags = result.summary_tags || []; state.keys = result.config_keys; chooseDefaults();
      refreshScalarMetricOptions();
      if (state.options.group === "config" && state.options.groupKeys.some(key => !state.keys.includes(key))) {
        state.options.group = "";
        state.options.groupKeys = state.options.groupKeys.filter(key => state.keys.includes(key));
        notify("A grouping field is now excluded or unavailable. Choose grouping fields again to update the comparison.");
      }
      renderChrome(); remember(); await renderView();
    } catch (error) { await metricDiscoveryFailed(requestId, error); }
  }

  async function selectionChanged() {
    const requestId = ++state.selectionRequest, requested = ids(), previous = state.metricsJob;
    state.serial += 1;
    if (state.relationshipKey && state.relationshipKey !== relationshipKey()) cancelRelationships();
    window.clearTimeout(state.metricsTimer);
    state.metricsJob = null; state.metricsProgress = null;
    const selectionKey = JSON.stringify(requested.slice().sort());
    if (state.metricsSelectionKey !== selectionKey) { state.metricsSelectionKey = selectionKey; state.metricsPreviewSignature = ""; state.tags = []; state.summaryTags = []; }
    state.summaryTags = selectedSummaryTags();
    refreshScalarMetricOptions();
    state.metricsLoading = requested.length > 0; state.metricsError = "";
    if (!state.selected.has(state.baseline)) state.baseline = requested[0] || "";
    invalidateFullPanels();
    if (state.configScalarJob && state.configScalarJob.key !== configScalarKey()) {
      const obsolete = state.configScalarJob;
      state.configScalarJob = null; window.clearTimeout(state.configScalarTimer);
      if (obsolete.id) fetch("/api/compare/scalars/jobs/" + obsolete.id + "/cancel", {method: "POST"}).catch(() => {});
    }
    renderChrome(); remember();
    if (state.tab === "configs") {
      if (state.comparison) renderConfigTable();
      execute(renderView);
    }
    if (state.tab === "analysis") execute(renderView);
    if (previous) await cancelMetricJob(previous);
    if (requestId !== state.selectionRequest) return;
    if (!requested.length) { state.tags = []; state.summaryTags = []; state.keys = []; chooseDefaults(); renderChrome(); await renderView(); return; }
    if (state.tab === "overview") byId("view").innerHTML = metricLoading();
    try {
      const job = await api("/api/metrics/jobs", {experiment_ids: requested});
      if (requestId !== state.selectionRequest) { if (state.metricsJob !== job.id && JSON.stringify(requested) !== JSON.stringify(ids())) await cancelMetricJob(job.id); return; }
      state.metricsJob = job.id;
      await pollMetricJob(requestId, job.id);
    } catch (error) { await metricDiscoveryFailed(requestId, error); }
  }

  const plotOptions = () => ({responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"], toImageButtonOptions: {format: "png", scale: 2}});

  function compactCurveHover(target) {
    const legend = target.querySelector(".hoverlayer g.legend");
    if (!legend) return;
    const background = legend.querySelector("rect.bg"), rows = Array.from(legend.querySelectorAll("g.traces"));
    if (!background || !rows.length) return;
    const title = legend.querySelector(".legendtitletext"), titleBox = title && title.getBBox();
    let top = titleBox ? titleBox.y + titleBox.height + 4 : 4;
    legend.querySelectorAll("g.groups").forEach(group => {
      const transform = group.transform.baseVal.consolidate();
      group.setAttribute("transform", `translate(${transform ? transform.matrix.e : 0},0)`);
    });
    rows.forEach(row => {
      const text = row.querySelector(".legendtext"), bounds = row.getBBox(), transform = row.transform.baseVal.consolidate();
      const font = text ? Number.parseFloat(text.style.fontSize) || 10 : 10;
      row.setAttribute("transform", `translate(${transform ? transform.matrix.e : 0},${top - bounds.y})`);
      top += Math.max(bounds.height, font * 1.2) + 2;
    });
    background.setAttribute("height", Math.min(Number(background.getAttribute("height")), Math.ceil(top + 2)));
  }

  function bindCompactCurveHover(target) {
    if (!target.expmanCompactHoverHandler) target.expmanCompactHoverHandler = () => compactCurveHover(target);
    if (target.removeListener) target.removeListener("plotly_hover", target.expmanCompactHoverHandler);
    target.on("plotly_hover", target.expmanCompactHoverHandler);
  }

  function plot(target, traces, layout = {}) {
    if (!window.Plotly) throw new Error("The local Plotly asset could not be loaded. Refresh the page after checking the server.");
    if (!target.data) target.innerHTML = "";
    const appearance = state.workspace.settings.appearance;
    const configured = Object.assign({paper_bgcolor: "#fff", plot_bgcolor: "#fff", margin: {l: 49, r: 23, t: 16, b: 50},
      font: {family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 10, color: "#8794a9"},
      xaxis: {gridcolor: "#f0f3f9", zeroline: false, tickfont: {size: 9}}, yaxis: {gridcolor: "#edf1f8", zeroline: false, tickfont: {size: 9}},
      legend: {orientation: "h", x: 0, y: -.2, font: {size: 9}}, hovermode: "closest", uirevision: state.tab}, layout);
    return Plotly.react(target, window.ExpmanAppearance.plotTraces(traces, appearance), window.ExpmanAppearance.plotLayout(configured, appearance), plotOptions()).then(() => bindCompactCurveHover(target));
  }

  const panelLogControl = tag => `<label class="panel-log-toggle" title="Logarithmic Y axis; zero and negative values are hidden"><input type="checkbox" data-panel-log-y="${escape(tag)}" aria-label="Logarithmic Y axis for ${escape(tag)}" ${state.logYPanels.includes(tag) ? "checked" : ""}> Log Y</label>`;

  function panelSmoothing(tag) {
    if (!has(state.panelSmoothing, tag)) state.panelSmoothing = {...state.panelSmoothing, [tag]: state.options.smoothing};
    return state.panelSmoothing[tag];
  }

  function panelSmoothingControl(tag) {
    const value = panelSmoothing(tag);
    return `<label class="panel-smoothing-control" title="Smoothing"><span class="panel-smoothing-label">Smooth</span><input type="range" min="0" max="0.999" step="any" data-panel-smoothing="${escape(tag)}" value="${value}" aria-label="Smoothing slider for ${escape(tag)}"><input type="number" min="0" max="0.999" step="any" inputmode="decimal" data-panel-smoothing="${escape(tag)}" value="${value}" aria-label="Smoothing factor for ${escape(tag)}"></label>`;
  }

  function updateSmoothingControls(source) {
    for (const id of ["smoothing", "smoothing-value"]) {
      const control = byId(id);
      if (control && control !== source) control.value = String(state.options.smoothing);
    }
    document.querySelectorAll("[data-panel-smoothing]").forEach(control => {
      if (control !== source) control.value = String(panelSmoothing(control.dataset.panelSmoothing));
    });
  }

  function redrawSmoothing(tags) {
    if (state.smoothingRedraw) { tags.forEach(tag => state.smoothingRedraw.tags.add(tag)); return state.smoothingRedraw.promise; }
    const pending = {tags: new Set(tags)};
    pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    state.smoothingRedraw = pending;
    const schedule = window.requestAnimationFrame ? callback => window.requestAnimationFrame(callback) : callback => window.setTimeout(callback, 0);
    schedule(async () => {
      try {
        while (pending.tags.size) {
          const tag = pending.tags.values().next().value;
          pending.tags.delete(tag);
          const index = state.visiblePanelTags.indexOf(tag), data = state.panelData.get(tag);
          if (index >= 0 && data && data.key === fullPanelKey(tag) && state.tab === "overview") await drawCurvePanel(tag, index, data.result, state.serial);
        }
        pending.resolve();
      } catch (error) { pending.reject(error); }
      finally { if (state.smoothingRedraw === pending) state.smoothingRedraw = null; }
    });
    return pending.promise;
  }

  async function setSmoothing(value, tag, source) {
    if (!validSmoothing(value)) {
      updateSmoothingControls();
      throw new Error("Smoothing must be a number between 0 and 0.999");
    }
    if (tag == null) state.options.smoothing = value;
    else state.panelSmoothing = {...state.panelSmoothing, [tag]: value};
    updateSmoothingControls(source); remember();
    if (tag != null) await redrawSmoothing([tag]);
  }

  async function applyGlobalSmoothing() {
    const tags = Array.from(new Set(state.tags.concat(state.panels, Object.keys(state.panelSmoothing))));
    state.panelSmoothing = Object.fromEntries(tags.map(tag => [tag, state.options.smoothing]));
    if (state.combinedPlot) {
      state.combinedPlot.smoothing = state.options.smoothing;
      const control = byId("combined-smoothing");
      if (control) control.value = String(state.combinedPlot.smoothing);
    }
    updateSmoothingControls(); remember();
    await redrawSmoothing(state.visiblePanelTags);
    if (state.combinedPlot && byId("combined-chart")) await renderCombined(state.serial);
  }

  function trimPanelData(current) {
    if (!state.overviewObserver) return;
    for (const tag of state.panelData.keys()) {
      if (state.panelData.size <= 32) break;
      if (tag === current || tag === state.expandedPanel || activeCurveRefresh(tag) || state.fullPanels && state.fullPanels[tag] && state.fullPanels[tag].result) continue;
      const index = state.visiblePanelTags.indexOf(tag), target = index >= 0 ? byId("curve-" + index) : null;
      if (!target || !target.getBoundingClientRect) continue;
      const bounds = target.getBoundingClientRect();
      if (bounds.bottom >= -600 && bounds.top <= window.innerHeight + 600) continue;
      state.panelData.delete(tag); state.overviewLoaded.delete(tag);
      if (target.data) Plotly.purge(target);
      delete target.expmanScaleBound; delete target.expmanPanelTag; delete target.expmanUpdateCoverage;
      target.innerHTML = '<p class="muted">Loading plot when visible…</p>';
      target.dataset.overviewPanel = tag;
      state.overviewObserver.observe(target);
    }
  }

  async function prepareBrowserCurves(tag, curves, options) {
    const large = curves.some(curve => Array.isArray(curve.members) && curve.members.reduce((sum, member) => sum + member.points.length, 0) >= 20000);
    if (!large || !window.Worker || state.smoothingWorkerFailed) return window.ExpmanPanels.prepareCurves(curves, options);
    try {
      if (!state.smoothingWorker) {
        const worker = new window.Worker("/static/overview_worker.js");
        worker.onmessage = event => {
          const response = event.data, job = state.smoothingWorkerJobs.get(response.id);
          if (!job) return;
          state.smoothingWorkerJobs.delete(response.id);
          (response.evicted || []).forEach(key => state.smoothingWorkerTags.delete(key));
          if (response.error) { state.smoothingWorkerTags.delete(job.tag); job.reject(new Error(response.error)); }
          else job.resolve(response.result);
        };
        worker.onerror = () => {
          state.smoothingWorkerFailed = true; worker.terminate(); state.smoothingWorker = null;
          state.smoothingWorkerJobs.forEach(job => job.reject(new Error("Browser smoothing worker stopped")));
          state.smoothingWorkerJobs.clear(); state.smoothingWorkerTags.clear();
        };
        state.smoothingWorker = worker;
      }
      const id = ++state.smoothingWorkerSequence;
      return await new Promise((resolve, reject) => {
        state.smoothingWorkerJobs.set(id, {tag, resolve, reject});
        const data = state.smoothingWorkerTags.get(tag) === curves ? undefined : curves;
        state.smoothingWorkerTags.set(tag, curves);
        try { state.smoothingWorker.postMessage({id, tag, curves: data, options}); }
        catch (error) { state.smoothingWorkerJobs.delete(id); reject(error); }
      });
    } catch (error) {
      state.smoothingWorkerTags.delete(tag);
      return window.ExpmanPanels.prepareCurves(curves, options);
    }
  }

  async function setPanelSize(size) {
    state.panelSize = window.ExpmanPanels.preferences({panelSize: size}).panelSize;
    remember();
    const container = byId("overview-panels");
    if (!container || state.tab !== "overview") return;
    container.dataset.panelSize = state.panelSize;
    await Promise.all(state.visiblePanelTags.map((tag, index) => {
      const chart = byId("curve-" + index);
      return chart && chart.data ? Plotly.Plots.resize(chart) : undefined;
    }));
  }

  async function setPanelLogY(tag, enabled) {
    state.logYPanels = state.logYPanels.filter(item => item !== tag);
    if (enabled) state.logYPanels.push(tag);
    document.querySelectorAll("input[data-panel-log-y]").forEach(input => {
      if (input.dataset.panelLogY === tag) input.checked = enabled;
    });
    remember();
    const index = state.visiblePanelTags.indexOf(tag);
    const targets = [index >= 0 && state.tab === "overview" ? byId("curve-" + index) : null,
      state.expandedPanel === tag && byId("panel-dialog").open ? byId("expanded-panel-plot") : null];
    await Promise.all(targets.filter(target => target && target.data).map(target => applyPanelScale(tag, target)));
  }

  function panelYScale(tag, traces) {
    const logarithmic = state.logYPanels.includes(tag);
    const range = state.options.ignoreOutliers ? window.ExpmanPanels.outlierRange(traces, logarithmic) : null;
    return range ? {type: logarithmic ? "log" : "linear", autorange: false, range} : {type: logarithmic ? "log" : "linear", autorange: true};
  }

  function applyPanelScale(tag, target, requireRange = false) {
    const scale = panelYScale(tag, target.data);
    if (requireRange && !scale.range) return;
    return Plotly.relayout(target, {"yaxis.type": scale.type, "yaxis.autorange": scale.autorange, "yaxis.range": scale.range || null});
  }

  function bindPanelScale(target, tag) {
    target.expmanPanelTag = tag;
    if (target.expmanScaleBound) return;
    target.expmanScaleBound = true;
    target.on("plotly_relayout", changes => {
      if (state.options.ignoreOutliers && changes["yaxis.autorange"] === true) execute(() => applyPanelScale(target.expmanPanelTag, target, true));
    });
  }

  async function setIgnoreOutliers(enabled) {
    state.options.ignoreOutliers = enabled;
    byId("ignore-outliers").checked = enabled;
    remember();
    const targets = state.visiblePanelTags.map((tag, index) => [tag, byId("curve-" + index)]);
    if (state.expandedPanel && byId("panel-dialog").open) targets.push([state.expandedPanel, byId("expanded-panel-plot")]);
    await Promise.all(targets.filter(([, target]) => target && target.data).map(([tag, target]) => applyPanelScale(tag, target)));
  }

  function panelTargets(tag) {
    const index = state.visiblePanelTags.indexOf(tag);
    const targets = [index >= 0 && state.tab === "overview" ? byId("curve-" + index) : null,
      state.expandedPanel === tag && byId("panel-dialog").open ? byId("expanded-panel-plot") : null];
    return targets.filter(target => target && target.data && target.expmanPanelTag === tag);
  }

  function prepareOverviewLegend(matching, configuredGroups = []) {
    prepareExperimentColors();
    const groups = (state.workspace.state || {}).groups || [];
    const signature = JSON.stringify([ids().sort(), matching.map(run => [run.id, run.name]), state.options.group, state.options.groupKeys, groups, configuredGroups]);
    if (signature === state.overviewLegendSignature) return;
    state.overviewLegendClicks.forEach(click => window.clearTimeout(click.timer));
    state.overviewLegendClicks.clear();
    state.overviewLegendSignature = signature;
    state.overviewLegendEntries = new Map();
    const selected = new Set(matching.map(run => run.id));
    let legendGroups = configuredGroups;
    if (!state.options.group) legendGroups = matching.map(run => ({id: run.id, name: run.name, member_ids: [run.id]}));
    else if (state.options.group === "selected" && matching.length) legendGroups = [{id: "selected", name: "Selected experiments", member_ids: matching.map(run => run.id)}];
    else if (state.options.group === "saved") legendGroups = groups.map(group => ({...group, member_ids: group.experiment_ids.filter(id => selected.has(id))})).filter(group => group.member_ids.length);
    state.overviewGroupMembers = new Map();
    legendGroups.forEach(group => {
      const key = overviewCurveKey(group);
      state.overviewLegendEntries.set(key, group.name);
      state.overviewGroupMembers.set(key, {id: group.id, members: group.member_ids});
    });
    const selectedRuns = state.runs.filter(run => state.selected.has(run.id)).slice().sort((first, second) => String(first.path || first.id).localeCompare(String(second.path || second.id)));
    const allSelected = new Set(selectedRuns.map(run => run.id));
    const defaults = !state.options.group ? Array.from(allSelected) : state.options.group === "saved" ? groups.filter(group => group.experiment_ids.some(id => allSelected.has(id))).map(group => "saved:" + group.id) : Array.from(state.overviewLegendEntries.keys());
    state.overviewDefaultColors = window.ExpmanPanels.defaultColors(defaults);
  }

  function renderOverviewLegend() {
    const legend = byId("overview-legend");
    if (!legend) return;
    const hidden = new Set(state.hiddenOverviewCurves);
    legend.innerHTML = `<div class="overview-legend-heading"><strong>${state.options.group ? "Groups" : "Experiments"}</strong><span class="muted">Click a name to show/hide · Double-click to isolate · Click a color to change it</span><button class="button compact push" data-action="show-all-curves" ${Array.from(state.overviewLegendEntries.keys()).some(id => hidden.has(id)) ? "" : "disabled"}>Show all curves</button></div><div class="overview-legend-items">${Array.from(state.overviewLegendEntries, ([id, name]) => `<div class="overview-legend-entry"><input type="color" class="overview-legend-color" data-overview-color="${escape(id)}" value="${overviewColor(id)}" aria-label="Curve color for ${escape(name)}" title="Change curve color for ${escape(name)}"><button class="overview-legend-name${hidden.has(id) ? " is-hidden" : ""}" data-action="toggle-overview-curve" data-value="${escape(id)}" aria-pressed="${!hidden.has(id)}" title="${hidden.has(id) ? "Show" : "Hide"} curves for ${escape(name)}">${escape(name)}</button></div>`).join("") || `<span class="muted">${state.options.group === "config" ? "Groups appear as curve data loads." : "No curves selected."}</span>`}</div>`;
  }

  function updateOverviewLegendControls() {
    const hidden = new Set(state.hiddenOverviewCurves);
    document.querySelectorAll('[data-action="toggle-overview-curve"]').forEach(button => {
      const id = button.dataset.value;
      button.classList.toggle("is-hidden", hidden.has(id));
      button.setAttribute("aria-pressed", String(!hidden.has(id)));
      button.title = `${hidden.has(id) ? "Show" : "Hide"} curves for ${state.overviewLegendEntries.get(id)}`;
    });
    document.querySelectorAll("[data-overview-color]").forEach(input => { input.value = overviewColor(input.dataset.overviewColor); });
    document.querySelectorAll('[data-action="show-all-curves"]').forEach(button => { button.disabled = !Array.from(state.overviewLegendEntries.keys()).some(id => hidden.has(id)); });
  }

  async function applyOverviewLegend(rescale = true) {
    updateOverviewLegendControls();
    const tags = Array.from(new Set(state.visiblePanelTags.concat(state.expandedPanel || [])));
    await Promise.all(tags.flatMap(tag => panelTargets(tag)).map(async target => {
      await Plotly.restyle(target, {
        visible: window.ExpmanPanels.traceVisibility(target.data, state.hiddenOverviewCurves),
        "line.color": target.data.map(trace => overviewColor(trace.legendgroup)),
        fillcolor: target.data.map(trace => bandColor(overviewColor(trace.legendgroup)))
      });
      if (rescale) await applyPanelScale(target.expmanPanelTag, target);
      if (rescale && target.expmanUpdateCoverage) target.expmanUpdateCoverage();
    }));
    tags.forEach(updateCurveRefreshControl);
  }

  async function toggleOverviewCurve(id) {
    if (!state.overviewLegendEntries.has(id)) return;
    state.hiddenOverviewCurves = state.hiddenOverviewCurves.includes(id) ? state.hiddenOverviewCurves.filter(key => key !== id) : state.hiddenOverviewCurves.concat(id);
    remember();
    await loadOverviewVisibility();
  }

  async function setOverviewColor(id, value) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Choose a six-digit hexadecimal curve color");
    state.overviewColors = {...state.overviewColors, [id]: value.toLowerCase()};
    remember();
    renderChrome();
    await applyOverviewLegend(false);
  }

  async function isolateOverviewCurve(id, previousHidden = state.hiddenOverviewCurves) {
    if (!state.overviewLegendEntries.has(id)) return;
    const keys = Array.from(state.overviewLegendEntries.keys()), active = new Set(keys);
    const solo = keys.every(key => previousHidden.includes(key) === (key !== id));
    state.hiddenOverviewCurves = state.hiddenOverviewCurves.filter(key => !active.has(key)).concat(solo ? [] : keys.filter(key => key !== id));
    remember();
    await loadOverviewVisibility();
  }

  async function showAllOverviewCurves() {
    state.hiddenOverviewCurves = [];
    remember();
    await loadOverviewVisibility();
  }

  async function loadOverviewVisibility() {
    const serial = state.serial;
    await applyOverviewLegend();
    if (serial !== state.serial || state.tab !== "overview") return;
    if (state.combinedPlot) execute(() => renderCombined(serial));
    if (state.overviewEnqueue) await state.overviewEnqueue(Array.from(state.overviewLoaded));
  }

  async function drawExpandedPanel(source, tag) {
    const modal = byId("panel-dialog"), target = byId("expanded-panel-plot");
    if (!modal.open || state.expandedPanel !== tag || !target) return;
    const layout = JSON.parse(JSON.stringify(target.data ? target.layout : source.layout));
    delete layout.width;
    delete layout.height;
    layout.autosize = true;
    layout.uirevision = "expanded:" + tag;
    layout.yaxis = Object.assign({}, layout.yaxis, {type: state.logYPanels.includes(tag) ? "log" : "linear"});
    await Plotly.react(target, JSON.parse(JSON.stringify(source.data)), layout, plotOptions());
    bindCompactCurveHover(target);
    bindPanelScale(target, tag);
    if (!modal.open || state.expandedPanel !== tag) Plotly.purge(target);
    updateCurveRefreshControl(tag);
  }

  async function expandPanel(tag) {
    const index = state.visiblePanelTags.indexOf(tag);
    const source = index >= 0 && state.tab === "overview" ? byId("curve-" + index) : null;
    if (!source || !source.data) { notify("This panel is still loading. Expand it once its chart appears."); return; }
    const modal = byId("panel-dialog"), previous = byId("expanded-panel-plot"), legend = byId("overview-legend");
    if (previous && previous.data) Plotly.purge(previous);
    state.expandedPanel = tag;
    modal.innerHTML = `<header class="dialog-header"><h2 id="panel-dialog-title">${escape(tag)}</h2><button class="icon-button" data-action="close-expanded-panel" aria-label="Close expanded panel">×</button></header><div class="expanded-panel-toolbar">${panelLogControl(tag)}${panelSmoothingControl(tag)}<span data-full-panel="${escape(tag)}">${fullPanelControl(tag)}</span>${curveRefreshButton(tag)}<button class="text-button" data-action="raw-csv" data-value="${escape(tag)}">CSV ↓</button><span class="muted">Drag to zoom · Double-click the chart to reset</span></div><div id="expanded-legend-slot"></div><div class="chart" id="expanded-panel-plot"></div><footer class="dialog-footer"><button class="button" data-action="close-expanded-panel">Close</button></footer>`;
    if (legend) byId("expanded-legend-slot").appendChild(legend);
    if (!modal.open) modal.showModal();
    await drawExpandedPanel(source, tag);
  }

  byId("panel-dialog").addEventListener("close", () => {
    const chart = byId("expanded-panel-plot");
    if (chart && chart.data && window.Plotly) Plotly.purge(chart);
    const home = byId("overview-legend-home"), legend = byId("overview-legend");
    if (home && legend) home.appendChild(legend);
    byId("panel-dialog").innerHTML = "";
    state.expandedPanel = null;
  });

  function combinedTags(identifier) {
    const run = state.runs.find(item => item.id === identifier);
    const available = run ? Object.keys(run.metrics).filter(tag => state.tags.includes(tag)) : [];
    return (available.length ? available : state.tags).slice().sort();
  }

  function combinedChoices(identifier, selected) {
    return combinedTags(identifier).map(tag => `<label data-choice="${escape(tag.toLowerCase())}"><input type="checkbox" name="choices" value="${escape(tag)}" ${selected.includes(tag) ? "checked" : ""}>${escape(tag)}</label>`).join("");
  }

  function combinedDialog() {
    const runs = overviewRuns(), saved = state.combinedPlot;
    const experiment = saved && runs.some(item => item.id === saved.experiment) ? saved.experiment : runs[0] && runs[0].id;
    if (!experiment) { notify("Select an experiment to combine its metrics."); return; }
    const tags = saved && saved.experiment === experiment ? saved.tags : state.panels.filter(tag => combinedTags(experiment).includes(tag)).slice(0, 2);
    dialog(saved ? "Edit combined metrics" : "Combine metrics", `<p>Overlay up to 32 metrics from one experiment. Independent 0–1 scaling makes different magnitudes comparable; hover retains original and smoothed values.</p><label class="field">Experiment<select name="combined_experiment">${runs.map(item => option(item.id, item.name, experiment)).join("")}</select></label><label class="field">Scaling<select name="combined_scale">${combinedScaleOptions(saved ? saved.scale : "minmax")}</select></label><label class="field">Find metrics<input type="search" id="choice-search" placeholder="Filter metric tags…"></label><div class="check-list">${combinedChoices(experiment, tags)}</div>`, "combined", "", "Show plot");
  }

  function combinedScaleOptions(selected) {
    return [["minmax", "Independent ranges · 0–1"], ["standard", "Standard scores · mean 0, SD 1"], ["raw", "Original units · shared Y axis"]].map(([key, name]) => option(key, name, selected)).join("");
  }

  function combinedOffset(spec, tag) {
    const value = spec.offsets && spec.offsets[spec.scale] && spec.offsets[spec.scale][tag];
    return Number.isFinite(value) ? value : 0;
  }

  function combinedAxisLabel(spec) {
    const label = spec.scale === "minmax" ? "Each metric scaled to 0–1" : spec.scale === "standard" ? "Standard score · each metric's mean and SD" : "Original units · shared axis";
    return label + (spec.tags.some(tag => combinedOffset(spec, tag)) ? " + display offsets" : "");
  }

  const combinedHover = offset => "%{fullData.name}: Smoothed %{customdata[0]:.6g} · Original %{customdata[1]:.6g} · Elapsed %{customdata[2]}" + (offset ? " · Display offset " + number(offset) : "") + "<extra></extra>";

  async function fitCombinedY() {
    const target = byId("combined-chart"), axis = target && target._fullLayout && target._fullLayout.xaxis;
    if (!target || !target.data || !axis) return;
    if (state.combinedFitting) return;
    state.combinedFitting = true;
    const button = byId("combined-fit-y");
    button.disabled = true; button.textContent = "Fitting…";
    try {
      const crop = axis.range.slice(), bounds = crop.map(value => axis.r2l(value));
      const visibility = new Map(target.data.map(trace => [trace.meta.metric, trace.visible === false || trace.visible === "legendonly" ? trace.visible : true]));
      if (!window.ExpmanCombined.visibleYRange(target.data, bounds, value => axis.d2l(value))) { notify("No visible curve values in this time interval."); return; }
      state.combinedPlot.scale = "minmax";
      const coordinates = state.options.x_axis === "wall" ? bounds.map(value => new Date(new Date(value).toISOString().slice(0, -1)).getTime()) : bounds;
      state.combinedPlot.scaleWindow = {axis: state.options.x_axis, start: Math.min(...coordinates), end: Math.max(...coordinates)};
      byId("combined-scale").value = "minmax";
      await renderCombined(state.serial, crop);
      await Plotly.restyle(target, {visible: target.data.map(trace => visibility.get(trace.meta.metric))});
      const currentAxis = target._fullLayout.xaxis;
      const range = window.ExpmanCombined.visibleYRange(target.data, currentAxis.range.map(value => currentAxis.r2l(value)), value => currentAxis.d2l(value));
      if (range) await Plotly.relayout(target, {"yaxis.range": range, "yaxis.autorange": false});
      remember();
    } finally {
      state.combinedFitting = false;
      if (byId("combined-fit-y")) { byId("combined-fit-y").textContent = "Fit Y to view"; updateCombinedInteractionControls(byId("combined-chart")); }
    }
  }

  function updateCombinedInteractionControls(target) {
    const toggle = byId("combined-drag-toggle"), reset = byId("combined-reset-offsets"), fit = byId("combined-fit-y");
    const ready = target && target.data && target.data.length;
    if (toggle) { toggle.disabled = !ready; toggle.setAttribute("aria-pressed", String(state.combinedDragMode)); toggle.classList.toggle("primary", state.combinedDragMode); }
    if (fit) fit.disabled = !ready || state.combinedFitting;
    if (reset) reset.disabled = !state.combinedPlot || !state.combinedPlot.tags.some(tag => combinedOffset(state.combinedPlot, tag));
    if (target) target.classList.toggle("move-curves", state.combinedDragMode);
    const hint = byId("combined-move-hint");
    if (hint) hint.hidden = !state.combinedDragMode;
  }

  function cancelCombinedDrag() {
    const drag = state.combinedDrag;
    if (!drag) return;
    state.combinedDrag = null;
    drag.group.style.transform = "";
    if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
  }

  async function finishCombinedDrag() {
    const drag = state.combinedDrag;
    cancelCombinedDrag();
    if (!drag || drag.key !== combinedKey() || drag.scale !== state.combinedPlot.scale || !drag.delta) return;
    const offset = drag.offset + drag.delta;
    if (!Number.isFinite(offset)) return;
    const spec = state.combinedPlot;
    spec.offsets = {...spec.offsets, [spec.scale]: {...spec.offsets[spec.scale], [drag.tag]: offset}};
    await Plotly.restyle(drag.target, {y: [drag.values.map(value => typeof value === "number" && Number.isFinite(value) ? value + drag.delta : value)], meta: [{metric: drag.tag, offset}], hovertemplate: [combinedHover(offset)]}, [drag.index]);
    if (drag.key !== combinedKey() || drag.target !== byId("combined-chart")) return;
    await Plotly.relayout(drag.target, {"yaxis.title.text": combinedAxisLabel(spec)});
    updateCombinedInteractionControls(drag.target); remember();
  }

  function bindCombinedInteractions(target) {
    updateCombinedInteractionControls(target);
    updateCurveRefreshControl(null);
    if (target.expmanCombinedInteractions) return;
    target.expmanCombinedInteractions = true;
    target.on("plotly_restyle", () => updateCurveRefreshControl(null));
    target.on("plotly_relayout", changes => {
      if (has(changes, "dragmode") && changes.dragmode !== false && state.combinedDragMode) { state.combinedDragMode = false; updateCombinedInteractionControls(target); }
    });
    target.addEventListener("pointerdown", event => {
      if (!state.combinedDragMode || event.button !== 0 || !state.combinedPlot) return;
      const bounds = target.getBoundingClientRect(), layout = target._fullLayout;
      const x = event.clientX - bounds.left - layout.xaxis._offset, y = event.clientY - bounds.top - layout.yaxis._offset;
      if (x < 0 || y < 0 || x > layout.xaxis._length || y > layout.yaxis._length) return;
      const position = layout.xaxis.p2l(x);
      let closest = null, distance = 12;
      target.data.forEach((trace, index) => {
        if (trace.visible === false || trace.visible === "legendonly") return;
        const value = window.ExpmanCombined.valueAt(trace, position, point => layout.xaxis.d2l(point));
        const difference = value == null ? Infinity : Math.abs(layout.yaxis.l2p(value) - y);
        if (difference < distance) { distance = difference; closest = index; }
      });
      if (closest == null) return;
      const trace = target.data[closest], group = target.querySelectorAll(".scatterlayer .trace")[target._fullData.slice(0, closest).filter(item => item.visible === true).length];
      if (!group) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const tag = trace.meta.metric;
      state.combinedDrag = {target, group, pointer: event.pointerId, key: combinedKey(), scale: state.combinedPlot.scale, index: closest, tag, values: trace.y, offset: combinedOffset(state.combinedPlot, tag), startY: event.clientY, startValue: layout.yaxis.p2l(y), axis: layout.yaxis, top: bounds.top + layout.yaxis._offset, delta: 0};
      target.setPointerCapture(event.pointerId);
      if (Plotly.Fx) Plotly.Fx.unhover(target);
    }, true);
    target.addEventListener("pointermove", event => {
      const drag = state.combinedDrag;
      if (!drag || drag.target !== target || event.pointerId !== drag.pointer) return;
      event.preventDefault(); event.stopImmediatePropagation();
      drag.delta = drag.axis.p2l(event.clientY - drag.top) - drag.startValue;
      drag.group.style.transform = "translateY(" + (event.clientY - drag.startY) + "px)";
    }, true);
    target.addEventListener("pointerup", event => {
      if (!state.combinedDrag || state.combinedDrag.target !== target) return;
      event.preventDefault(); event.stopImmediatePropagation(); execute(finishCombinedDrag);
    }, true);
    target.addEventListener("pointercancel", cancelCombinedDrag, true);
  }

  async function toggleCombinedDrag() {
    cancelCombinedDrag(); state.combinedDragMode = !state.combinedDragMode;
    const target = byId("combined-chart");
    if (target && target.data) await Plotly.relayout(target, {dragmode: state.combinedDragMode ? false : "zoom", ...(state.combinedDragMode ? {"yaxis.autorange": false, "yaxis.range": target._fullLayout.yaxis.range.slice()} : {})});
    updateCombinedInteractionControls(target);
  }

  async function resetCombinedOffsets() {
    cancelCombinedDrag();
    if (!state.combinedPlot) return;
    state.combinedPlot.offsets = {...state.combinedPlot.offsets, [state.combinedPlot.scale]: {}};
    remember(); await renderCombined(state.serial);
  }

  function combinedCard() {
    const spec = state.combinedPlot;
    if (!spec) return "";
    const run = state.runs.find(item => item.id === spec.experiment);
    return `<article class="card combined-panel"><header class="card-header"><div><h2 class="card-title">Combined metrics · ${escape(run ? run.name : "Unavailable experiment")}</h2><div class="card-subtitle">ONE EXPERIMENT · COLORS IDENTIFY METRICS</div></div><div class="card-actions">${curveRefreshButton()}<button class="button compact" data-action="combined-metrics">Edit metrics</button><button class="icon-button" data-action="remove-combined" aria-label="Remove combined metrics plot">×</button></div></header><div class="combined-controls"><label>Scaling<select id="combined-scale" aria-label="Combined metrics scaling">${combinedScaleOptions(spec.scale)}</select></label><label>Smooth<input id="combined-smoothing" type="number" min="0" max="0.999" step="any" value="${spec.smoothing}" aria-label="Combined metrics smoothing"></label><span id="combined-full-control">${combinedFullControl()}</span><button id="combined-fit-y" class="button compact" data-action="fit-combined-y" title="Independently scale each curve to 0–1 within the current time interval, preserving X zoom" disabled>Fit Y to view</button><button id="combined-drag-toggle" class="button compact" data-action="toggle-combined-drag" aria-pressed="${state.combinedDragMode}" title="Enable to drag a curve up or down; turn off to zoom" disabled>Move curves</button><button id="combined-reset-offsets" class="button compact" data-action="reset-combined-offsets" disabled>Reset offsets</button></div><div id="combined-move-hint" class="notice" ${state.combinedDragMode ? "" : "hidden"}>Drag near a curve to move it vertically. Display offsets only; hover retains recorded values. Turn off Move curves to zoom.</div><div id="combined-chart" class="chart">${loading("Loading combined metrics…")}</div><div id="combined-status" class="chart-footer" role="status"></div></article>`;
  }

  function combinedKey() {
    const spec = state.combinedPlot;
    return spec ? JSON.stringify([spec.experiment, spec.tags, state.scalarEpoch || 0]) : "";
  }

  function combinedFullControl() {
    const item = state.combinedFull;
    if (item && item.key === combinedKey()) {
      if (!item.error && item.result) return `<span>${item.rendered ? "All values loaded" : "Rendering all values…"}</span>`;
      if (!item.error) return `<button class="text-button" data-action="cancel-combined-full">Cancel · ${Math.floor(item.percent || 0)}%</button><progress max="100" value="${item.percent || 0}" aria-label="Load all combined values progress"></progress>`;
    }
    return `<button class="button compact" data-action="load-combined-full" title="${escape(item && item.error || "Load every recorded observation for these metrics; temporary for this session")}">${item && item.error ? "Retry all values" : "Load all values"}</button>`;
  }

  function updateCombinedFullControl() {
    const target = byId("combined-full-control");
    if (target) target.innerHTML = combinedFullControl();
    updateCurveRefreshControl(null);
  }

  function invalidateCombinedFull() {
    const item = state.combinedFull;
    if (!item || item.key === combinedKey()) return;
    state.combinedFull = null; window.clearTimeout(item.timer);
    if (item.id && !item.result && !item.error) fetch("/api/curves/all/jobs/" + item.id + "/cancel", {method: "POST"}).catch(() => {});
    updateCombinedFullControl();
  }

  async function cancelCombinedFull() {
    const item = state.combinedFull;
    if (!item) return;
    state.combinedFull = null; window.clearTimeout(item.timer);
    updateCombinedFullControl();
    if (item.id && !item.result && !item.error) await api("/api/curves/all/jobs/" + item.id + "/cancel", {});
  }

  async function pollCombinedFull(item) {
    invalidateCombinedFull();
    if (state.combinedFull !== item) return;
    try {
      const status = await api("/api/curves/all/jobs/" + item.id);
      if (state.combinedFull !== item || item.key !== combinedKey()) return;
      item.percent = status.percent;
      if (["error", "cancelled"].includes(status.status)) throw new Error(status.error || "Loading cancelled");
      if (status.status === "complete") {
        const result = await api("/api/curves/all/jobs/" + item.id + "/result");
        if (state.combinedFull !== item || item.key !== combinedKey()) return;
        item.result = result;
        state.combinedData = {key: item.key, result};
        if (state.tab === "overview" && byId("combined-chart")) await renderCombined(state.serial);
      } else item.timer = window.setTimeout(() => execute(() => pollCombinedFull(item)), 1000);
    } catch (error) {
      if (state.combinedFull === item && item.key === combinedKey()) { item.error = errorText(error); notify(item.error, true); }
    }
    updateCombinedFullControl();
  }

  async function loadCombinedFull() {
    if (activeCurveRefresh(null)) return;
    invalidateCombinedFull();
    const spec = state.combinedPlot;
    if (!spec || !overviewRuns().some(run => run.id === spec.experiment) || !combinedExperimentVisible(spec.experiment)) return;
    const previous = state.combinedFull;
    if (previous && !previous.error) return;
    if (previous && previous.result) {
      previous.error = null; previous.rendered = false;
      state.combinedData = {key: previous.key, result: previous.result};
      updateCombinedFullControl(); await renderCombined(state.serial); return;
    }
    const item = {key: combinedKey(), percent: 0};
    state.combinedFull = item; updateCombinedFullControl();
    try {
      const job = await api("/api/curves/all/jobs", {experiment_ids: [spec.experiment], tags: spec.tags, source: "tensorboard", client_smoothing: true, smoothing: 0, x_axis: "step"});
      if (state.combinedFull !== item || item.key !== combinedKey()) {
        if (!state.combinedFull || state.combinedFull.key !== item.key) await api("/api/curves/all/jobs/" + job.id + "/cancel", {});
        return;
      }
      item.id = job.id;
      await pollCombinedFull(item);
    } catch (error) {
      if (state.combinedFull === item && item.key === combinedKey()) { item.error = errorText(error); notify(item.error, true); updateCombinedFullControl(); }
    }
  }

  async function renderCombined(serial, crop = null) {
    cancelCombinedDrag();
    invalidateCombinedFull();
    const generation = ++state.combinedRenderGeneration;
    const spec = state.combinedPlot, key = combinedKey(), target = byId("combined-chart");
    if (!spec || !target || state.tab !== "overview") return;
    if (!overviewRuns().some(item => item.id === spec.experiment)) {
      target.hidden = false;
      target.innerHTML = empty("Experiment outside the current selection", "Select its experiment or use Edit metrics to choose another.");
      return;
    }
    target.hidden = !combinedExperimentVisible(spec.experiment);
    updateCombinedFullControl();
    if (target.hidden) {
      byId("combined-status").textContent = "Show this experiment in the shared legend to load its curves.";
      return;
    }
    try {
      const cached = state.combinedData;
      if (!cached || cached.key !== key || cached.provisional && (!state.metricsLoading || cached.discoverySignature !== state.metricsPreviewSignature)) {
        const result = await api("/api/curves", {experiment_ids: [spec.experiment], tags: spec.tags, source: "tensorboard", client_smoothing: true, smoothing: 0, max_points: 2000, x_axis: "step"}, undefined, state.viewController && state.viewController.signal);
        if (serial !== state.serial || generation !== state.combinedRenderGeneration || key !== combinedKey() || state.tab !== "overview") return;
        if (!result.client_smoothing) throw new Error("Restart Expman and refresh to load combined metrics with browser smoothing.");
        state.combinedData = {key, result, provisional: state.metricsLoading, discoverySignature: state.metricsPreviewSignature};
      }
      const result = state.combinedData.result, full = result.source === "all-values";
      const current = {...state.combinedPlot}, colors = window.ExpmanPanels.defaultColors(current.tags), traces = [], missing = [];
      for (const tag of current.tags) {
        const curves = await prepareBrowserCurves("combined:" + JSON.stringify([current.experiment, tag]), result.curves[tag] || [], {...state.options, smoothing: current.smoothing, max_points: full ? 2 ** 31 - 1 : 2000});
        if (serial !== state.serial || generation !== state.combinedRenderGeneration || key !== combinedKey() || state.tab !== "overview") return;
        const curve = curves[0];
        if (!curve || !curve.x.length) { missing.push(tag); continue; }
        const offset = combinedOffset(current, tag);
        const fitted = current.scaleWindow && current.scaleWindow.axis === state.options.x_axis ? current.scaleWindow : null;
        const reference = fitted ? window.ExpmanCombined.windowValues({x: curve.x, y: curve.y}, [fitted.start, fitted.end], value => state.options.x_axis === "wall" ? value * 1000 : value) : curve.y;
        traces.push({x: state.options.x_axis === "wall" ? curve.x.map(value => new Date(value * 1000)) : curve.x, y: window.ExpmanCombined.scale(curve.y, current.scale, reference).map(value => value == null ? null : value + offset), meta: {metric: tag, offset}, type: "scatter", mode: "lines", name: plotText(tag), uid: window.ExpmanPanels.traceUid(tag, "combined"), line: {color: colors[tag], width: 1.8, simplify: !full}, customdata: curve.x.map((value, index) => [curve.y[index], curve.original_y[index], window.ExpmanPanels.elapsedText(curve.elapsed[index])]), hovertemplate: combinedHover(offset)});
      }
      const axisLabel = combinedAxisLabel(current);
      if (!traces.length && state.metricsLoading) {
        if (!target.data) target.innerHTML = loading("Waiting for TensorBoard scalar observations…");
        byId("combined-status").textContent = "Scalar indexing in progress · observations will appear automatically";
        return;
      }
      const fitted = current.scaleWindow && current.scaleWindow.axis === state.options.x_axis ? current.scaleWindow : null;
      const initialCrop = crop || (!target.data && fitted ? [fitted.start, fitted.end].map(value => fitted.axis === "wall" ? new Date(value) : value) : null);
      const visibility = new Map((target.data || []).map(trace => [trace.meta.metric, trace.visible]));
      traces.forEach(trace => { if (visibility.has(trace.meta.metric)) trace.visible = visibility.get(trace.meta.metric); });
      cancelCombinedDrag();
      await plot(target, traces, {hovermode: "x unified", showlegend: true, dragmode: state.combinedDragMode ? false : "zoom", uirevision: key + ":" + current.scale + ":" + state.options.x_axis, margin: {l: 65, r: 25, t: 15, b: 80}, xaxis: {title: {text: state.options.x_axis === "step" ? "Training step" : state.options.x_axis === "wall" ? "Wall time" : "Elapsed seconds"}, ...(initialCrop ? {range: initialCrop, autorange: false} : {})}, yaxis: {title: {text: axisLabel}, ...(current.scale === "minmax" ? {range: [-.05, 1.05]} : {})}});
      if (serial !== state.serial || generation !== state.combinedRenderGeneration || key !== combinedKey() || state.tab !== "overview") return;
      if (full && state.combinedFull && state.combinedFull.result === result) { state.combinedFull.rendered = true; state.combinedFull.error = null; }
      updateCombinedFullControl();
      bindCombinedInteractions(target);
      byId("combined-status").textContent = traces.length + " metrics · " + (full ? "all values loaded" : "TensorBoard retained samples") + " · " + (current.scale === "raw" ? "Shared original-value scale" : (fitted ? "Each curve independently scaled in the fitted time interval" : "Scaling uses each smoothed curve's loaded values")) + (missing.length ? " · No observations: " + missing.join(", ") : "");
      if (missing.length) byId("combined-status").innerHTML = `<span>${escape(traces.length + " metrics · " + (state.metricsLoading ? "Still indexing: " : "No observations: ") + missing.join(", "))}</span><button class="button compact" data-action="retry-combined">Retry metrics</button>`;
    } catch (error) {
      if (error.name === "AbortError" || serial !== state.serial || generation !== state.combinedRenderGeneration || key !== combinedKey() || state.tab !== "overview") return;
      if (state.combinedFull && state.combinedFull.key === key && state.combinedFull.result) { state.combinedFull.error = errorText(error); state.combinedFull.rendered = false; updateCombinedFullControl(); }
      if (!target.data) target.innerHTML = empty("Could not load combined metrics", "Use Retry below to load the selected curves.");
      byId("combined-status").innerHTML = `<span class="warning">${escape(errorText(error))}</span><button class="button compact" data-action="retry-combined">Retry</button>`;
    }
  }

  function curveCard(tag, index) {
    return `<article class="card overview-panel"><header class="card-header"><div style="min-width:0"><h2 class="card-title" title="${escape(tag)}">${escape(tag)}</h2><div class="card-subtitle">SCALAR · ${state.options.group ? "GROUP MEAN" : "INDIVIDUAL RUNS"}</div></div><div class="card-actions">${panelLogControl(tag)}${panelSmoothingControl(tag)}<span data-full-panel="${escape(tag)}">${fullPanelControl(tag)}</span>${curveRefreshButton(tag)}<button class="text-button" data-action="raw-csv" data-value="${escape(tag)}">CSV ↓</button><button class="button compact panel-expand-button" data-action="expand-panel" data-value="${escape(tag)}" aria-label="Expand panel ${escape(tag)}" title="Expand panel">↗</button><button class="icon-button" data-action="remove-panel" data-value="${escape(tag)}" aria-label="Remove ${escape(tag)}">×</button></div></header><div class="chart" id="curve-${index}" data-overview-panel="${escape(tag)}"></div><div class="chart-footer"><span id="curve-note-${index}">Reading scalar observations…</span><span>Drag to zoom · Double-click chart to reset</span></div><div id="curve-coverage-${index}" class="panel-coverage"></div></article>`;
  }

  async function renderOverview(serial) {
    state.overviewEnqueue = null;
    invalidateCombinedFull();
    if (state.overviewObserver) state.overviewObserver.disconnect();
    state.overviewObserver = null;
    const matching = overviewRuns();
    invalidateFullPanels();
    if (state.selected.size && !matching.length) {
      if (byId("panel-dialog").open) byId("panel-dialog").close();
      state.visiblePanelTags = [];
      byId("view").innerHTML = empty("No selected experiments match", "Adjust the experiment search or filters, or select matching experiments.") +
        '<div class="toolbar"><button class="button" data-action="clear-all-filters">Clear search and filters</button>' +
        (visibleRuns().length ? '<button class="button primary" data-action="select-visible">Select matching experiments</button>' : "") + '</div>';
      return;
    }
    const signal = state.viewController && state.viewController.signal;
    const configuredGroups = state.options.group === "config" && matching.length && state.options.groupKeys.length
      ? await api("/api/curves/groups", curveRequest([]), "POST", signal) : [];
    if (serial !== state.serial || state.tab !== "overview") return;
    prepareOverviewLegend(matching, configuredGroups);
    const filtering = Boolean(state.panelQuery.trim());
    const tree = state.showAllPanels && !filtering ? window.ExpmanPanels.tree(state.panels, "", state.collapsedPanelGroups) : null;
    const allTags = filtering ? window.ExpmanPanels.matching(state.panels, state.panelQuery) : tree && tree.tags;
    const page = allTags
      ? {tags: allTags, page: 0, pages: 1, size: state.panelPageSize, total: allTags.length, from: allTags.length ? 1 : 0, to: allTags.length}
      : window.ExpmanPanels.page(state.panels, "", state.panelPage, state.panelPageSize);
    if (!filtering) { state.panelPage = page.page; state.panelPageSize = page.size; }
    state.visiblePanelTags = page.tags;
    if (state.expandedPanel && !page.tags.includes(state.expandedPanel) && byId("panel-dialog").open) byId("panel-dialog").close();
    state.panelData.clear();
    const indices = new Map(page.tags.map((tag, index) => [tag, index]));
    function section(node) {
      const cards = node.tags.filter(tag => indices.has(tag)).map(tag => curveCard(tag, indices.get(tag))).join("");
      const contents = `${cards ? `<div class="chart-grid">${cards}</div>` : ""}${node.groups.map(section).join("")}`;
      if (node === tree.root) return contents;
      return `<section class="panel-group" data-panel-prefix="${escape(node.prefix)}"><button class="panel-group-heading" data-action="toggle-panel-group" data-value="${escape(node.prefix)}" aria-expanded="${!node.collapsed}"><span aria-hidden="true">${node.collapsed ? "▸" : "▾"}</span><strong>${escape(node.prefix)}/</strong><span class="muted">${node.count} ${node.count === 1 ? "panel" : "panels"}</span></button>${node.collapsed ? "" : `<div class="panel-group-content">${contents}</div>`}</section>`;
    }
    const focusedFilter = document.activeElement && document.activeElement.id === "panel-filter" ? document.activeElement : null;
    const caret = focusedFilter && [focusedFilter.selectionStart, focusedFilter.selectionEnd];
    byId("view").innerHTML = `
      ${state.metricsLoading ? `<div id="overview-discovery-progress">${metricLoading(true)}</div>` : ""}
      ${matching.length < state.selected.size ? `<div class="notice">Showing ${matching.length} of ${state.selected.size} selected experiments matching the search and filters. <button class="text-button" data-action="clear-all-filters">Clear search and filters</button></div>` : ""}
      <div class="toolbar">
        <label>Group by <select id="group-mode">${option("", "Individual runs", state.options.group)}${option("selected", "All selected · mean", state.options.group)}${option("saved", "Saved groups · means", state.options.group)}${option("config", "Configuration fields…", state.options.group)}</select></label>
        <label>X axis <select id="x-axis">${[["step", "Step"], ["relative", "Elapsed seconds"], ["wall", "Wall time"]].map(([key, text]) => option(key, text, state.options.x_axis)).join("")}</select></label>
        <label>Global smoothing <input id="smoothing" type="range" min="0" max="0.999" step="any" value="${state.options.smoothing}" aria-label="Smoothing slider"><input id="smoothing-value" type="number" min="0" max="0.999" step="any" inputmode="decimal" value="${state.options.smoothing}" aria-label="Smoothing factor" title="Default smoothing for new panels, from 0 to 0.999"></label><button class="button compact" data-action="apply-global-smoothing">Apply to all panels</button>
        <label>Band <select id="band">${[["std", "Standard deviation"], ["sem", "Standard error"], ["range", "Min–max"]].map(([key, text]) => option(key, text, state.options.band)).join("")}</select></label>
        <label title="Choose Y-axis limits from the middle 90% of plotted values; all data and exports are retained"><input id="ignore-outliers" type="checkbox" ${state.options.ignoreOutliers ? "checked" : ""}> Ignore outliers in chart scaling</label>
        <label>Range <select id="alignment">${option("overlap", "Common overlap", state.options.alignment)}${option("union", "Union · variable counts", state.options.alignment)}</select></label>
        <label>Panel size <select id="panel-size">${[["small", "Small"], ["medium", "Medium"], ["large", "Large"]].map(([key, text]) => option(key, text, state.panelSize)).join("")}</select></label>
        <button class="button compact push ${state.showAllPanels ? "primary" : ""}" data-action="all-panels">All panels (${state.tags.length})</button>
        <button class="button compact" data-action="panels">Choose panels</button>
        <button class="button compact" data-action="combined-metrics">Combine metrics</button>
      </div>
      ${state.options.group === "config" ? `<div class="notice">Grouping by ${escape(state.options.groupKeys.join(", "))}. <button class="text-button" data-action="group-keys">Change fields</button></div>` : ""}
      ${combinedCard()}
      <div class="toolbar">
        <div class="search-box"><input type="search" id="panel-filter" value="${escape(state.panelQuery)}" placeholder="Filter panels by metric tag…" aria-label="Filter panels by metric tag"></div>
        <span class="muted" role="status">${filtering ? `${page.total} matching ${page.total === 1 ? "panel" : "panels"}` : `Showing ${page.from}–${page.to} of ${page.total}${tree ? ` expanded · ${tree.total} matching` : ""} panels`}</span>
        ${tree ? '<button class="button compact" data-action="expand-panel-groups">Expand all</button><button class="button compact" data-action="collapse-panel-groups">Collapse all</button>' : ""}
        ${!tree && !filtering ? `<label class="push">Per page <select id="panels-per-page">${[8, 16, 32].map(size => option(String(size), String(size), String(page.size))).join("")}</select></label>
        <button class="button compact" data-action="panels-prev" ${page.page ? "" : "disabled"}>← Previous</button>
        <span class="muted">${page.page + 1} / ${page.pages}</span>
        <button class="button compact" data-action="panels-next" ${page.page + 1 < page.pages ? "" : "disabled"}>Next →</button>` : ""}
      </div>
      <div id="overview-legend-home">${byId("panel-dialog").open ? "" : '<section id="overview-legend" class="card overview-shared-legend" aria-label="Shared curve legend"></section>'}</div>
      <div id="overview-panels" class="overview-panels" data-panel-size="${state.panelSize}">${tree ? section(tree.root) : `<div class="chart-grid">${page.tags.map(curveCard).join("")}</div>`}</div>
      ${!page.tags.length ? empty(tree && tree.total ? "Panel groups are collapsed" : state.panels.length ? "No panels match this filter" : "No scalar metrics selected", tree && tree.total ? "Expand a tag prefix or choose Expand all to display its panels." : state.panels.length ? "Change the metric-tag filter to browse other panels." : "Choose panels or select experiments that contain scalar logs.") : ""}
      <div class="notice">Means use interpolation inside recorded ranges. Bands show descriptive spread; standard error requires two contributors. Smoothing affects charts, not analysis outcomes.</div>`;
    if (focusedFilter) {
      const input = byId("panel-filter");
      input.focus({preventScroll: true});
      input.setSelectionRange(...caret);
    }
    renderOverviewLegend();
    remember();
    if (state.combinedPlot) execute(() => renderCombined(serial));
    if (!page.tags.length) return;
    const pending = new Set(), loaded = new Set();
    state.overviewLoaded = loaded;
    let loading = null;
    const enqueue = tags => {
      tags.forEach(tag => { if (indices.has(tag)) pending.add(tag); });
      if (loading) return loading;
      loading = (async () => {
        while (pending.size && serial === state.serial && state.overviewEnqueue === enqueue) {
          const [first] = pending, full = state.fullPanels && state.fullPanels[first];
          if (full && (full.result || full.previous)) {
            pending.delete(first); loaded.add(first);
            const result = full.result || full.previous.result;
            if (!state.panelData.has(first)) await drawCurvePanel(first, indices.get(first), result, serial);
            if (!full.error) await loadFullPanel(first);
            continue;
          }
          const visible = visibleOverviewKeys();
          const missing = tag => {
            const cached = state.panelData.get(tag);
            return cached ? visible.filter(key => !cached.loadedKeys.has(key)) : visible;
          };
          const keys = missing(first), signature = JSON.stringify(keys);
          const batch = Array.from(pending).filter(tag => {
            const full = state.fullPanels && state.fullPanels[tag];
            return !(full && (full.result || full.previous)) && JSON.stringify(missing(tag)) === signature;
          }).slice(0, 32);
          batch.forEach(tag => { pending.delete(tag); loaded.add(tag); });
          const request = curveRequest(batch, keys);
          const result = request.experiment_ids.length ? await api("/api/curves", request, "POST", signal) : {source: "tensorboard", client_smoothing: true, curves: {}};
          if (serial !== state.serial || state.overviewEnqueue !== enqueue) return;
          for (const tag of batch) {
            const cached = state.panelData.get(tag);
            if (!keys.length && cached) continue;
            const merged = mergePanelCurves(tag, cached && cached.result, result);
            await drawCurvePanel(tag, indices.get(tag), merged, serial, new Set([...(cached ? cached.loadedKeys : []), ...keys]));
          }
        }
      })().finally(() => { loading = null; });
      return loading;
    };
    state.overviewEnqueue = enqueue;
    const lazy = (tree || filtering) && window.IntersectionObserver;
    const eager = lazy ? page.tags.slice(0, state.panelPageSize) : page.tags;
    await enqueue(eager);
    if (serial !== state.serial || state.tab !== "overview") return;
    if (lazy) {
      const observer = new window.IntersectionObserver(entries => {
        const tags = entries.filter(entry => entry.isIntersecting).map(entry => { observer.unobserve(entry.target); return entry.target.dataset.overviewPanel; });
        if (tags.length) execute(() => enqueue(tags));
      }, {rootMargin: "600px"});
      state.overviewObserver = observer;
      page.tags.filter(tag => !loaded.has(tag)).forEach(tag => {
        const target = byId("curve-" + indices.get(tag));
        target.dataset.overviewPanel = tag; observer.observe(target);
      });
    }
  }

  async function drawCurvePanel(tag, index, result, serial, loadedKeys) {
    if (serial !== state.serial || state.tab !== "overview") return;
      const full = state.fullPanels && state.fullPanels[tag];
      if (full && full.key === fullPanelKey(tag)) {
        const complete = full.result ? full : full.previous;
        if (complete) { result = complete.result; loadedKeys = complete.loadedKeys; }
      }
      const cached = state.panelData.get(tag);
      const generation = (state.panelRenderGeneration.get(tag) || 0) + 1;
      state.panelRenderGeneration.set(tag, generation);
      state.panelData.delete(tag);
      state.panelData.set(tag, {key: fullPanelKey(tag), loadedKeys: loadedKeys || (cached && cached.loadedKeys) || new Set(), result: {source: result.source, client_smoothing: result.client_smoothing, curves: {[tag]: result.curves[tag] || []}}});
      const smoothing = panelSmoothing(tag);
      const traces = [], curves = await prepareBrowserCurves(tag, result.curves[tag] || [], {...state.options, smoothing, max_points: result.source === "all-values" ? Number.MAX_SAFE_INTEGER : 2000});
      if (serial !== state.serial || state.tab !== "overview") return;
      if (generation !== state.panelRenderGeneration.get(tag)) return;
      if (smoothing !== panelSmoothing(tag)) return;
      let legendChanged = false;
      for (const curve of curves) {
        const key = overviewCurveKey(curve);
        if (state.overviewLegendEntries.get(key) !== curve.name) { state.overviewLegendEntries.set(key, curve.name); legendChanged = true; }
      }
      if (legendChanged) state.overviewDefaultColors = window.ExpmanPanels.defaultColors(Array.from(state.overviewLegendEntries.keys()), state.overviewDefaultColors);
      const hidden = new Set(state.hiddenOverviewCurves);
      for (const curve of curves) {
        const legendgroup = overviewCurveKey(curve), shade = overviewColor(legendgroup), positions = state.options.x_axis === "wall" ? curve.x.map(value => new Date(value * 1000)) : curve.x;
        const original = Array.isArray(curve.original_y) && curve.original_y.length === curve.x.length ? curve.original_y : smoothing === 0 ? curve.y : null;
        const visible = hidden.has(legendgroup) ? "legendonly" : true, hasOriginal = Boolean(original);
        if (curve.member_ids.length > 1 && curve.x.length) {
          traces.push({x: positions, y: curve.lower, legendgroup, visible, uid: window.ExpmanPanels.traceUid(legendgroup, "lower"), type: "scatter", mode: "lines", line: {width: 0, simplify: result.source !== "all-values"}, showlegend: false, hoverinfo: "skip"});
          traces.push({x: positions, y: curve.upper, legendgroup, visible, uid: window.ExpmanPanels.traceUid(legendgroup, "upper"), type: "scatter", mode: "lines", line: {width: 0, simplify: result.source !== "all-values"}, fill: "tonexty", fillcolor: bandColor(shade), showlegend: false, hoverinfo: "skip"});
        }
        traces.push({x: positions, y: curve.y, name: plotText(curve.name), legendgroup, visible, uid: window.ExpmanPanels.traceUid(legendgroup, "value"), type: "scatter", mode: "lines", line: {color: shade, width: 1.8, simplify: result.source !== "all-values"},
          customdata: curve.x.map((value, point) => [curve.count[point], window.ExpmanPanels.elapsedText(curve.elapsed ? curve.elapsed[point] : state.options.x_axis === "relative" ? value : null), hasOriginal ? original[point] : null]),
          hovertemplate: `%{fullData.name}: Smoothed${curve.member_ids.length > 1 ? " mean" : ""} %{y:.6g} · Original${curve.member_ids.length > 1 ? " mean" : ""} ${hasOriginal ? "%{customdata[2]:.6g}" : "unavailable"} · ${curve.member_ids.length > 1 ? "Mean elapsed" : "Elapsed"} %{customdata[1]}${curve.member_ids.length > 1 ? " · n=%{customdata[0]}" : ""}<extra></extra>`});
      }
      const target = byId("curve-" + index);
      if (legendChanged) renderOverviewLegend();
      await plot(target, traces, {hovermode: "x unified", showlegend: false, yaxis: {...panelYScale(tag, traces), gridcolor: "#edf1f8", zeroline: false}, xaxis: {title: {text: state.options.x_axis === "step" ? "Training step" : state.options.x_axis === "wall" ? "Wall time" : "Elapsed seconds", font: {size: 9}}, gridcolor: "#f1f3f8", zeroline: false}});
      bindPanelScale(target, tag);
      updateCurveRefreshControl(tag);
      if (state.expandedPanel === tag) await drawExpandedPanel(target, tag);
      if (serial !== state.serial || state.tab !== "overview") return;
      if (generation !== state.panelRenderGeneration.get(tag)) return;
      if (full && full.result === result && state.fullPanels[tag] === full) {
        full.rendered = true; full.error = null; updateFullPanelControl(tag);
      }
      target.expmanUpdateCoverage = () => updatePanelCoverage(tag, index, curves, result, smoothing);
      target.expmanUpdateCoverage();
      trimPanelData(tag);
  }

  function visibleOverviewKeys() {
    const hidden = new Set(state.hiddenOverviewCurves);
    return Array.from(state.overviewGroupMembers.keys()).filter(key => !hidden.has(key));
  }

  function combinedExperimentVisible(identifier) {
    if (!state.options.group) return !state.hiddenOverviewCurves.includes(identifier);
    return visibleOverviewKeys().some(key => state.overviewGroupMembers.get(key).members.includes(identifier));
  }

  function mergePanelCurves(tag, cached, fresh) {
    const curves = new Map(((cached && cached.curves[tag]) || []).map(curve => [overviewCurveKey(curve), curve]));
    (fresh.curves[tag] || []).forEach(curve => curves.set(overviewCurveKey(curve), curve));
    return {...fresh, curves: {[tag]: Array.from(curves.values())}};
  }

  function curveRequest(tags, keys = null) {
    const matching = new Set(overviewRuns().map(item => item.id));
    const request = {experiment_ids: ids().filter(identifier => matching.has(identifier)), tags, source: "tensorboard", client_smoothing: true, x_axis: state.options.x_axis, smoothing: 0, band: state.options.band, alignment: state.options.alignment};
    if (state.options.group === "config") request.group_by = state.options.groupKeys;
    if (state.options.group === "selected") { request.group_by = []; request.combine_selected = true; }
    if (state.options.group === "saved") request.group_ids = state.workspace.state.groups.map(group => group.id);
    if (keys) {
      const groups = keys.map(key => state.overviewGroupMembers.get(key)).filter(Boolean);
      const members = new Set(groups.flatMap(group => group.members));
      request.experiment_ids = request.experiment_ids.filter(id => members.has(id));
      if (request.group_ids) request.group_ids = groups.map(group => group.id);
    }
    return request;
  }

  function curveRefreshButton(tag = null) {
    const action = tag == null ? "refresh-combined-curves" : "refresh-panel-curves";
    const label = tag == null ? "Refresh visible combined curves" : "Refresh visible curves for " + tag;
    return `<button type="button" class="button compact plot-refresh-button" data-action="${action}"${tag == null ? "" : ` data-value="${escape(tag)}"`} title="Refresh visible curves" aria-label="${escape(label)}" disabled>↻</button>`;
  }

  function activeCurveRefresh(tag) {
    const item = state.curveRefreshes.get(tag);
    return item && item.current() ? item : null;
  }

  function refreshableTraces(tag) {
    const target = tag == null ? byId("combined-chart") : panelTargets(tag)[0];
    if (tag == null && (!target || target.hidden)) return [];
    return ((target && target.data) || []).filter(trace => trace.visible !== false && trace.visible !== "legendonly" && trace.hoverinfo !== "skip" && trace.x.length);
  }

  function updateCurveRefreshControl(tag) {
    const action = tag == null ? "refresh-combined-curves" : "refresh-panel-curves";
    const item = activeCurveRefresh(tag);
    const full = tag == null ? state.combinedFull : state.fullPanels && state.fullPanels[tag];
    const loadingFull = full && !full.result && !full.error;
    const hiddenCombined = tag == null && state.combinedPlot && !combinedExperimentVisible(state.combinedPlot.experiment);
    const disabled = Boolean(item || loadingFull || !refreshableTraces(tag).length);
    document.querySelectorAll(`[data-action="${action}"]`).forEach(button => {
      if (tag != null && button.dataset.value !== tag) return;
      button.disabled = disabled;
      button.textContent = item ? "…" : "↻";
      button.title = item ? "Refreshing visible curves" + (item.percent == null ? "…" : ` · ${item.percent}%`) : "Refresh visible curves";
      button.setAttribute("aria-busy", String(Boolean(item)));
    });
    const fullControls = tag == null ? '[data-action="load-combined-full"]' : '[data-action="load-full-panel"]';
    document.querySelectorAll(fullControls).forEach(button => {
      if (tag == null || button.dataset.value === tag) button.disabled = Boolean(item || hiddenCombined || tag != null && !visibleOverviewKeys().length);
    });
  }

  async function refreshCurveData(request, full, item, signal, updateProgress) {
    if (!full) return api("/api/curves", request, "POST", signal);
    const job = await api("/api/curves/all/jobs", request, "POST", signal);
    const path = "/api/curves/all/jobs/" + job.id;
    while (item.current()) {
      const status = await api(path, undefined, undefined, signal);
      if (status.status === "complete") return api(path + "/result", undefined, undefined, signal);
      if (status.status === "error" || status.status === "cancelled") throw new Error(status.error || "Refresh cancelled");
      item.percent = Math.floor(status.percent || 0);
      updateProgress();
      await new Promise(resolve => window.setTimeout(resolve, 750));
    }
  }

  async function refreshVisibleCurves(tag) {
    if (state.tab !== "overview" || activeCurveRefresh(tag)) return;
    const traces = refreshableTraces(tag), combined = tag == null;
    if (!traces.length) return;
    const full = combined ? state.combinedFull : state.fullPanels && state.fullPanels[tag];
    if (full && !full.result && !full.error) return;
    const cached = combined ? state.combinedData : state.panelData.get(tag);
    const getKey = () => combined ? combinedKey() : fullPanelKey(tag);
    const key = getKey(), serial = state.serial;
    if (!cached || cached.key !== key) return;
    const latest = cached.result;
    let request;
    if (combined) {
      const spec = state.combinedPlot;
      if (!spec || !overviewRuns().some(run => run.id === spec.experiment)) return;
      request = {experiment_ids: [spec.experiment], tags: traces.map(trace => trace.meta.metric), source: "tensorboard", client_smoothing: true};
    } else {
      const visible = new Set(traces.map(trace => trace.legendgroup));
      request = curveRequest([tag], visibleOverviewKeys().filter(key => visible.has(key)));
      if (!request.experiment_ids.length) return;
    }
    const item = {current: () => state.tab === "overview" && serial === state.serial && key === getKey()};
    state.curveRefreshes.set(tag, item);
    updateCurveRefreshControl(tag);
    try {
      const signal = state.viewController && state.viewController.signal;
      const fresh = await refreshCurveData(request, latest.source === "all-values", item, signal, () => updateCurveRefreshControl(tag));
      if (!fresh || !item.current()) return;
      if (!request.tags.some(metric => (fresh.curves[metric] || []).length)) throw new Error("No observations returned for the visible curves");
      const result = {...latest, curves: {...latest.curves}};
      if (combined) {
        for (const metric of request.tags) if (fresh.curves[metric] && fresh.curves[metric].length) result.curves[metric] = fresh.curves[metric];
        state.combinedData = {key, result, provisional: state.metricsLoading, discoverySignature: state.metricsPreviewSignature};
        if (full && full.result) full.result = result;
        await renderCombined(serial);
      } else {
        const current = state.panelData.get(tag);
        const merged = mergePanelCurves(tag, current ? current.result : latest, fresh);
        if (full && full.result) full.result = merged;
        const index = state.visiblePanelTags.indexOf(tag);
        if (index >= 0) await drawCurvePanel(tag, index, merged, serial);
      }
    } catch (error) {
      if (item.current() && error.name !== "AbortError") notify("Could not refresh curves: " + errorText(error), true);
    } finally {
      if (state.curveRefreshes.get(tag) === item) state.curveRefreshes.delete(tag);
      updateCurveRefreshControl(tag);
      if (tag != null && item.current() && state.overviewEnqueue) execute(() => state.overviewEnqueue([tag]));
    }
  }

  function updatePanelCoverage(tag, index, cachedCurves, {source, client_smoothing}, smoothing) {
    const visible = new Set(visibleOverviewKeys());
    const curves = cachedCurves.filter(curve => visible.has(overviewCurveKey(curve)));
    if (!visible.size) {
      byId("curve-note-" + index).textContent = "No curves visible";
      byId("curve-coverage-" + index).innerHTML = "";
      return;
    }
    const missing = curves.reduce((total, item) => total + item.missing_members, 0);
    const coverage = panelCoverage(tag, curves);
    byId("curve-note-" + index).textContent = `${state.options.group ? curves.length + " groups · " : ""}${coverage.text}${source === "tensorboard" ? " · TensorBoard retained samples" + (state.options.group ? " · means/bands use samples" : "") : source === "all-values" ? " · all values loaded" : curves.some(item => item.sampled) ? " · display sampled" : ""}${missing ? ` · ${missing} members missing this metric` : ""}${curves.length && curves.every(item => !item.x.length) ? " · no common overlap" : ""}`;
    const missingOriginal = smoothing > 0 && curves.some(curve => curve.x.length && (!Array.isArray(curve.original_y) || curve.original_y.length !== curve.x.length));
    const legacy = curves.length && !client_smoothing;
    byId("curve-coverage-" + index).innerHTML = coverage.html + (legacy ? '<p class="notice warning" role="status">Restart Expman and refresh this page to enable browser smoothing with original observations.</p>' : missingOriginal ? '<p class="notice warning" role="status">Original values are missing from the server response. Restart Expman and refresh this page to load them.</p>' : "");
  }

  function panelCoverage(tag, curves) {
    const members = new Set(visibleOverviewKeys().flatMap(key => state.overviewGroupMembers.get(key).members));
    const selected = overviewRuns().filter(run => members.has(run.id));
    const available = new Set(curves.filter(curve => curve.x.length).flatMap(curve => curve.member_ids));
    const missing = selected.filter(item => !available.has(item.id)).map(item => {
      let reason = "No values available for this metric";
      if (state.metricsLoading) reason = "Metric data not available yet; indexing logs";
      else if (item.loaded && !Object.keys(item.metrics || {}).length) reason = "No scalar values recorded";
      else if (item.loaded && !has(item.metrics || {}, tag)) reason = "This metric was not recorded";
      else if (state.options.group === "saved" && !state.workspace.state.groups.some(group => group.experiment_ids.includes(item.id))) reason = "Not in a saved group";
      else if (curves.some(curve => !curve.x.length && curve.member_ids.includes(item.id))) reason = "No common overlap within the group";
      return {name: item.name, reason};
    });
    return {
      text: `${selected.filter(item => available.has(item.id)).length} of ${selected.length} ${state.hiddenOverviewCurves.length ? "visible" : "selected"} experiments plotted`,
      html: missing.length ? `<details><summary>${missing.length} selected ${missing.length === 1 ? "experiment without" : "experiments without"} plotted data</summary><ul>${missing.map(item => `<li><strong>${escape(item.name)}</strong><span>${escape(item.reason)}</span></li>`).join("")}</ul></details>` : ""
    };
  }

  function fullPanelKey(tag) {
    const saved = state.workspace.state || {};
    return JSON.stringify([curveRequest([tag]), saved.groups, saved.ignored_configs, saved.ignored_files, state.curveEpoch || 0]);
  }

  function fullPanelControl(tag) {
    const item = state.fullPanels && state.fullPanels[tag];
    if (item && item.key === fullPanelKey(tag)) {
      if (item.result && !item.error) return `<span class="muted">${item.rendered ? "All values loaded" : "Rendering all values…"}</span>`;
      if (!item.error) return `<button class="text-button" data-action="cancel-full-panel" data-value="${escape(tag)}">Cancel · ${Math.floor(item.percent || 0)}%</button><progress max="100" value="${item.percent || 0}" aria-label="Load all values progress"></progress>`;
    }
    return `<button class="text-button" data-action="load-full-panel" data-value="${escape(tag)}" title="${escape(item && item.error || "Load every scalar observation for this panel; temporary for this session")}">${item && item.error ? "Retry all values" : "Load all values"}</button>`;
  }

  function updateFullPanelControl(tag) {
    document.querySelectorAll("[data-full-panel]").forEach(target => { if (target.dataset.fullPanel === tag) target.innerHTML = fullPanelControl(tag); });
    updateCurveRefreshControl(tag);
  }

  function invalidateFullPanels() {
    state.fullPanels = state.fullPanels || {};
    Object.entries(state.fullPanels).forEach(([tag, item]) => {
      if (item.key === fullPanelKey(tag)) return;
      window.clearTimeout(item.timer);
      if (item.id && !item.result && !item.error) fetch("/api/curves/all/jobs/" + item.id + "/cancel", {method: "POST"}).catch(() => {});
      delete state.fullPanels[tag];
      updateFullPanelControl(tag);
    });
  }

  async function cancelFullPanel(tag) {
    const item = state.fullPanels && state.fullPanels[tag];
    if (!item) return;
    if (item.previous) state.fullPanels[tag] = item.previous;
    else delete state.fullPanels[tag];
    window.clearTimeout(item.timer);
    updateFullPanelControl(tag);
    if (item.id && !item.result && !item.error) await api("/api/curves/all/jobs/" + item.id + "/cancel", {});
  }

  async function pollFullPanel(tag, item) {
    if (state.fullPanels[tag] !== item || item.key !== fullPanelKey(tag)) return;
    try {
      const status = await api("/api/curves/all/jobs/" + item.id);
      if (state.fullPanels[tag] !== item || item.key !== fullPanelKey(tag)) return;
      item.percent = status.percent;
      if (["error", "cancelled"].includes(status.status)) throw new Error(status.error || "Loading cancelled");
      if (status.status === "complete") {
        const result = await api("/api/curves/all/jobs/" + item.id + "/result");
        if (state.fullPanels[tag] !== item || item.key !== fullPanelKey(tag)) return;
        item.result = mergePanelCurves(tag, item.previous && item.previous.result, result);
        delete item.previous;
        const index = state.visiblePanelTags.indexOf(tag);
        if (index >= 0 && state.tab === "overview") {
          await drawCurvePanel(tag, index, item.result, state.serial);
          if (state.overviewEnqueue && visibleOverviewKeys().some(key => !item.loadedKeys.has(key))) execute(() => state.overviewEnqueue([tag]));
        }
      } else item.timer = window.setTimeout(() => execute(() => pollFullPanel(tag, item)), 1000);
    } catch (error) { if (state.fullPanels[tag] === item) { item.error = errorText(error); notify(item.error, true); } }
    updateFullPanelControl(tag);
  }

  async function loadFullPanel(tag) {
    if (activeCurveRefresh(tag)) return;
    state.fullPanels = state.fullPanels || {};
    const previous = state.fullPanels[tag];
    const key = fullPanelKey(tag), visible = visibleOverviewKeys();
    const same = previous && previous.key === key;
    if (same && !previous.result && !previous.error) return;
    const complete = same && (previous.result ? previous : previous.previous);
    const loaded = complete && complete.loadedKeys || new Set();
    const missing = visible.filter(id => !loaded.has(id));
    if (!missing.length && same && previous.result && previous.error) {
      previous.error = null; previous.rendered = false; updateFullPanelControl(tag);
      try {
        const index = state.visiblePanelTags.indexOf(tag);
        if (index >= 0 && state.tab === "overview") await drawCurvePanel(tag, index, previous.result, state.serial);
      } catch (error) { previous.error = errorText(error); notify(previous.error, true); }
      updateFullPanelControl(tag); return;
    }
    if (!missing.length) return;
    const request = curveRequest([tag], missing);
    if (!request.experiment_ids.length) return;
    const item = {key, percent: 0, previous: complete, loadedKeys: new Set([...loaded, ...missing])};
    state.fullPanels[tag] = item; updateFullPanelControl(tag);
    try {
      const job = await api("/api/curves/all/jobs", request);
      if (state.fullPanels[tag] !== item || item.key !== fullPanelKey(tag)) {
        await api("/api/curves/all/jobs/" + job.id + "/cancel", {}); return;
      }
      item.id = job.id;
      await pollFullPanel(tag, item);
    } catch (error) { if (state.fullPanels[tag] === item) { item.error = errorText(error); notify(item.error, true); updateFullPanelControl(tag); } }
  }

  function orderedExperiments(runs) {
    const score = item => (item.metrics || {})[state.metric] ? item.metrics[state.metric].last : null;
    return runs.slice().sort((first, second) => state.sort === "updated" ? second.modified - first.modified : state.sort === "result" ? (score(second) == null ? -Infinity : score(second)) - (score(first) == null ? -Infinity : score(first)) : first.name.localeCompare(second.name, undefined, {numeric: true}));
  }

  function configurationExperimentIds() {
    const runs = new Map(state.runs.map(item => [item.id, item]));
    const compared = new Map((state.comparison ? state.comparison.experiments : []).map(item => [item.id, item]));
    return orderedExperiments(ids().map(id => runs.get(id) || compared.get(id) || {id, name: id})).map(item => item.id);
  }

  function renderRuns() {
    prepareExperimentColors();
    const runs = orderedExperiments(visibleRuns());
    const score = item => item.metrics[state.metric] ? item.metrics[state.metric].last : null;
    const baseline = state.runs.find(item => item.id === state.baseline), baselineValue = baseline ? score(baseline) : null;
    byId("view").innerHTML = `<div class="toolbar"><strong>${runs.length} experiments</strong><label>Result <select id="result-metric">${metricOptions(state.metric)}</select></label><label>Sort <select id="run-sort">${[["name", "Name"], ["updated", "Last updated"], ["result", "Result · descending"]].map(([key, text]) => option(key, text, state.sort)).join("")}</select></label><button class="button compact" data-action="columns">Columns</button><button class="button compact push" data-action="index-visible">Load visible summaries</button></div><div class="card"><div class="table-wrap"><table class="experiment-table"><thead><tr><th><input type="checkbox" id="toggle-visible" aria-label="Select all visible experiments" ${runs.length && runs.every(item => state.selected.has(item.id)) ? "checked" : ""}></th><th></th><th>EXPERIMENT</th><th>LAST RESULT</th><th>Δ VS BASELINE</th><th>LAST STEP</th>${state.columns.map(key => `<th title="${escape(key)}">${escape(key)}</th>`).join("")}<th>TAGS</th><th>UPDATED</th></tr></thead><tbody>${runs.map(item => {
      const value = score(item), delta = value == null || baselineValue == null ? null : value - baselineValue;
      return `<tr class="${state.selected.has(item.id) ? "selected" : ""}"><td><input type="checkbox" data-select-run="${item.id}" aria-label="Select ${escape(item.name)}" ${state.selected.has(item.id) ? "checked" : ""}></td><td><button class="icon-button star ${item.starred ? "on" : ""}" data-action="star" data-value="${item.id}" aria-label="Toggle favorite for ${escape(item.name)}" aria-pressed="${item.starred}" ${state.pendingStars.has(item.id) ? 'disabled aria-busy="true"' : ""}>${state.pendingStars.has(item.id) ? "…" : item.starred ? "★" : "☆"}</button></td><td><button class="run-name" data-action="edit-run" data-value="${item.id}"><span class="color-dot" style="background:${experimentColor(item.id)}"></span>${escape(item.name)}</button>${item.warnings.length ? '<span title="Run has ingestion warnings"> ⚠</span>' : ""}</td><td class="mono" title="Final unsmoothed value; select a run or load summaries to populate">${number(value)}</td><td class="mono ${delta > 0 ? "positive" : delta < 0 ? "negative" : "muted"}">${delta == null ? "—" : (delta > 0 ? "+" : "") + number(delta)}</td><td class="mono">${item.metrics[state.metric] ? number(item.metrics[state.metric].step) : "—"}</td>${state.columns.map(key => `<td class="mono" title="${escape(has(item.config, key) ? label(item.config[key]) : "Missing")}">${escape(has(item.config, key) ? label(item.config[key]).slice(0, 60) : "—")}</td>`).join("")}<td>${item.tags.map(tag => `<span class="tag">${escape(tag)}</span>`).join("")}</td><td class="muted">${new Date(item.modified * 1000).toLocaleString()}</td></tr>`;
    }).join("")}</tbody></table></div><div class="table-footer"><span>Results are final unsmoothed values. Unloaded summaries appear as —.</span><label>Baseline <select id="baseline">${state.runs.filter(item => state.selected.has(item.id)).map(item => option(item.id, item.name, state.baseline)).join("")}</select></label></div></div>${!runs.length ? empty("No matching experiments", "Adjust the search, filters, or collection.") : ""}`;
  }

  async function renderConfigs(serial) {
    const searchFocus = configSearchFocus();
    rememberConfigScroll(); disconnectConfigScrolling();
    const request = ++state.configCompareRequest;
    if (!byId("config-table")) byId("view").innerHTML = loading("Comparing configuration values…");
    if (!state.selected.has(state.baseline)) state.baseline = ids()[0] || "";
    const ordered = configurationExperimentIds();
    const result = await api("/api/compare", {experiment_ids: ordered, differences_only: state.diffOnly, show_ignored: state.showIgnored, scalar_rows: []}, undefined, state.viewController && state.viewController.signal);
    if (serial !== state.serial || state.tab !== "configs" || request !== state.configCompareRequest) return;
    state.comparison = result; insertScalarRows(); renderConfigTable(searchFocus);
    execute(ensureConfigScalars);
  }

  function configScalarKey() {
    return JSON.stringify([ids().sort(), state.configScalars.map(({highlight, highlight_color, ...spec}) => spec), state.scalarEpoch || 0]);
  }

  function insertScalarRows() {
    if (!state.comparison) return;
    const cached = state.configScalarValues && state.configScalarValues.key === configScalarKey() ? state.configScalarValues : null;
    const scalars = state.configScalars.map(spec => {
      const loaded = cached && cached.rows.find(row => row.id === "scalar:" + spec.id);
      return loaded ? {...loaded, scalar: spec, cells: state.comparison.experiments.map(item => loaded.cells[cached.experiment_ids.indexOf(item.id)] || {present: false, value: null})}
        : {id: "scalar:" + spec.id, key: spec.tag, kind: "scalar", scalar: spec, pending: true, ignored: false, different: false, cells: state.comparison.experiments.map(() => ({present: false, value: null}))};
    });
    state.comparison.rows = scalars.concat(state.comparison.rows.filter(row => row.kind !== "scalar"));
  }

  function configScalarStatus() {
    if (!state.configScalars.length) return "";
    if (state.configScalarError) return `<div class="notice warning">${escape(state.configScalarError)} <button class="button compact" data-action="retry-config-scalars">Retry scalar values</button></div>`;
    if (!state.comparison || !state.comparison.rows.some(row => row.pending)) return "";
    const status = state.configScalarProgress || {percent: 0, stage: "Starting scalar-value loading"};
    return `<div class="notice"><strong>Loading scalar values · ${Math.floor(status.percent || 0)}%</strong><span> · ${escape(status.stage)}${status.metric ? " · " + escape(status.metric) : ""}</span><progress max="100" value="${status.percent || 0}" aria-label="Scalar comparison progress"></progress></div>`;
  }

  async function pollConfigScalars(identifier, key) {
    if (key !== configScalarKey()) { await fetch("/api/compare/scalars/jobs/" + identifier + "/cancel", {method: "POST"}).catch(() => {}); if (state.configScalarJob && state.configScalarJob.id === identifier) state.configScalarJob = null; return; }
    try {
      const status = await api("/api/compare/scalars/jobs/" + identifier);
      if (key !== configScalarKey()) return;
      state.configScalarProgress = status;
      if (["error", "cancelled"].includes(status.status)) throw new Error(status.error || "Scalar loading cancelled");
      if (status.status === "complete") {
        const result = await api("/api/compare/scalars/jobs/" + identifier + "/result");
        if (key !== configScalarKey()) return;
        state.configScalarValues = {...result, key}; state.configScalarJob = null;
        if (state.tab === "configs") { insertScalarRows(); renderConfigTable(); }
      } else {
        if (state.tab === "configs" && byId("config-scalar-status")) byId("config-scalar-status").innerHTML = configScalarStatus();
        state.configScalarTimer = window.setTimeout(() => execute(() => pollConfigScalars(identifier, key)), 1000);
      }
    } catch (error) {
      if (key !== configScalarKey()) return;
      state.configScalarJob = null; state.configScalarError = error.message;
      if (state.tab === "configs" && byId("config-scalar-status")) byId("config-scalar-status").innerHTML = configScalarStatus();
    }
  }

  async function ensureConfigScalars() {
    const key = configScalarKey();
    if (state.configScalarValues && state.configScalarValues.key === key || state.configScalarJob && state.configScalarJob.key === key) return;
    const previous = state.configScalarJob;
    state.configScalarJob = null;
    window.clearTimeout(state.configScalarTimer);
    if (previous && previous.id) await fetch("/api/compare/scalars/jobs/" + previous.id + "/cancel", {method: "POST"}).catch(() => {});
    if (!state.configScalars.length || !state.selected.size) return;
    state.configScalarJob = {key, id: ""};
    state.configScalarError = "";
    try {
      const job = await api("/api/compare/scalars/jobs", {experiment_ids: ids().sort(), scalar_rows: state.configScalars});
      if (key !== configScalarKey()) { await fetch("/api/compare/scalars/jobs/" + job.id + "/cancel", {method: "POST"}).catch(() => {}); if (state.configScalarJob && state.configScalarJob.key === key) state.configScalarJob = null; return; }
      state.configScalarJob = {...job, key};
      await pollConfigScalars(job.id, key);
    } catch (error) { if (key === configScalarKey()) { state.configScalarJob = null; state.configScalarError = error.message; if (state.tab === "configs") renderConfigTable(); } }
  }

  function configurationRows() {
    const patterns = state.workspace && state.workspace.state ? state.workspace.state.ignored_configs || [] : [];
    return window.ExpmanConfigurations.orderedRows(state.comparison ? state.comparison.rows : [], state.configOrder)
      .filter(row => row.kind === "scalar" || state.showIgnored || !(row.ignored || window.ExpmanConfigurations.ignoredPath(row.key, patterns)))
      .filter(row => row.kind === "scalar" || !state.diffOnly || row.different)
      .filter(row => (row.key + (row.kind === "scalar" ? " " + window.ExpmanConfigurations.description(row.scalar) : " " + ((configDisplaySpec(row.key) || {}).name || ""))).toLowerCase().includes(state.configQuery.trim().toLowerCase()));
  }

  function updateConfigExclusions(update, afterSave) {
    const saved = (state.configExclusionQueue || Promise.resolve()).then(async () => {
      state.configCompareRequest += 1;
      const changes = typeof update === "function" ? update(state.workspace.state) : update;
      const result = await api("/api/ignored-configs", changes, "PUT");
      state.configCompareRequest += 1;
      Object.assign(state.workspace.state, {ignored_configs: result.ignored_configs, ignored_files: result.ignored_files});
      if (afterSave) afterSave();
      renderChrome(); remember();
      if (state.tab === "configs") renderConfigTable();
    });
    state.configExclusionQueue = saved.catch(() => {});
    return saved.then(refreshConfigExclusions);
  }

  async function setConfigIncluded(key, included) {
    const selected = state.runs.filter(item => state.selected.has(item.id));
    try {
      await updateConfigExclusions(current => window.ExpmanConfigurations.inclusionUpdate(key, included, current, selected), () => {
        if (!state.comparison) return;
        let row = state.comparison.rows.find(row => row.kind !== "scalar" && row.key === key);
        if (!row && included) {
          const cells = state.comparison.experiments.map(item => {
            const run = selected.find(run => run.id === item.id), config = run ? run.config : {};
            return {present: has(config, key), value: has(config, key) ? config[key] : null};
          });
          row = {key, kind: "config", cells, different: new Set(cells.map(label)).size > 1};
          state.comparison.rows.push(row);
        }
        if (row) row.ignored = !included;
      });
    } catch (error) { if (state.tab === "configs") renderConfigTable(); throw error; }
  }

  function exactConfigPath(value) {
    const key = value.trim();
    return key && state.runs.some(item => state.selected.has(item.id) && has(item.config || {}, key)) ? key : "";
  }

  async function includeConfigPath(value) {
    const key = exactConfigPath(value);
    if (!key) throw new Error("Enter a full configuration path from the selected experiments");
    state.configQuery = key; state.configPage = 0; state.diffOnly = false;
    const viewport = byId("config-table-scroll");
    if (viewport) viewport.scrollLeft = 0;
    state.configScrollLeft = 0;
    await setConfigIncluded(key, true);
    if (state.tab === "configs") { renderConfigTable(); byId("config-search").focus({preventScroll: true}); }
    remember(); notify("Configuration included: " + key);
  }

  async function refreshConfigExclusions() {
    const selected = configurationExperimentIds();
    const serial = state.serial, request = ++state.configCompareRequest;
    const result = await api("/api/compare", {experiment_ids: selected, differences_only: false, show_ignored: state.showIgnored, scalar_rows: []});
    if (serial !== state.serial || request !== state.configCompareRequest) return;
    state.keys = result.rows.filter(row => !row.ignored).map(row => row.key);
    if (state.options.group === "config" && state.options.groupKeys.some(key => !state.keys.includes(key))) {
      state.options.group = ""; state.options.groupKeys = state.options.groupKeys.filter(key => state.keys.includes(key));
    }
    state.comparison = result;
    insertScalarRows();
    renderChrome(); remember();
    if (state.tab === "configs") renderConfigTable();
  }

  function configDisplaySpec(key) {
    return has(state.configDisplay, key) ? state.configDisplay[key] : null;
  }

  function configCellText(field, cell, mapped = true) {
    if (field.pending) return "loading…";
    if (!cell || !cell.present) return "";
    return field.kind === "scalar" ? number(cell.value) : mapped ? window.ExpmanConfigurations.displayValue(cell.value, configDisplaySpec(field.key), configValue) : configValue(cell.value);
  }

  function configHeader(field, labels, scalarLabels) {
    const scalar = field.kind === "scalar", key = window.ExpmanConfigurations.rowId(field);
    const patterns = state.workspace && state.workspace.state ? state.workspace.state.ignored_configs || [] : [];
    const ignored = !scalar && (field.ignored || window.ExpmanConfigurations.ignoredPath(field.key, patterns));
    const custom = !scalar && configDisplaySpec(field.key);
    const name = custom && custom.name || (state.configFullNames ? field.key : (scalar ? scalarLabels : labels).get(field.key) || field.key);
    const tooltip = scalar ? window.ExpmanConfigurations.scalarTooltip(field.scalar, window.ExpmanAppearance.normalize(state.workspace.settings.appearance).scalar_color) : field.key;
    const controls = scalar
      ? `<button class="text-button" data-action="edit-config-scalar" data-value="${escape(field.scalar.id)}">Edit</button><button class="icon-button" data-action="remove-config-scalar" data-value="${escape(field.scalar.id)}" aria-label="Remove scalar ${escape(field.key)}" title="Remove this scalar comparison">×</button>`
      : `<input type="checkbox" class="config-include" data-config-include="${escape(field.key)}" ${ignored ? "" : "checked"} aria-label="Include configuration ${escape(field.key)}" title="${ignored ? "Check to include this configuration; removes matching exclusions and restores other configurations covered by those rules" : "Uncheck to ignore this configuration"}"><button class="text-button" data-action="config-display" data-value="${escape(field.key)}" aria-label="Customize text for ${escape(field.key)}" title="Customize column name and value text${custom ? ' · customized' : ''}">Text</button>`;
    return `<th scope="col" class="${ignored ? "config-field-ignored" : ""}" data-config-key="${escape(key)}" data-config-heading="${escape(key)}"><div class="config-field-heading"><div class="config-field-actions"><button class="config-path-drag" type="button" draggable="true" data-config-drag="${escape(key)}" title="Drag to reorder columns · Alt+←/→ to move" aria-label="Reorder ${escape(field.key)}"><span aria-hidden="true">⠿</span></button>${controls}</div><code class="mono config-path-text" title="${escape(tooltip)}">${escape(name)}</code></div>${configResizeHandle(key, field.key)}</th>`;
  }

  function configValueCell(field, index, highlighted, baselineIndex) {
    const cell = field.cells[index] || {present: false, value: null};
    const scalar = field.kind === "scalar", key = window.ExpmanConfigurations.rowId(field);
    const changed = !scalar && baselineIndex >= 0 && index !== baselineIndex && label(cell) !== label(field.cells[baselineIndex] || {present: false, value: null});
    const shade = highlighted ? field.scalar.highlight_color || window.ExpmanAppearance.normalize(state.workspace.settings.appearance).scalar_color : "";
    const style = highlighted ? ` style="--scalar-highlight-background:${shade};--scalar-highlight-ink:${window.ExpmanAppearance.contrastInk(shade)}"` : "";
    const title = cell.present ? typeof cell.value + ": " + configValue(cell.value) : scalar ? "No data at the requested step" : "Not set";
    return `<td class="mono ${scalar ? highlighted ? "scalar-highlight" : "" : changed ? "changed" : ""}" data-config-field="${escape(key)}" title="${escape(title)}"${style}>${field.pending ? '<span class="muted">loading…</span>' : escape(configCellText(field, cell))}</td>`;
  }

  function configValueMeasure() {
    const appearance = window.ExpmanAppearance.normalize(state.workspace.settings.appearance), scale = appearance.font_size / 13;
    const canvas = document.createElement ? document.createElement("canvas") : null;
    const context = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (context) context.font = `${10 * scale}px "SFMono-Regular", Consolas, monospace`;
    const cache = new Map();
    return {scale, measure(value) {
      if (!cache.has(value)) cache.set(value, context ? context.measureText(value).width : Array.from(value).length * 6 * scale);
      return cache.get(value);
    }};
  }

  function configSearchFocus() {
    const input = document.activeElement;
    return input && input.id === "config-search" ? {start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection} : null;
  }

  function restoreConfigSearchFocus(saved) {
    const active = document.activeElement, input = byId("config-search");
    if (!saved || !input || state.tab !== "configs" || active && active !== document.body && active.id !== "config-search") return;
    input.focus({preventScroll: true});
    if (saved.start != null) input.setSelectionRange(saved.start, saved.end, saved.direction);
  }

  function renderConfigTable(searchFocus = null) {
    if (!state.comparison) return;
    if (state.configResizing) { state.configTableNeedsRender = true; return; }
    const focus = configSearchFocus() || searchFocus;
    rememberConfigScroll();
    state.comparison = window.ExpmanConfigurations.selectedComparison(state.comparison, configurationExperimentIds());
    const data = state.comparison, rows = configurationRows();
    const labels = window.ExpmanConfigurations.uniqueSuffixes(data.rows.filter(row => row.kind !== "scalar").map(row => row.key));
    const scalarLabels = window.ExpmanConfigurations.uniqueSuffixes(data.rows.filter(row => row.kind === "scalar").map(row => row.key), "/");
    state.configPage = Math.min(state.configPage, Math.max(0, Math.ceil(rows.length / 50) - 1));
    const fields = rows.slice(state.configPage * 50, (state.configPage + 1) * 50);
    const columns = ["experiment-name"].concat(fields.map(field => window.ExpmanConfigurations.rowId(field)));
    const sizing = configValueMeasure();
    state.configAutoWidths = window.ExpmanConfigurations.automaticWidths(fields, data.experiments, configCellText, sizing.measure, sizing.scale, state.baseline);
    const highlights = new Map(fields.map(field => [window.ExpmanConfigurations.rowId(field), new Set(window.ExpmanConfigurations.highlightedCells(field))]));
    const baselineIndex = data.experiments.findIndex(item => item.id === state.baseline);
    const searchRestrictions = [!state.showIgnored ? "ignored" : "", state.diffOnly ? "identical" : ""].filter(Boolean);
    const searchNotice = state.configQuery.trim() && searchRestrictions.length ? `<div id="config-search-notice" class="notice" role="status">Search excludes ${searchRestrictions.join(" and ")} configurations. <button class="button compact" data-action="search-all-config-fields">Search all fields</button></div>` : "";
    const exactPath = exactConfigPath(state.configQuery);
    byId("view").innerHTML = `<div class="toolbar">
      <label>Fields <input type="search" id="config-search" value="${escape(state.configQuery)}" placeholder="Search fields; Enter includes an exact path" aria-label="Search configuration paths or scalar metrics"></label>${exactPath ? `<button class="button compact" data-action="include-config-path" data-value="${escape(exactPath)}">Include configuration</button>` : ""}
      <label>Baseline <select id="baseline" aria-label="Configuration baseline">${data.experiments.map(item => option(item.id, item.name, state.baseline)).join("")}</select></label>
      <label><input type="checkbox" id="diff-only" ${state.diffOnly ? "checked" : ""}> Config differences only</label>
      <label><input type="checkbox" id="show-ignored" ${state.showIgnored ? "checked" : ""}> Show ignored</label>
      <button class="button compact" data-action="ignored">Manage exclusions</button>
      <button class="button compact" data-action="add-config-scalar" ${!scalarTags().length ? "disabled" : ""}>+ Add scalar</button>
      <button class="button compact" data-action="config-display">Customize text</button>
      <span class="config-display-controls"><span>CONFIGURATION / SCALAR</span><label class="config-full-names"><input type="checkbox" id="config-full-names" ${state.configFullNames ? "checked" : ""}> Full names</label><button id="reset-config-widths" class="icon-button" data-action="reset-config-widths" title="Reset column widths" aria-label="Reset column widths" ${Object.keys(state.configColumnWidths).length ? "" : "disabled"}>↺</button></span>
      <button class="button compact" data-action="reset-config-order" ${state.configOrder.length ? "" : "disabled"}>Reset field order</button>
      <button class="button compact push" data-action="compare-csv">Export CSV ↓</button>
      </div>${searchNotice}<div id="config-scalar-status">${configScalarStatus()}</div><div class="notice">${data.experiments.length} experiment rows · ${rows.length} configuration/scalar fields. Configuration differences use the selected baseline. Drag header grips to reorder columns, or focus a grip and press Alt+←/→. Values determine column widths; names wrap across lines. Uncheck a configuration to ignore it; enable Show ignored and check it to add it back.</div>
      <div class="card"><div id="config-top-scroll" class="config-top-scroll" tabindex="0" role="region" aria-label="Horizontal scrollbar for configuration comparison"><div id="config-scroll-spacer" aria-hidden="true"></div></div><div id="config-table-scroll" class="table-wrap"><table id="config-table" class="config-table"><colgroup>${columns.map(key => `<col data-config-column="${escape(key)}">`).join("")}</colgroup><thead><tr><th scope="col" data-config-heading="experiment-name"><span class="config-experiment-name">EXPERIMENT</span>${configResizeHandle("experiment-name", "Experiment name")}</th>${fields.map(field => configHeader(field, labels, scalarLabels)).join("")}</tr></thead><tbody>${data.experiments.map((item, index) => `<tr data-experiment-id="${escape(item.id)}"><th scope="row" title="${escape(item.name)}"><div class="config-experiment-label"><span class="mono config-experiment-name">${escape(item.name)}</span>${item.id === state.baseline ? '<span class="tag">BASELINE</span>' : ""}</div></th>${fields.map(field => configValueCell(field, index, highlights.get(window.ExpmanConfigurations.rowId(field)).has(index), baselineIndex)).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="table-footer"><span>Fields page ${state.configPage + 1} of ${Math.max(1, Math.ceil(rows.length / 50))} · 50 fields per page · all ${data.experiments.length} experiments</span><div><button class="button compact" data-action="config-prev" ${state.configPage ? "" : "disabled"}>← Previous</button> <button class="button compact" data-action="config-next" ${(state.configPage + 1) * 50 < rows.length ? "" : "disabled"}>Next →</button></div></div></div>${!rows.length ? empty("No matching comparison fields", state.configQuery.trim() ? searchRestrictions.length ? "Search all fields to include ignored and identical configurations, or change the field search." : "No configuration paths or scalar specifications match this search." : "Try showing identical values, adding a scalar, or restoring excluded paths.") : ""}`;
    applyConfigWidths();
    setupConfigScrolling();
    restoreConfigSearchFocus(focus);
  }

  function rememberConfigScroll() {
    const viewport = byId("config-table-scroll");
    if (viewport && Number.isFinite(viewport.scrollLeft)) state.configScrollLeft = viewport.scrollLeft;
    if (viewport && Number.isFinite(viewport.scrollTop)) state.configScrollTop = viewport.scrollTop;
  }

  function disconnectConfigScrolling() {
    if (state.configScrollObserver) state.configScrollObserver.disconnect();
    state.configScrollObserver = null;
  }

  function updateConfigScrollSize() {
    const viewport = byId("config-table-scroll"), top = byId("config-top-scroll"), spacer = byId("config-scroll-spacer");
    if (!viewport || !top || !spacer) return;
    const width = viewport.clientWidth || 0, content = viewport.scrollWidth || 0;
    top.hidden = content <= width;
    top.style.width = width + "px";
    spacer.style.width = content + "px";
    top.scrollLeft = viewport.scrollLeft || 0;
  }

  function setupConfigScrolling() {
    disconnectConfigScrolling();
    const viewport = byId("config-table-scroll"), top = byId("config-top-scroll"), table = byId("config-table");
    if (!viewport || !top || !table) return;
    viewport.scrollLeft = state.configScrollLeft; viewport.scrollTop = state.configScrollTop;
    updateConfigScrollSize();
    top.onscroll = () => { if (viewport.scrollLeft !== top.scrollLeft) viewport.scrollLeft = top.scrollLeft; rememberConfigScroll(); };
    viewport.onscroll = () => { if (top.scrollLeft !== viewport.scrollLeft) top.scrollLeft = viewport.scrollLeft; rememberConfigScroll(); };
    if (window.ResizeObserver) {
      state.configScrollObserver = new window.ResizeObserver(updateConfigScrollSize);
      state.configScrollObserver.observe(viewport); state.configScrollObserver.observe(table);
    }
  }

  window.addEventListener("resize", () => { if (state.tab === "configs") updateConfigScrollSize(); });

  function configResizeHandle(key, name) {
    const minimum = key === "experiment-name" ? 120 : 44;
    return `<span class="config-column-resize" data-config-resize="${escape(key)}" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize ${escape(name)} column" aria-valuemin="${minimum}" aria-valuemax="2000" aria-valuenow="${state.configColumnWidths[key] || (state.configAutoWidths || {})[key] || minimum}" title="Drag to resize · ←/→ adjusts 10px · Shift adjusts 50px"></span>`;
  }

  function readConfigWidths() {
    const table = byId("config-table");
    return table ? Object.fromEntries(Array.from(table.querySelectorAll("[data-config-heading]")).map(header => [header.dataset.configHeading, header.getBoundingClientRect().width])) : {};
  }

  function applyConfigWidths() {
    const table = byId("config-table");
    if (!table) return;
    byId("reset-config-widths").disabled = !Object.keys(state.configColumnWidths).length;
    const measured = readConfigWidths(), columns = Array.from(table.querySelectorAll("col[data-config-column]"));
    const widths = columns.map(column => {
      const key = column.dataset.configColumn;
      const width = window.ExpmanConfigurations.columnWidth(key, state.configColumnWidths[key] || (state.configAutoWidths || {})[key] || measured[key] || 100);
      column.style.width = width + "px";
      return width;
    });
    table.style.width = widths.reduce((total, width) => total + width, 0) + "px";
    table.style.minWidth = table.style.width;
    table.style.setProperty("--config-experiment-width", widths[0] + "px");
    for (const handle of table.querySelectorAll("[data-config-resize]")) handle.setAttribute("aria-valuenow", state.configColumnWidths[handle.dataset.configResize] || (state.configAutoWidths || {})[handle.dataset.configResize] || measured[handle.dataset.configResize]);
    updateConfigScrollSize();
  }

  function finishConfigResize(cancelled = false) {
    const drag = state.configResizing;
    if (!drag) return;
    state.configResizing = null;
    if (cancelled) state.configColumnWidths = drag.saved;
    const redraw = state.configTableNeedsRender || cancelled;
    state.configTableNeedsRender = false;
    if (redraw && state.tab === "configs") renderConfigTable();
    remember();
  }

  document.addEventListener("pointerdown", event => {
    if (state.timeReferenceOpen && !event.target.closest("#time-reference-picker")) closeTimeReference();
    const handle = event.target.closest && event.target.closest("[data-config-resize]");
    if (!handle || (event.button != null && event.button !== 0)) return;
    event.preventDefault();
    const widths = readConfigWidths(), key = handle.dataset.configResize;
    if (!Number.isFinite(widths[key])) return;
    state.configResizing = {key, widths, saved: {...state.configColumnWidths}, start: event.clientX, pointer: event.pointerId};
    if (handle.focus) handle.focus();
    if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", event => {
    const drag = state.configResizing;
    if (!drag || event.pointerId !== drag.pointer) return;
    const width = window.ExpmanConfigurations.columnWidth(drag.key, drag.widths[drag.key] + event.clientX - drag.start);
    state.configColumnWidths = {...drag.saved, [drag.key]: width};
    applyConfigWidths();
  });
  document.addEventListener("pointerup", event => { if (state.configResizing && state.configResizing.pointer === event.pointerId) finishConfigResize(); });
  document.addEventListener("pointercancel", event => { if (state.configResizing && state.configResizing.pointer === event.pointerId) finishConfigResize(true); });

  function moveConfigRow(source, target, before) {
    state.configOrder = window.ExpmanConfigurations.move(state.configOrder, state.comparison.rows, source, target, before);
    const position = configurationRows().findIndex(row => window.ExpmanConfigurations.rowId(row) === source);
    if (position >= 0) state.configPage = Math.floor(position / 50);
    renderConfigTable(); remember();
    const handle = Array.from(document.querySelectorAll("[data-config-drag]")).find(item => item.dataset.configDrag === source);
    if (handle) handle.focus();
  }

  function clearConfigDrop() {
    document.querySelectorAll(".config-drop-before, .config-drop-after, .config-dragging").forEach(row => row.classList.remove("config-drop-before", "config-drop-after", "config-dragging"));
  }

  function configTextRule(rule) {
    return `<div class="config-text-rule" data-config-text-rule><label class="field">Original value<input name="config_original" list="config-observed-values" maxlength="80000" value="${escape(rule ? window.ExpmanConfigurations.valueKey(rule.value) : "")}" placeholder="JSON value or text"></label><label class="field">Display text<input name="config_replacement" maxlength="4000" value="${escape(rule ? rule.text : "")}" placeholder="Custom text; may be empty"></label><button type="button" class="icon-button" data-action="remove-config-text-rule" aria-label="Remove value mapping" title="Remove this mapping">×</button></div>`;
  }

  function renderConfigDisplayEditor() {
    const editing = state.configDisplayEditing;
    if (!editing) return;
    const entry = has(editing.draft, editing.key) ? editing.draft[editing.key] : {name: "", values: []};
    const values = new Map();
    state.runs.filter(run => state.selected.has(run.id) && has(run.config || {}, editing.key)).forEach(run => {
      const value = run.config[editing.key]; values.set(window.ExpmanConfigurations.valueKey(value), value);
    });
    dialog("Customize configuration text", `<label class="field">Configuration path<select id="config-display-key">${editing.keys.map(key => option(key, key, editing.key)).join("")}</select></label>
      <label class="field">Column name<input name="config_display_name" maxlength="4000" value="${escape(entry.name)}" placeholder="Use automatic name"></label>
      <p>A custom name replaces the automatic short or full name. Tooltips retain original paths and values. Comparisons, filters, and CSV exports use original data.</p>
      <p>Map exact values below. Choose a suggested value, enter JSON, or use plain text. Use <code>1</code> for a number and <code>"1"</code> for a string.</p>
      <datalist id="config-observed-values">${Array.from(values.keys()).sort().slice(0, 1000).map(value => `<option value="${escape(value)}"></option>`).join("")}</datalist>
      <div id="config-text-rules">${entry.values.length ? entry.values.map(configTextRule).join("") : configTextRule()}</div>
      <div class="toolbar"><button type="button" class="button compact" data-action="add-config-text-rule">+ Add value mapping</button><button type="button" class="button compact" data-action="reset-config-text">Reset this field</button></div>
      <p id="config-display-error" class="notice warning" role="alert" hidden></p>`, "config-display");
  }

  function configDisplayDialog(key = "") {
    const draft = JSON.parse(JSON.stringify(state.configDisplay));
    const keys = Array.from(new Set(state.runs.filter(run => state.selected.has(run.id)).flatMap(run => Object.keys(run.config || {})).concat(Object.keys(draft)))).sort();
    if (!keys.length) { notify("Select experiments with configuration fields to customize their text"); return; }
    state.configDisplayEditing = {draft, keys, key: keys.includes(key) ? key : keys[0]};
    renderConfigDisplayEditor();
  }

  function collectConfigDisplay() {
    const editing = state.configDisplayEditing, form = byId("dialog").querySelector('[data-form="config-display"]');
    if (!editing || !form) return false;
    const error = byId("config-display-error"); error.hidden = true;
    try {
      const name = form.querySelector('[name="config_display_name"]').value.trim(), values = [], seen = new Set();
      for (const row of form.querySelectorAll("[data-config-text-rule]")) {
        const source = row.querySelector('[name="config_original"]').value, text = row.querySelector('[name="config_replacement"]').value;
        if (!source && !text) continue;
        if (!source.trim()) throw new Error('Enter an original value; use "" for an empty string');
        let value;
        try { value = JSON.parse(source); } catch (parseError) { value = source; }
        const identity = window.ExpmanConfigurations.valueKey(value);
        if (seen.has(identity)) throw new Error("Each original value can have only one display mapping");
        seen.add(identity); values.push({value, text});
      }
      if (values.length > 1000) throw new Error("Use at most 1,000 mappings per configuration path");
      if (name || values.length) editing.draft = {...editing.draft, [editing.key]: {name, values}};
      else delete editing.draft[editing.key];
      return true;
    } catch (failure) { error.textContent = failure.message; error.hidden = false; return false; }
  }

  function saveConfigDisplay() {
    if (!collectConfigDisplay()) return;
    state.configDisplay = window.ExpmanConfigurations.displayPreferences(state.configDisplayEditing.draft);
    state.configDisplayEditing = null;
    byId("dialog").close();
    if (state.tab === "configs") renderConfigTable();
    remember(); notify("Configuration display text saved");
  }

  function scalarModeOptions(tag, mode) {
    return [["latest", "Latest value"], ["latest_smoothed", "Latest smoothed value"], ["at_step", "Value at step"], ["smoothed_at_step", "Smoothed value at step"]].map(([key, text]) => {
      const rendered = option(key, text, mode);
      return state.summaryTags.includes(tag) && key !== "latest" ? rendered.replace("<option ", "<option disabled ") : rendered;
    }).join("");
  }

  function configScalarDialog(identifier = "") {
    const spec = state.configScalars.find(item => item.id === identifier) || {id: "", tag: scalarTags()[0] || "", mode: "latest", step: null, smoothing: .4};
    const tags = Array.from(new Set(scalarTags().concat(spec.tag ? [spec.tag] : [])));
    dialog(spec.id ? "Edit scalar" : "Add scalar", `<input type="hidden" name="scalar_id" value="${escape(spec.id)}">
      <label class="field">Metric<select name="scalar_tag" required>${tags.map(tag => option(tag, tag, spec.tag)).join("")}</select></label>
      <label class="field">Summary<select name="scalar_mode">${scalarModeOptions(spec.tag, spec.mode)}</select></label>
      <label class="field">Training step<input type="number" name="scalar_step" step="any" value="${spec.step == null ? "" : spec.step}" ${spec.mode.includes("step") ? "required" : "disabled"}></label>
      <label class="field">Exponential smoothing<input type="number" name="scalar_smoothing" min="0" max="0.999" step="any" value="${spec.smoothing}" ${spec.mode.includes("smoothed") ? "" : "disabled"}></label>
      <label class="field">Highlight<select name="scalar_highlight">${[["none", "None"], ["largest", "Largest value"], ["smallest", "Smallest value"]].map(([key, text]) => option(key, text, spec.highlight || "none")).join("")}</select></label>
      <label class="field">Highlight color<input type="color" name="scalar_highlight_color" value="${spec.highlight_color || window.ExpmanAppearance.normalize(state.workspace.settings.appearance).scalar_color}"></label>
      <p>All ties for the selected extreme are highlighted. Missing values are excluded.</p>
      <p>Smoothing uses the same exponential average as Overview. Step values interpolate inside the recorded range; cells stay empty for missing metrics or steps outside that range. Imported JSON summary metrics support Latest value only.</p>`, "config-scalar");
  }

  function saveConfigScalar(data) {
    const existing = String(data.get("scalar_id") || ""), mode = String(data.get("scalar_mode"));
    const spec = {id: existing || "metric-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10), tag: String(data.get("scalar_tag") || ""), mode,
      step: mode.includes("step") ? optionalNumber(String(data.get("scalar_step") || "")) : null,
      smoothing: mode.includes("smoothed") ? Number(data.get("scalar_smoothing")) : .4,
      highlight: String(data.get("scalar_highlight") || "none"), highlight_color: String(data.get("scalar_highlight_color") || window.ExpmanAppearance.normalize(state.workspace.settings.appearance).scalar_color)};
    if (!spec.tag || !["latest", "latest_smoothed", "at_step", "smoothed_at_step"].includes(mode)) throw new Error("Choose a scalar metric and summary");
    if (state.summaryTags.includes(spec.tag) && mode !== "latest") throw new Error("JSON summary metrics support Latest value only");
    if (mode.includes("step") && (spec.step == null || !Number.isFinite(spec.step))) throw new Error("Choose a finite training step");
    if (!Number.isFinite(spec.smoothing) || spec.smoothing < 0 || spec.smoothing > .999) throw new Error("Smoothing must be between 0 and 0.999");
    if (!["none", "largest", "smallest"].includes(spec.highlight) || !/^#[0-9a-f]{6}$/i.test(spec.highlight_color)) throw new Error("Choose a valid highlight and color");
    if (!existing && state.configScalars.length >= 100) throw new Error("At most 100 scalar rows can be compared");
    state.configScalars = existing ? state.configScalars.map(item => item.id === existing ? spec : item) : state.configScalars.concat(spec);
    if (!existing) state.configOrder = ["scalar:" + spec.id].concat(state.configOrder);
    state.configQuery = ""; state.configPage = 0;
    return spec;
  }

  document.addEventListener("dragstart", event => {
    const handle = event.target.closest("[data-config-drag]");
    if (!handle) return;
    state.configDragging = handle.dataset.configDrag;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.configDragging);
    handle.closest("[data-config-key]").classList.add("config-dragging");
  });
  document.addEventListener("dragover", event => {
    const row = event.target.closest("[data-config-key]");
    if (!row || !state.configDragging || row.dataset.configKey === state.configDragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearConfigDrop();
    const bounds = row.getBoundingClientRect();
    row.classList.add(event.clientX < bounds.left + bounds.width / 2 ? "config-drop-before" : "config-drop-after");
  });
  document.addEventListener("drop", event => {
    const row = event.target.closest("[data-config-key]");
    if (!row || !state.configDragging) return;
    event.preventDefault();
    const source = state.configDragging, bounds = row.getBoundingClientRect();
    state.configDragging = null; clearConfigDrop();
    moveConfigRow(source, row.dataset.configKey, event.clientX < bounds.left + bounds.width / 2);
  });
  document.addEventListener("dragend", () => { state.configDragging = null; clearConfigDrop(); });

  function automaticRelationshipMetric() {
    const rows = window.ExpmanConfigurations.orderedRows(state.configScalars.map(scalar => ({id: "scalar:" + scalar.id, scalar})), state.configOrder);
    return rows.length ? rows[0].scalar.tag : state.metric || state.tags[0] || "";
  }

  function relationshipMetricOptions() {
    const rows = window.ExpmanConfigurations.orderedRows(state.configScalars.map(scalar => ({id: "scalar:" + scalar.id, scalar})), state.configOrder);
    const tags = Array.from(new Set(rows.map(row => row.scalar.tag).concat(scalarTags(), state.relationshipMetric ? [state.relationshipMetric] : [])));
    return option("", "Automatic · " + (automaticRelationshipMetric() || "no scalar available"), state.relationshipMetric)
      + tags.map(tag => option(tag, tag, state.relationshipMetric)).join("");
  }

  function relationshipMetric() { return state.relationshipMetric || automaticRelationshipMetric(); }

  function relationshipSummary(automatic = false) {
    if (state.summaryTags.includes(relationshipMetric())) return {reduction: "last", smoothing: 0, at_step: null};
    const rows = window.ExpmanConfigurations.orderedRows(state.configScalars.map(scalar => ({id: "scalar:" + scalar.id, scalar})), state.configOrder);
    const row = state.relationshipMetric ? rows.find(row => row.scalar.tag === state.relationshipMetric) : rows[0];
    const scalar = row && row.scalar, settings = state.analysisWindow || {};
    const modes = {latest: "last", latest_smoothed: "last_smoothed", at_step: "at_step", smoothed_at_step: "smoothed_at_step"};
    return {reduction: (!automatic && state.relationshipReduction) || (scalar && modes[scalar.mode]) || (state.summaryTags.includes(relationshipMetric()) ? "last" : state.reduction),
      smoothing: state.relationshipSmoothing != null ? state.relationshipSmoothing : scalar && scalar.smoothing != null ? scalar.smoothing : .4,
      at_step: settings.at_step != null ? settings.at_step : scalar && scalar.step != null ? scalar.step : null};
  }

  function relationshipSummaryLabel(summary) {
    const names = {last: "Final value", last_smoothed: "Final smoothed", best: "Best value", mean: "Mean in window", min: "Minimum", max: "Maximum", at_step: "At fixed step", smoothed_at_step: "Smoothed at fixed step"};
    return names[summary.reduction] + (summary.reduction.includes("step") ? " " + (summary.at_step == null ? "(choose step)" : summary.at_step) : "") + (summary.reduction.includes("smoothed") ? " · smoothing " + summary.smoothing : "");
  }

  function relationshipRequest() {
    return {experiment_ids: ids().sort(), metric: relationshipMetric(), direction: state.direction,
      condition_scope: state.associationScope, configuration_differences_only: state.diffOnly, configuration_query: state.configQuery.trim(),
      categorical_conditions: state.categoricalConditions.slice().sort(), excluded_missing_conditions: state.excludedMissingConditions.slice().sort(), separate_null_conditions: state.separateNullConditions.slice().sort(),
      ...state.analysisWindow, ...relationshipSummary(),
      ...(state.summaryTags.includes(relationshipMetric()) ? {start_step: null, end_step: null} : {})};
  }

  function relationshipKey() {
    const settings = state.workspace ? state.workspace.state : {};
    return JSON.stringify([relationshipRequest(), state.scalarEpoch || 0, settings.ignored_configs, settings.ignored_files,
      ids().sort().map(identifier => { const run = state.runs.find(item => item.id === identifier); return [identifier, run && run.name]; })]);
  }

  async function relationshipApi(path, body) {
    const controller = new AbortController();
    let timedOut = false;
    state.relationshipController = controller;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    try { return await api(path, body, undefined, controller.signal); }
    catch (error) { if (timedOut) throw new Error("The request timed out. Check the server connection and retry."); throw error; }
    finally {
      window.clearTimeout(timer);
      if (state.relationshipController === controller) state.relationshipController = null;
    }
  }

  function cancelRelationships() {
    window.clearTimeout(state.relationshipTimer);
    state.relationshipGeneration += 1;
    if (state.relationshipController) state.relationshipController.abort();
    const previous = state.relationshipJob;
    state.relationshipJob = null; state.relationshipStarting = false; state.relationshipPolling = null;
    state.relationshipKey = ""; state.relationshipError = ""; state.relationshipFailures = 0; state.analysis = null;
    if (previous) fetch("/api/relationships/jobs/" + previous.id + "/cancel", {method: "POST"}).catch(() => {});
  }

  function showRelationshipStatus() {
    if (state.tab !== "analysis" || !byId("analysis-content")) return;
    const job = state.relationshipJob;
    if (state.relationshipError) {
      byId("analysis-content").innerHTML = empty("Could not complete relationship analysis", state.relationshipError)
        + '<button class="button primary" data-action="retry-relationships">Retry</button>'
        + (job ? ' <button class="button" data-action="cancel-relationships">Cancel</button>' : "");
      return;
    }
    const status = job || {percent: 0, stage: "Submitting relationship analysis", elapsed: 0};
    byId("analysis-content").innerHTML = `<div class="notice"><strong>Relationship analysis · ${Math.floor(status.percent || 0)}%</strong><span> · ${escape(status.stage)} · ${Math.floor(status.elapsed || 0)}s${status.metric ? " · " + escape(status.metric) : ""}</span><progress max="100" value="${status.percent || 0}" aria-label="Relationship analysis progress"></progress><button class="button compact" data-action="cancel-relationships">Cancel</button></div>`;
  }

  async function pollRelationships(identifier) {
    if (!state.relationshipJob || state.relationshipJob.id !== identifier) return;
    const generation = state.relationshipGeneration, key = state.relationshipKey;
    const current = () => generation === state.relationshipGeneration && key === relationshipKey() && state.relationshipJob && state.relationshipJob.id === identifier;
    if (state.relationshipPolling && state.relationshipPolling.id === identifier && state.relationshipPolling.generation === generation) return state.relationshipPolling.promise;
    window.clearTimeout(state.relationshipTimer);
    const poll = {id: identifier, generation};
    poll.promise = (async () => {
      try {
        const job = await relationshipApi("/api/relationships/jobs/" + identifier);
        if (!current()) return;
        state.relationshipJob = job; state.relationshipError = "";
        showRelationshipStatus();
        if (job.status === "complete") {
          state.relationshipJob = {...job, stage: "Loading relationship results"}; showRelationshipStatus();
          const result = await relationshipApi("/api/relationships/jobs/" + identifier + "/result");
          if (!current()) return;
          state.analysis = result; state.relationshipJob = null; state.relationshipFailures = 0;
          if (state.tab === "analysis") await renderAnalysis(state.serial);
        } else if (["error", "cancelled"].includes(job.status)) {
          state.relationshipJob = null; state.relationshipError = job.error || "Relationship analysis cancelled.";
          showRelationshipStatus();
        } else {
          state.relationshipFailures = 0;
          state.relationshipTimer = window.setTimeout(() => execute(() => pollRelationships(identifier)), 1000);
        }
      } catch (error) {
        if (!current()) return;
        state.relationshipFailures = (state.relationshipFailures || 0) + 1;
        state.relationshipError = "Could not retrieve relationship progress or results: " + error.message;
        if (error.status === 404) {
          state.relationshipJob = null;
          state.relationshipError = "This analysis is no longer available. Retry to run it again.";
        }
        showRelationshipStatus();
        if (state.relationshipJob && state.relationshipFailures <= 3) state.relationshipTimer = window.setTimeout(() => execute(() => pollRelationships(identifier)), 1000);
      }
    })();
    state.relationshipPolling = poll;
    try { await poll.promise; }
    finally { if (state.relationshipPolling === poll) state.relationshipPolling = null; }
  }

  async function renderAnalysis(serial) {
    if (serial !== state.serial || state.tab !== "analysis") return;
    const key = relationshipKey();
    if (state.relationshipKey !== key) { cancelRelationships(); state.relationshipKey = key; }
    byId("view").innerHTML = `<div class="toolbar"><label>Outcome metric <select id="analysis-metric">${relationshipMetricOptions()}</select></label><label>Conditions <select id="association-scope">${option("configurations", "Configurations view", state.associationScope)}${option("all", "All configs", state.associationScope)}</select></label><label>Summary <select id="reduction">${option("", "Automatic · " + relationshipSummaryLabel(relationshipSummary(true)), state.relationshipReduction)}${[["last", "Final value"], ["last_smoothed", "Final smoothed"], ["best", "Best value"], ["mean", "Mean in window"], ["at_step", "At fixed step"], ["smoothed_at_step", "Smoothed at fixed step"]].map(([key, text]) => option(key, text, state.relationshipReduction)).join("")}</select></label><label>Objective <select id="direction">${option("max", "Maximize", state.direction)}${option("min", "Minimize", state.direction)}</select></label><button class="button compact" data-action="analysis-window">Outcome settings…</button><button class="button compact push" data-action="analysis-csv">Export records ↓</button></div><div id="analysis-content">${loading("Computing outcomes and descriptive associations…")}</div>`;
    if (state.summaryTags.includes(relationshipMetric())) {
      byId("reduction").value = "";
      byId("reduction").querySelectorAll("option").forEach(control => { control.disabled = !["", "last"].includes(control.value); });
      byId("view").querySelectorAll('[data-action="analysis-window"]').forEach(control => { control.disabled = true; control.title = "JSON summary metrics have no step or smoothing history"; });
    }
    if (!relationshipMetric()) { byId("analysis-content").innerHTML = empty("No outcome metric", "Select experiments containing scalar logs."); return; }
    const request = relationshipRequest();
    if (["at_step", "smoothed_at_step"].includes(request.reduction) && request.at_step == null) {
      byId("analysis-content").innerHTML = empty("Choose a comparison step", "Use Step window to set the fixed step. Runs that have not reached it will be excluded."); return;
    }
    if (state.relationshipError) { showRelationshipStatus(); return; }
    if (state.analysis) {
      try { await renderRelationshipResults(); }
      catch (error) { if (key === relationshipKey() && state.tab === "analysis") { state.relationshipError = "Could not display relationship results: " + error.message; showRelationshipStatus(); } }
      return;
    }
    showRelationshipStatus();
    if (state.relationshipStarting) return;
    if (state.relationshipJob) { await pollRelationships(state.relationshipJob.id); return; }
    const generation = state.relationshipGeneration;
    state.relationshipStarting = true;
    try {
      const job = await relationshipApi("/api/relationships/jobs", request);
      if (generation !== state.relationshipGeneration || key !== relationshipKey()) {
        fetch("/api/relationships/jobs/" + job.id + "/cancel", {method: "POST"}).catch(() => {}); return;
      }
      state.relationshipStarting = false; state.relationshipJob = job;
      await pollRelationships(job.id);
    } catch (error) {
      if (generation !== state.relationshipGeneration || key !== relationshipKey()) return;
      state.relationshipStarting = false; state.relationshipError = "Could not start relationship analysis: " + error.message;
      showRelationshipStatus();
    }
  }

  async function renderRelationshipResults() {
    const data = state.analysis, serial = state.serial;
    const keys = window.ExpmanRelationships.keys(data);
    if (!keys.includes(state.condition)) state.condition = data.associations.length ? data.associations[0].key : keys[0] || "";
    state.parallelKeys = state.parallelKeys.filter(key => keys.includes(key));
    if (!state.parallelKeys.length && !state.parallelKeysConfigured) state.parallelKeys = window.ExpmanRelationships.defaults(data);
    byId("analysis-content").innerHTML = `<div class="notice">${data.records.length} outcomes · ${data.missing_metric} runs without an outcome in this window. ${escape(data.note)} Associations use ${keys.length} configuration paths from ${state.associationScope === "all" ? "All configs" : "the Configurations view filters"}.</div><div class="analysis-grid"><article class="card"><header class="card-header"><div><h2 class="card-title">Condition associations</h2><div class="card-subtitle"><a href="https://en.wikipedia.org/wiki/Spearman%27s_rank_correlation_coefficient" target="_blank" rel="noopener noreferrer" title="Wikipedia: Spearman rank correlation">|SPEARMAN ρ| · NUMERIC</a> / <a href="https://en.wikipedia.org/wiki/Correlation_ratio" target="_blank" rel="noopener noreferrer" title="Wikipedia: correlation ratio">√η² · CATEGORICAL</a></div></div></header><div class="association-list">${data.associations.slice(0, 80).map(item => `<button class="association ${item.key === state.condition ? "active" : ""}" data-action="condition" data-value="${escape(item.key)}"><div class="association-top"><span title="${escape(item.key)}">${escape(item.key)}</span><strong>${number(item.association)}</strong></div><div class="association-track"><div class="association-bar" style="width:${Math.min(100, item.association * 100)}%"></div></div><div class="card-subtitle">${item.kind} · n = ${item.count}</div></button>`).join("") || '<p class="muted">' + (keys.length ? 'At least three outcomes and varying conditions are needed for ranking.' : 'No configuration paths match. Change the Configurations filters or choose All configs.') + '</p>'}</div></article><article class="card"><header class="card-header condition-header"><div style="min-width:0"><h2 class="card-title">Condition and outcome</h2><div class="card-subtitle" id="condition-note"></div></div><div class="condition-controls"><label>Condition <select id="condition-select" aria-label="Condition">${keys.map(key => option(key, key, state.condition)).join("")}</select></label><label>Type <select id="condition-type" aria-label="Condition type">${option("auto", "Automatic", state.categoricalConditions.includes(state.condition) ? "categorical" : "auto")}${option("categorical", "Categorical", state.categoricalConditions.includes(state.condition) ? "categorical" : "auto")}</select></label><label><input type="checkbox" id="condition-missing"> Include missing as a category</label><label><input type="checkbox" id="condition-merge-null" checked> Merge missing and null</label></div></header><div id="condition-chart" class="chart" style="height:350px"></div></article></div><article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Parallel coordinates</h2><div class="card-subtitle" id="parallel-note">One line per experiment · color encodes the outcome</div></div><div class="card-actions"><button class="button compact" data-action="parallel-keys">Dimensions</button><button class="button compact" data-action="reset-parallel">Reset dimensions</button><button class="button compact" data-action="clear-parallel-brush">Clear brush</button><button class="button compact" id="apply-brush" data-action="apply-brush" disabled>Use brushed runs</button></div></header><p class="notice">Each line connects one experiment’s conditions and metric value. Drag vertically on an axis to select a range, then use brushed runs to apply it. Missing conditions appear at a labeled (missing) position.</p><div id="parallel-error" class="notice warning" hidden></div><div id="parallel-chart" class="parallel-chart"></div></article>`;
    await renderCondition();
    if (serial !== state.serial || data !== state.analysis || state.tab !== "analysis") return;
    await renderParallel();
  }

  function conditionDisplayData(data) {
    return {...data, categorical_conditions: state.categoricalConditions, missing_conditions: null,
      excluded_missing_conditions: state.excludedMissingConditions, separate_null_conditions: state.separateNullConditions};
  }

  async function renderCondition() {
    if (!state.analysis || !byId("condition-chart")) return;
    prepareExperimentColors();
    const serial = state.serial, data = state.analysis;
    const grouped = window.ExpmanRelationships.condition(conditionDisplayData(data), state.condition);
    const active = Boolean(state.condition && data.records.length);
    byId("condition-type").value = state.categoricalConditions.includes(state.condition) ? "categorical" : "auto";
    byId("condition-type").disabled = !active;
    byId("condition-missing").checked = grouped.includeMissing;
    byId("condition-missing").disabled = !active;
    byId("condition-merge-null").checked = !state.separateNullConditions.includes(state.condition);
    byId("condition-merge-null").disabled = !active || !grouped.includeMissing;
    const records = grouped.entries.map(entry => entry.record);
    if (!records.length) {
      if (window.Plotly) Plotly.purge(byId("condition-chart"));
      byId("condition-chart").innerHTML = empty(state.condition ? "No outcomes with this condition" : "Choose a condition", "Choose another condition, include missing as a category, adjust the Configurations path filters, or select All configs.");
      byId("condition-note").textContent = "No matching outcomes";
      return;
    }
    const numeric = grouped.numeric, categories = grouped.categories;
    const positions = categories.map((item, index) => "condition-" + index);
    const categoryLabels = categories.map(item => plotText(item.name));
    const pointTooltip = "%{text}<br>Metric value: %{y:.5g}<extra></extra>";
    const points = {y: records.map(record => record.result), text: records.map(record => plotText(record.name)), name: "Experiments", mode: "markers", type: "scatter", marker: {size: 9, color: records.map(record => experimentColor(record.id)), line: {width: 1, color: "white"}}, hovertemplate: pointTooltip};
    const traces = numeric ? [{...points, x: grouped.entries.map(entry => entry.value)}] : categories.map((category, index) => {
      const matching = grouped.entries.filter(entry => entry.id === category.id).map(entry => entry.record);
      return {type: "box", name: categoryLabels[index], x: matching.map(() => positions[index]), y: matching.map(record => record.result), hoverinfo: "skip", boxpoints: false, marker: {color: palette[index % palette.length]}, line: {width: 1.5}};
    }).concat({...points, x: grouped.entries.map(entry => positions[categories.findIndex(category => category.id === entry.id)])});
    const categoryAxis = numeric ? {} : {type: "category", categoryorder: "array", categoryarray: positions, tickmode: "array", tickvals: positions, ticktext: categoryLabels, automargin: true};
    await plot(byId("condition-chart"), traces, {showlegend: false, margin: {l: 55, r: 20, t: 20, b: 75}, xaxis: {title: {text: plotText(state.condition), font: {size: 9}}, gridcolor: "#f0f3f8", ...categoryAxis}, yaxis: {title: {text: plotText(state.analysis.metric || relationshipMetric()), font: {size: 9}}, gridcolor: "#edf1f8"}});
    if (serial !== state.serial || data !== state.analysis || state.tab !== "analysis") return;
    const association = state.analysis.associations.find(item => item.key === state.condition);
    const missingNote = grouped.includeMissing ? grouped.mergeNull ? "missing/null merged" : "missing included; null separate" : `${grouped.missing} missing excluded`;
    byId("condition-note").textContent = `n = ${records.length} · ${numeric ? "Numeric" : "Categorical"} · ${missingNote}${association && numeric ? ` · Pearson ${number(association.pearson)} · Spearman ${number(association.spearman)}` : ""}`;
  }

  function parallelDialog() {
    const choices = window.ExpmanRelationships.available(state.analysis);
    dialog("Parallel coordinates dimensions", `<p>Choose up to 10 conditions. The outcome metric is always included. Counts show experiments with that configuration value; missing values remain visible.</p><label class="field">Search<input type="search" id="choice-search" placeholder="Filter available fields…"></label><div class="check-list">${choices.map(item => `<label data-choice="${escape(item.key.toLowerCase())}"><input type="checkbox" name="choices" value="${escape(item.key)}" ${state.parallelKeys.includes(item.key) ? "checked" : ""}><span>${escape(item.key)}<small> · ${item.count} of ${item.total} experiments · ${item.distinct} distinct values</small></span></label>`).join("")}</div>`, "parallel-keys");
  }

  async function renderParallel() {
    if (!state.analysis || state.tab !== "analysis" || !byId("parallel-chart")) return;
    const element = byId("parallel-chart"), serial = state.serial, data = state.analysis;
    const revision = state.parallelRevision = (state.parallelRevision || 0) + 1;
    const current = () => state.tab === "analysis" && serial === state.serial && data === state.analysis && revision === state.parallelRevision;
    state.brushed = [];
    byId("apply-brush").disabled = true; byId("apply-brush").textContent = "Use brushed runs";
    byId("parallel-error").hidden = true;
    if (element.removeListener && element.expmanBrushHandler) element.removeListener("plotly_restyle", element.expmanBrushHandler);
    element.expmanBrushHandler = null;
    const built = window.ExpmanRelationships.build(conditionDisplayData(data), state.parallelKeys, data.metric || relationshipMetric() || "Outcome");
    if (!built.records.length || !state.parallelKeys.length) {
      if (window.Plotly) Plotly.purge(element);
      element.innerHTML = empty(built.records.length ? "Choose varying dimensions" : "No outcomes to plot", built.records.length ? "Use Dimensions or Reset dimensions to choose configuration conditions. Choose All configs to expand the available paths." : "Select experiments with values for the chosen outcome metric.");
      byId("parallel-note").textContent = built.records.length + " experiments with outcomes";
      return;
    }
    const dimensions = built.dimensions.map(item => ({...item, label: plotText(item.label), ...(item.ticktext ? {ticktext: item.ticktext.map(plotText)} : {})}));
    try {
      await plot(element, [{type: "parcoords", line: {color: built.records.map(record => record.result), colorscale: "Viridis", showscale: true, colorbar: {thickness: 8, len: .8}}, dimensions, labelfont: {size: 10}, tickfont: {size: 9}}], {margin: {l: 60, r: 80, t: 65, b: 30}, uirevision: revision});
      if (!current()) return;
      byId("parallel-note").textContent = `${built.records.length} experiments · ${built.incomplete} have missing conditions · drag vertically on an axis to brush`;
      element.expmanBrushHandler = () => {
        if (!current() || !element.data || !element.data[0]) return;
        state.brushed = window.ExpmanRelationships.brushed(built.records, element.data[0].dimensions);
        byId("apply-brush").disabled = !state.brushed.length;
        byId("apply-brush").textContent = `Use ${state.brushed.length || "brushed"} runs`;
      };
      element.on("plotly_restyle", element.expmanBrushHandler);
    } catch (error) {
      if (!current()) return;
      if (window.Plotly) Plotly.purge(element);
      element.innerHTML = "";
      byId("parallel-error").hidden = false;
      byId("parallel-error").innerHTML = `Could not draw parallel coordinates: ${escape(error.message)} <button class="button compact" data-action="retry-parallel">Retry plot</button>`;
    }
  }

  function onsetControls() {
    const time = state.time;
    return `<label>Smoothing span <input required type="number" id="onset-smoothing" min="0" step="any" value="${time.onset_smoothing}"></label>
      <label>Sustain span <input required type="number" id="onset-duration" min="0.000001" step="any" value="${time.onset_duration}"></label>
      <label>Onset threshold <input required type="number" id="onset-threshold" min="1" step="any" value="${time.onset_threshold}" title="Departure from the preceding baseline in robust noise units"></label>
      <label>Min |correlation| <input required type="number" id="onset-min-correlation" min="0" max="1" step="any" value="${time.onset_min_correlation}"></label>
      <details class="onset-options"><summary>Baseline and matching settings</summary><div class="toolbar">
      <label>Baseline from <input type="number" id="onset-baseline-start" step="any" value="${time.onset_baseline_start == null ? "" : time.onset_baseline_start}" placeholder="Automatic"></label>
      <label>Baseline to <input type="number" id="onset-baseline-end" step="any" value="${time.onset_baseline_end == null ? "" : time.onset_baseline_end}" placeholder="From"></label>
      <label>Min |change correlation| <input required type="number" id="onset-min-change-correlation" min="0" max="1" step="any" value="${time.onset_min_change_correlation}"></label></div>
      <p>Spans use the selected axis units. From/To selects the change interval. An automatic baseline uses the preceding half-interval; without From, it uses the first quarter of the reference range. Only preceding observations fit the baseline. Continuous curves use median/MAD noise; binary curves use a smoothed Bernoulli baseline.</p></details>`;
  }

  function timeEmptyTitle() {
    return state.time.mode === "onsets" ? "Compare related changes and onset order" : state.time.mode === "periodicity" ? "Discover possible periodic behavior" : "Investigate events across curves";
  }

  function updateTimeReference(reset = false) {
    const input = byId("time-reference"), list = byId("time-reference-list"), menu = byId("time-reference-menu"), time = state.time;
    if (!input || !list || !menu) return;
    const query = state.timeReferenceQuery.trim().toLowerCase(), matches = time.tags.filter(tag => tag.toLowerCase().includes(query));
    const retained = Boolean(time.reference && time.tags.includes(time.reference) && !matches.includes(time.reference));
    const automatic = time.mode === "onsets" ? "Choose a reference curve" : "Automatic · strongest activity";
    const choices = [{value: "", text: automatic}, ...(retained ? [{value: time.reference, text: time.reference + " (selected)"}] : []), ...matches.map(tag => ({value: tag, text: tag}))];
    list.expmanChoices = choices;
    if (reset) {
      const value = query ? matches[0] : time.reference;
      state.timeReferenceIndex = value == null ? -1 : choices.findIndex(choice => choice.value === value);
    }
    if (state.timeReferenceIndex >= choices.length) state.timeReferenceIndex = -1;
    input.value = state.timeReferenceOpen ? state.timeReferenceQuery : time.reference;
    input.placeholder = automatic;
    input.title = time.reference || automatic;
    input.dataset.referenceValue = time.reference;
    input.setAttribute("aria-expanded", String(state.timeReferenceOpen));
    if (state.timeReferenceOpen && state.timeReferenceIndex >= 0) input.setAttribute("aria-activedescendant", "time-reference-option-" + state.timeReferenceIndex);
    else input.removeAttribute("aria-activedescendant");
    menu.hidden = !state.timeReferenceOpen;
    list.innerHTML = choices.map((choice, index) => `<div id="time-reference-option-${index}" role="option" aria-selected="${choice.value === time.reference}" data-time-reference-choice="${escape(choice.value)}"${index === state.timeReferenceIndex ? ' class="active"' : ""} title="${escape(choice.text)}">${escape(choice.text)}</div>`).join("");
    byId("time-reference-count").textContent = (matches.length ? `${matches.length} matching ${matches.length === 1 ? "curve" : "curves"}` : "No matching curves") + (retained ? " · selected reference retained" : "");
    if (state.timeReferenceOpen) {
      const bounds = byId("time-reference-picker").getBoundingClientRect(), width = Math.min(480, window.innerWidth - 24);
      const above = window.innerHeight - bounds.bottom < 200 && bounds.top > 200;
      menu.style.width = width + "px";
      menu.style.left = Math.max(12 - bounds.left, Math.min(0, window.innerWidth - 12 - bounds.left - width)) + "px";
      menu.style.top = above ? "auto" : "calc(100% + 4px)";
      menu.style.bottom = above ? "calc(100% + 4px)" : "auto";
      list.style.maxHeight = Math.max(64, Math.min(260, (above ? bounds.top : window.innerHeight - bounds.bottom) - 50)) + "px";
      const active = byId("time-reference-option-" + state.timeReferenceIndex);
      if (active) active.scrollIntoView({block: "nearest"});
    }
  }

  function openTimeReference() {
    if (state.timeReferenceOpen) return;
    state.timeReferenceOpen = true; state.timeReferenceQuery = "";
    updateTimeReference(true);
  }

  function closeTimeReference() {
    state.timeReferenceOpen = false; state.timeReferenceQuery = ""; state.timeReferenceIndex = -1;
    updateTimeReference();
  }

  async function chooseTimeReference(value) {
    if (value && !state.time.tags.includes(value)) return;
    if (state.time.reference === value) { closeTimeReference(); return; }
    const cancellation = cancelTime(), generation = state.timeGeneration;
    state.time.reference = value;
    closeTimeReference(); updateTimeSettings();
    try { await cancellation; } catch (error) { if (generation === state.timeGeneration) { state.timeError = "Could not confirm cancellation: " + error.message; showTimeError(); } }
  }

  function bindTimeReference() {
    const picker = byId("time-reference-picker"), input = byId("time-reference");
    input.addEventListener("focus", openTimeReference);
    input.addEventListener("input", () => {
      state.timeReferenceOpen = true; state.timeReferenceQuery = input.value;
      updateTimeReference(true);
    });
    picker.addEventListener("pointerdown", event => {
      if (event.target.closest("[data-time-reference-choice], [data-time-reference-toggle]")) event.preventDefault();
    });
    picker.addEventListener("click", event => {
      const choice = event.target.closest("[data-time-reference-choice]");
      if (choice) { execute(() => chooseTimeReference(choice.dataset.timeReferenceChoice)); return; }
      if (event.target.closest("[data-time-reference-toggle]")) {
        if (state.timeReferenceOpen) closeTimeReference();
        else { input.focus(); openTimeReference(); }
      } else if (event.target === input) openTimeReference();
    });
    picker.addEventListener("focusout", event => { if (!picker.contains(event.relatedTarget)) closeTimeReference(); });
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (!state.timeReferenceOpen) { openTimeReference(); return; }
        const count = byId("time-reference-list").expmanChoices.length;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        state.timeReferenceIndex = state.timeReferenceIndex < 0 ? direction > 0 ? 0 : count - 1 : (state.timeReferenceIndex + direction + count) % count;
        updateTimeReference();
      } else if (event.key === "Enter" && state.timeReferenceOpen) {
        event.preventDefault();
        const choice = byId("time-reference-list").expmanChoices[state.timeReferenceIndex];
        if (choice) execute(() => chooseTimeReference(choice.value));
      } else if (["Escape", "Tab"].includes(event.key) && state.timeReferenceOpen) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        closeTimeReference();
      }
    });
  }

  async function renderTime(serial) {
    if (!state.time.experiment || !state.runs.some(item => item.id === state.time.experiment)) state.time.experiment = ids()[0] || (state.runs[0] && state.runs[0].id) || "";
    if (!state.time.experiment) { byId("view").innerHTML = empty("No experiments", "Point Expman at a directory containing TensorBoard event files."); return; }
    if (state.timeReferenceExperiment !== state.time.experiment) { state.timeReferenceQuery = ""; state.timeReferenceOpen = false; state.timeReferenceIndex = -1; state.timeReferenceExperiment = state.time.experiment; }
    if (state.time.loadedExperiment !== state.time.experiment) {
      byId("view").innerHTML = loading("Discovering scalar curves for this experiment…");
      const result = await api("/api/metrics", {experiment_ids: [state.time.experiment]});
      if (serial !== state.serial) return;
      mergeRuns(result.experiments, true);
      state.time.available = result.tags;
      state.time.loadedExperiment = state.time.experiment;
      state.timeData = null;
    }
    const time = state.time, periodic = time.mode === "periodicity", onsets = time.mode === "onsets";
    const matched = window.ExpmanSignals.select(time.available, time.include, time.exclude);
    time.tags = matched;
    if (!matched.includes(time.reference)) time.reference = "";
    const running = Boolean(state.timeStarting || state.timeJob);
    const referenceFocused = document.activeElement && document.activeElement.id === "time-reference";
    const referenceDraft = state.timeReferenceOpen ? {query: state.timeReferenceQuery, index: state.timeReferenceIndex} : null;
    byId("view").innerHTML = `<div class="toolbar"><label>Experiment <select id="time-experiment">${state.runs.map(item => option(item.id, item.name, time.experiment)).join("")}</select></label><label>Investigation <select id="time-mode">${option("events", "Events and timing", time.mode)}${option("periodicity", "Periodic behavior", time.mode)}${option("onsets", "Related changes and onsets", time.mode)}</select></label><div class="time-reference-field"><label for="time-reference">Reference</label><div id="time-reference-picker" class="time-reference-picker"><input id="time-reference" type="text" role="combobox" aria-label="Reference curve" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="time-reference-list" autocomplete="off" spellcheck="false"><button type="button" class="time-reference-toggle" data-time-reference-toggle aria-label="Show reference curves" tabindex="-1">▾</button><div id="time-reference-menu" class="time-reference-menu" hidden><div id="time-reference-list" role="listbox" aria-label="Reference curves"></div><div id="time-reference-count" class="muted" role="status" aria-live="polite"></div></div></div></div><button class="button primary compact push" id="analyze-time-button" data-action="analyze-time" ${running ? "disabled" : ""}>Analyze ${matched.length} curves</button></div><div class="time-patterns"><label class="field">Include tag patterns<textarea id="time-include" rows="2" placeholder="*">${escape(time.include.join("\n"))}</textarea></label><label class="field">Exclude tag patterns<textarea id="time-exclude" rows="2" placeholder="*/learning_rate&#10;*debug*">${escape(time.exclude.join("\n"))}</textarea></label><p class="muted" id="time-scope-note">All scalar curves by default. One case-sensitive glob per line: * any text, ? one character, [abc] a set. Exclusions take priority. ${matched.length} of ${time.available.length} curves match.</p></div><div class="toolbar"><label>Axis <select id="time-axis">${[["step", "Training step"], ["relative", "Elapsed seconds"], ["wall", "Unix seconds"]].map(([key, text]) => option(key, text, time.x_axis)).join("")}</select></label><label>From <input type="number" id="time-start" value="${time.start == null ? "" : time.start}" placeholder="Start"></label><label>To <input type="number" id="time-end" value="${time.end == null ? "" : time.end}" placeholder="End"></label>${onsets ? onsetControls() : `<label>Binary context <input type="number" id="binary-window" min="31" max="100001" step="1" value="${time.binary_window}" title="Context in logged observations for 0/1 curves; default 1001, clipped to available history"></label>`}${onsets ? "" : periodic ? `<label>Min period <input type="number" id="min-period" min="0" value="${time.min_period == null ? "" : time.min_period}" placeholder="Auto"></label><label>Max period <input type="number" id="max-period" min="0" value="${time.max_period == null ? "" : time.max_period}" placeholder="Auto"></label><label>Phase period <input type="number" id="phase-period" min="0" value="${time.phase_period == null ? "" : time.phase_period}" placeholder="Top peak"></label><label><input type="checkbox" id="period-detrend" ${time.detrend ? "checked" : ""}> Remove trend</label><label><input type="checkbox" id="period-windowed" ${time.windowed ? "checked" : ""}> Moving windows</label>` : `<label>Detector <select id="event-detector">${option("spike", "Spikes and dips", time.detector)}${option("change", "Abrupt changes", time.detector)}</select></label><label title="Compare with the expected cycle phase and normal variation between cycles"><input type="checkbox" id="event-period-aware" ${time.period_aware !== false ? "checked" : ""}> Account for periodic fluctuation</label><label>Threshold · event score <input title="Minimum absolute event score. Continuous curves use median/MAD; binary curves use a smoothed Bernoulli model with a long context" type="number" id="event-threshold" min="1" step="0.5" value="${time.threshold}"></label><label>Continuous window <input title="Local median/MAD window for continuous-valued curves; binary curves use Binary context" type="number" id="event-window" min="5" max="501" step="2" value="${time.window}"></label><label>Match tolerance <input type="number" id="event-tolerance" min="0" value="${time.tolerance}"></label><label>Max lag <input type="number" id="event-max-lag" min="0" value="${time.max_lag}"></label>`}</div><div id="time-progress" class="notice" role="status" ${running ? "" : "hidden"}><div class="toolbar"><strong id="time-progress-text">Starting analysis…</strong><button class="button compact push" data-action="cancel-time">Cancel</button></div><progress id="time-progress-bar" max="100" value="0" aria-label="Time-series analysis progress"></progress><div class="muted" id="time-progress-metric"></div></div><div id="time-error" class="notice warning" role="alert" hidden></div><div id="time-results"></div>`;
    bindTimeReference();
    if (referenceDraft) { state.timeReferenceOpen = true; state.timeReferenceQuery = referenceDraft.query; state.timeReferenceIndex = referenceDraft.index; }
    updateTimeReference(); updateTimeStatus();
    if (referenceFocused) byId("time-reference").focus({preventScroll: true});
    if (running) { if (!state.timeStarting && state.timeJob) execute(() => pollTimeJob(state.timeJob.id)); return; }
    if (state.timeError) return;
    if (!state.timeData) {
      byId("time-results").innerHTML = empty(timeEmptyTitle(), onsets ? "Choose a reference curve, set From/To around the change, and click Analyze. Results can be ordered by correlation or earliest sustained onset." : "Click Analyze to investigate every matching scalar curve. Results are browsable in small chart groups, and full analysis is available for export.");
      return;
    }
    try { if (onsets) await renderOnsets(); else if (periodic) await renderPeriodicity(); else await renderEvents(); }
    catch (error) { state.timeError = "Could not display the analysis: " + error.message; showTimeError(); }
  }

  function showTimeError() {
    const target = byId("time-error");
    if (state.tab !== "time" || !target) return;
    target.hidden = !state.timeError;
    const label = state.timeJob ? "Retry connection" : state.timeData ? "Retry displaying results" : "Retry analysis";
    target.innerHTML = state.timeError ? `${escape(state.timeError)} <button class="button compact" data-action="retry-time">${label}</button>` : "";
  }

  function showTimeProgress(job) {
    if (state.tab !== "time" || !byId("time-progress")) return;
    byId("time-progress").hidden = false;
    byId("time-progress-text").textContent = `${Math.floor(job.percent || 0)}% · ${job.stage} · ${Math.floor(job.elapsed || 0)}s`;
    byId("time-progress-bar").value = job.percent || 0;
    byId("time-progress-metric").textContent = job.metric || "";
  }

  function updateTimeStatus() {
    if (state.tab !== "time") return;
    const running = Boolean(state.timeStarting || state.timeJob), button = byId("analyze-time-button");
    if (button) {
      button.disabled = running || !state.time.tags.length || state.time.mode === "onsets" && !state.time.reference;
      button.textContent = state.timeStarting ? "Starting analysis…" : running ? "Analyzing…" : `Analyze ${state.time.tags.length} curves`;
    }
    if (state.timeStarting) {
      showTimeProgress({percent: 0, stage: "Submitting analysis request", elapsed: 0});
      byId("time-results").innerHTML = loading("Submitting analysis request…");
    } else if (state.timeJob) showTimeProgress(state.timeJob);
    else {
      if (byId("time-progress")) byId("time-progress").hidden = true;
      if (!state.timeData && byId("time-results")) byId("time-results").innerHTML = state.timeError ? "" : empty(timeEmptyTitle(), "Click Analyze to investigate every matching scalar curve. Results are browsable in small chart groups, and full analysis is available for export.");
    }
    showTimeError();
  }

  function updateTimeSettings() {
    const time = state.time;
    time.tags = window.ExpmanSignals.select(time.available, time.include, time.exclude);
    if (!time.tags.includes(time.reference)) time.reference = "";
    state.timeData = null; state.timeError = ""; state.timePlotPage = 0;
    if (state.tab === "time") {
      updateTimeReference();
      byId("time-scope-note").textContent = `All scalar curves by default. One case-sensitive glob per line: * any text, ? one character, [abc] a set. Exclusions take priority. ${time.tags.length} of ${time.available.length} curves match.`;
      updateTimeStatus();
    }
    remember();
  }

  async function pollTimeJob(identifier) {
    if (!state.timeJob || state.timeJob.id !== identifier) return;
    const generation = state.timeGeneration;
    if (state.timePolling && state.timePolling.id === identifier && state.timePolling.generation === generation) return state.timePolling.promise;
    window.clearTimeout(state.timeTimer);
    const poll = {id: identifier, generation};
    const current = () => generation === state.timeGeneration && state.timeJob && state.timeJob.id === identifier;
    poll.promise = (async () => {
      try {
        const job = await api("/api/analysis/jobs/" + identifier);
        if (!current()) return;
        state.timeJob = job; state.timeError = "";
        showTimeProgress(job); showTimeError();
        if (job.status === "complete") {
          showTimeProgress({...job, stage: "Loading analysis results"});
          const result = await api("/api/analysis/jobs/" + identifier + "/result");
          if (!current()) return;
          state.timeData = result; state.timeJob = null; state.timePollFailures = 0;
          if (state.tab === "time") await renderView();
          else notify("Time-series analysis complete");
        } else if (["error", "cancelled"].includes(job.status)) {
          state.timeJob = null; state.timeError = job.error || "Analysis cancelled";
          if (state.tab === "time") await renderView();
          else notify(state.timeError, job.status === "error");
        } else {
          state.timePollFailures = 0;
          state.timeTimer = window.setTimeout(() => execute(() => pollTimeJob(identifier)), 500);
        }
      } catch (error) {
        if (!current()) return;
        state.timePollFailures = (state.timePollFailures || 0) + 1;
        state.timeError = "Could not retrieve analysis progress or results: " + error.message;
        if (error.status === 404) {
          state.timeJob = null;
          state.timeError = "This analysis is no longer available. Run the analysis again.";
        }
        updateTimeStatus();
        if (state.timeJob && state.timePollFailures <= 3) state.timeTimer = window.setTimeout(() => execute(() => pollTimeJob(identifier)), 1000);
      }
    })();
    state.timePolling = poll;
    try { await poll.promise; }
    finally { if (state.timePolling === poll) state.timePolling = null; }
  }

  async function cancelTime() {
    window.clearTimeout(state.timeTimer);
    const job = state.timeJob;
    state.timeGeneration += 1; state.timeJob = null; state.timeStarting = false;
    state.timeRequestKey = ""; state.timePolling = null; state.timeError = ""; state.timePollFailures = 0;
    if (job && job.id) await api("/api/analysis/jobs/" + job.id + "/cancel", {});
  }

  async function analyzeTime() {
    if (state.timeStarting) return;
    const time = state.time;
    if (!time.tags.length) { state.timeError = "No scalar curves match these patterns"; updateTimeStatus(); return; }
    if (time.mode === "onsets" && !time.reference) { state.timeError = "Choose a reference curve for sustained-change analysis"; updateTimeStatus(); return; }
    const request = {kind: time.mode, experiment_id: time.experiment, include: time.include.slice(), exclude: time.exclude.slice(), reference: time.reference || null, x_axis: time.x_axis, start: time.start, end: time.end, binary_window: time.binary_window};
    if (time.mode === "events") Object.assign(request, {threshold: time.threshold, window: time.window, period_aware: time.period_aware, detector: time.detector, tolerance: time.tolerance, max_lag: time.max_lag});
    else if (time.mode === "onsets") Object.keys(window.ExpmanOnsets.defaults).filter(key => !["onset_sort", "onset_show_all"].includes(key)).forEach(key => { request[key] = time[key]; });
    else Object.assign(request, {min_period: time.min_period, max_period: time.max_period, phase_period: time.phase_period, detrend: time.detrend, windowed: time.windowed});
    const cancellation = cancelTime(), generation = state.timeGeneration, key = JSON.stringify(request);
    state.timeStarting = true; state.timeRequestKey = key; state.timeData = null; state.timePlotPage = 0;
    updateTimeStatus();
    try {
      await cancellation;
      if (generation !== state.timeGeneration) return;
      const job = await api("/api/analysis/jobs", request);
      if (generation !== state.timeGeneration) {
        if (state.timeRequestKey !== key) await fetch("/api/analysis/jobs/" + job.id + "/cancel", {method: "POST"}).catch(() => {});
        return;
      }
      state.timeStarting = false; state.timeJob = job;
      if (state.tab === "time") await renderView();
      await pollTimeJob(job.id);
    } catch (error) {
      if (generation !== state.timeGeneration) return;
      state.timeStarting = false; state.timeJob = null;
      state.timeError = "Could not start the analysis: " + error.message;
      updateTimeStatus();
      if (state.tab !== "time") notify(state.timeError, true);
    }
  }

  function timeDisplay(tags, analyzedCount = tags.length) {
    const page = window.ExpmanPanels.page(tags, state.timePlotQuery || "", state.timePlotPage || 0, 8);
    state.timePlotPage = page.page;
    return {tags: page.tags, html: `<div class="toolbar"><strong>${analyzedCount} curves analyzed</strong><label>Browse results <input id="time-result-filter" type="search" value="${escape(state.timePlotQuery || "")}" placeholder="Filter metric tags"></label><span class="muted">Showing ${page.from}–${page.to} of ${page.total} · reference: ${escape(state.timeData.reference || "none")}</span><button class="button compact push" data-action="time-prev" ${page.page ? "" : "disabled"}>← Previous</button><span>${page.page + 1} / ${page.pages}</span><button class="button compact" data-action="time-next" ${page.page + 1 < page.pages ? "" : "disabled"}>Next →</button><button class="button compact" data-action="time-export">Export all results ↓</button></div>`};
  }

  function compareEventStrength(first, second) {
    return Math.abs(second.score) - Math.abs(first.score) || first.x - second.x || first.tag.localeCompare(second.tag);
  }

  function onsetRows() {
    return window.ExpmanOnsets.rows(state.timeData || {}, state.time);
  }

  async function renderOnsets() {
    const data = state.timeData, analysis = data.analysis, reference = data.reference_result;
    const colors = window.ExpmanPanels.defaultColors(Object.keys(data.curves).sort()), metricColor = tag => colors[tag] || color(tag);
    const rows = onsetRows(), display = timeDisplay(rows.map(row => row.tag), Object.keys(data.curves).length);
    const visible = new Set(display.tags), shown = rows.filter(row => visible.has(row.tag));
    const metrics = [data.reference, ...display.tags], onset = reference.onset;
    const bracket = row => row.onset_bracket ? `Recorded observations bracket this crossing at ${number(row.onset_bracket[0])}–${number(row.onset_bracket[1])}; this is not a confidence interval` : row.status;
    byId("time-results").innerHTML = `<div class="toolbar"><label>Sort results <select id="onset-sort">${option("correlation", "Correlation · strongest |r|", state.time.onset_sort)}${option("onset", "Onset · earliest first", state.time.onset_sort)}</select></label><label><input type="checkbox" id="onset-show-all" ${state.time.onset_show_all ? "checked" : ""}> Show unrelated curves</label><span>${analysis.related_curves} related candidates · ${data.rows.length} target curves</span><button class="button compact push" data-action="onsets-csv">Export results CSV ↓</button></div>
      ${display.html}<div class="notice" id="onset-reference-summary"><span class="color-dot" style="background:${metricColor(data.reference)}"></span> <strong>Reference: ${escape(data.reference)}</strong> · ${onset == null ? escape(reference.status) + "; delays are unavailable" : "onset " + number(onset) + " · " + reference.direction}. Baseline ${number(analysis.baseline_start)}–${number(analysis.baseline_end)}; change interval ${number(analysis.start)}–${number(analysis.end)}. Grid spacing ${number(analysis.resolution)}; smoothing ${number(analysis.smoothing_span)}; sustain ${number(analysis.sustain_span)} ${escape(timeUnits().toLowerCase())}.</div>
      <div class="card"><div class="table-wrap"><table id="onset-results-table"><thead><tr><th>METRIC</th><th title="Signed Pearson correlation of smoothed levels; correlation order uses the absolute value">CORRELATION r</th><th title="Signed Pearson correlation of adjacent changes on the common grid">CHANGE r</th><th>ONSET</th><th title="Target onset minus reference onset; negative means earlier">DELAY</th><th>CHANGE</th><th>STATUS</th></tr></thead><tbody>${shown.map(row => `<tr data-onset-tag="${escape(row.tag)}"><td><span class="color-dot" style="background:${metricColor(row.tag)}"></span> ${escape(row.tag)}</td><td class="mono" data-onset-correlation>${number(row.correlation)}</td><td class="mono">${number(row.change_correlation)}</td><td class="mono" title="${escape(bracket(row))}">${row.onset == null ? "—" : `<button class="text-button" data-action="focus-onset" data-value="${row.onset}">${number(row.onset)}</button>`}</td><td class="mono">${number(row.delay)}</td><td>${escape(row.direction || "—")}</td><td>${escape(row.status)}</td></tr>`).join("")}</tbody></table></div></div>
      ${rows.length ? "" : empty("No matching related curves", "Lower the correlation limits, enable Show unrelated curves, or change the metric search.")}
      <article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Aligned sustained changes</h2><div class="card-subtitle">EACH CURVE SCALED BY ITS DEPARTURE FROM BASELINE · REFERENCE ALWAYS SHOWN</div></div></header><div id="onset-curves" class="chart" style="height:420px"></div></article>
      <article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Onset order</h2><div class="card-subtitle">DASHED LINE MARKS REFERENCE ONSET · NEGATIVE DELAY MEANS EARLIER</div></div></header><div id="onset-timeline" class="chart" style="height:${Math.max(230, metrics.length * 40 + 70)}px"></div></article>
      <div class="notice">${escape(data.note)} Correlation order uses |r| and includes inverse changes. Gap and interval-start statuses indicate limited onset precision. Baselines and resampled plot values are exported with the analysis.</div>`;
    const traces = [];
    metrics.forEach(tag => {
      const curve = data.curves[tag], scaled = window.ExpmanOnsets.normalized(curve, analysis.start, analysis.end);
      traces.push({x: scaled.x, y: scaled.y, customdata: scaled.customdata, name: plotText(tag), type: "scatter", mode: "lines", line: {color: metricColor(tag), width: tag === data.reference ? 2.5 : 1.5}, hovertemplate: "Smoothed %{customdata[0]:.6g} · Resampled %{customdata[1]:.6g} · Baseline %{customdata[2]:.6g}<extra>%{fullData.name}</extra>"});
      const row = tag === data.reference ? reference : shown.find(row => row.tag === tag);
      const index = scaled.x.findIndex((value, index) => value === row.onset && scaled.y[index] != null);
      if (index >= 0) traces.push({x: [row.onset], y: [scaled.y[index]], name: plotText(tag) + " onset", type: "scatter", mode: "markers", marker: {color: metricColor(tag), size: 10, symbol: "diamond"}, hovertemplate: `Onset %{x} · ${escape(row.direction || "")}<extra>%{fullData.name}</extra>`});
    });
    const shapes = onset == null ? [] : [{type: "line", x0: onset, x1: onset, y0: 0, y1: 1, yref: "paper", line: {color: "#555555", dash: "dash", width: 1}}];
    await plot(byId("onset-curves"), traces, {showlegend: false, hovermode: "x unified", shapes, xaxis: {title: {text: timeUnits()}, range: [analysis.start, analysis.end]}, yaxis: {title: {text: "Scaled baseline deviation"}}});
    await plot(byId("onset-timeline"), metrics.map((tag, index) => {
      const row = tag === data.reference ? reference : shown.find(row => row.tag === tag);
      return {x: row.onset == null ? [] : [row.onset], y: row.onset == null ? [] : [index], name: plotText(tag), type: "scatter", mode: "markers", marker: {color: metricColor(tag), size: 12, symbol: "diamond"}, hovertemplate: `Onset %{x} · ${escape(row.direction || "")} · Delay ${tag === data.reference ? "0" : number(row.delay)}<extra>%{fullData.name}</extra>`};
    }), {showlegend: false, shapes, margin: {l: 200, r: 25, t: 15, b: 45}, xaxis: {title: {text: timeUnits()}, range: [analysis.start, analysis.end]}, yaxis: {tickvals: metrics.map((tag, index) => index), ticktext: metrics.map(tag => plotText(tag).slice(-36)), autorange: "reversed"}});
  }

  function eventScoreDetails(event) {
    return (event.score_type === "bernoulli" ? "Binary: smoothed Bernoulli score" : event.period != null ? "Continuous: robust phase residual score" : "Continuous: robust median/MAD score") + (event.context_window ? " · context " + event.context_window + " observations" : "") + (event.period != null ? " · expected cycle phase · period " + number(event.period) : "") + (event.boundary_context ? " · boundary variation included" : "");
  }

  function showPanelHelp(help) {
    document.querySelectorAll(".panel-help-tooltip").forEach(tooltip => { tooltip.hidden = true; });
    window.clearTimeout(help.expmanHideTimer);
    const tooltip = help.querySelector('[role="tooltip"]');
    tooltip.style.top = "100%"; tooltip.style.bottom = "auto"; tooltip.style.maxHeight = "";
    tooltip.hidden = false;
    const header = help.closest(".card-header, .named-view-bar").getBoundingClientRect(), bounds = tooltip.getBoundingClientRect();
    const below = window.innerHeight - header.bottom - 8, above = header.top - 8;
    const upwards = bounds.bottom > window.innerHeight - 8 && above > below;
    if (upwards) { tooltip.style.top = "auto"; tooltip.style.bottom = "100%"; }
    tooltip.style.maxHeight = Math.max(40, Math.min(430, window.innerHeight * .6, upwards ? above : below)) + "px";
  }

  function timingHelp(title, kind) {
    const data = state.timeData, settings = data.settings || {}, reference = escape(data.reference || "none");
    const units = (settings.x_axis || state.time.x_axis) === "step" ? "training steps" : "seconds";
    const introduction = `<p><strong>Reference:</strong> ${reference}. Automatic chooses the curve with the most detected events.</p>`;
    const details = kind === "events" ? `<p>Pairs detected events with the reference, closest first, one-to-one within Match tolerance (${number(settings.tolerance == null ? state.time.tolerance : settings.tolerance)} ${units}). Matching uses timing, so spikes and dips can be paired.</p><p><strong>Delay = target time − reference time.</strong> Positive means target later; negative means target earlier. A reference event at 100 and target event at 104 give +4 ${units}.</p><p><strong>Matches:</strong> paired events. <strong>Median delay:</strong> median of their delays; — means no matches. <strong>Unmatched ref / target:</strong> remaining event counts, not a ratio.</p>`
      : `<p>Compares the target selected below with the reference over their shared time range, using changes between neighboring points on a common grid. It includes regions without detected events.</p><p><strong>Lag:</strong> positive means target follows reference; negative means target leads. Units are ${units}; Max lag bounds the search.</p><p><strong>Correlation r:</strong> +1 means changes align in the same direction, −1 means opposite directions, and 0 means little linear association. Strongest lag maximizes |r|, so a negative correlation can win.</p><p><strong>Grid:</strong> spacing between tested delays, not measured timing precision. <strong>Pairs:</strong> valid observation pairs at that delay, not matched events.</p>`;
    return `<div class="panel-help"><h2 class="card-title">${escape(title)}</h2><button type="button" class="panel-help-button" data-action="panel-help" aria-label="About ${escape(title)}" aria-describedby="${kind}-timing-help">?</button><span id="${kind}-timing-help" class="panel-help-tooltip" role="tooltip" hidden>${introduction}${details}<p>Logging cadence limits timing precision. Temporal association does not establish causation.</p></span></div>`;
  }

  async function renderEvents() {
    const data = state.timeData;
    const strengths = new Map(Object.keys(data.curves).map(tag => [tag, Math.max(0, ...data.detections[tag].events.map(event => Math.abs(event.score)))]));
    const allTags = Object.keys(data.curves).sort((first, second) => strengths.get(second) - strengths.get(first) || data.detections[second].total - data.detections[first].total || first.localeCompare(second));
    const display = timeDisplay(allTags), tags = display.tags, visible = new Set(tags);
    const timeline = data.timeline.filter(event => visible.has(event.tag)).sort(compareEventStrength);
    const pairs = data.pairs.filter(pair => visible.has(pair.target));
    const appliedThreshold = data.settings && data.settings.threshold != null ? data.settings.threshold : state.time.threshold;
    const binaryWindow = data.settings && data.settings.binary_window || state.time.binary_window;
    const binaryCount = allTags.filter(tag => data.detections[tag].data_type === "binary").length;
    const periodicTags = allTags.filter(tag => data.detections[tag].periodic);
    const periodicSummary = periodicTags.length ? `<details class="notice"><summary>${periodicTags.length} curves scored relative to periodic fluctuation</summary><p>Regular cycle peaks are compared with the expected value at the same phase, including normal variation between cycles. Periods use ${escape(timeUnits().toLowerCase())}. Use Periodic behavior for spectra, phase comparisons, and cycle stability.</p><div class="table-wrap"><table><thead><tr><th>METRIC</th><th>PERIOD</th><th>OBSERVED CYCLES</th><th>BASELINE ERROR REDUCTION</th><th>ADJUSTED POINTS</th></tr></thead><tbody>${periodicTags.map(tag => { const cycle = data.detections[tag].periodic; return `<tr><td>${escape(tag)}</td><td>${number(cycle.period)}</td><td>${number(cycle.cycles)}</td><td>${number(cycle.improvement * 100)}%</td><td>${cycle.adjusted_points} / ${cycle.source_points}</td></tr>`; }).join("")}</tbody></table></div></details>` : "";
    byId("time-results").innerHTML = `${display.html}<div class="notice">${escape(data.note)} Applied event threshold: |Event score| ≥ ${number(appliedThreshold)}. Continuous curves use robust local or cycle-phase residual scores. ${periodicTags.length} curves use a validated periodic baseline. ${binaryCount} binary curves use smoothed Bernoulli scores with a ${binaryWindow}-observation context. Boundary windows use recorded observations and account for nearby startup variation. The chart’s Display z-score uses each displayed curve’s mean and standard deviation. Correlation uses first differences to reduce shared-trend effects.</div>${periodicSummary}<article class="card"><header class="card-header"><div><h2 class="card-title">Aligned curves and detected events</h2><div class="card-subtitle">DISPLAY NORMALIZED · METRICS ORDERED BY STRONGEST EVENT</div></div><button class="button compact" data-action="time-export">Export analysis ↓</button></header><div id="event-curves" class="chart" style="height:340px"></div><div class="chart-footer">Median observation spacing: ${tags.map(tag => `${escape(tag)}: ${number(data.curves[tag].cadence)}`).join(" · ")} ${escape(timeUnits().toLowerCase())}</div></article><article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Event timeline and strongest events</h2><div class="card-subtitle">${timeline.length} displayed events · ${data.timeline.length} total · table sorted by |Event score|, strongest first · timeline positioned by time</div></div><button class="button compact" data-action="events-csv">Export events CSV ↓</button></header><div id="event-timeline" class="chart" style="height:${Math.max(200, tags.length * 42 + 70)}px"></div><div class="table-wrap" style="max-height:260px"><table><thead><tr><th>POSITION</th><th>METRIC</th><th>EVENT</th><th>VALUE</th><th>BASELINE</th><th>EVENT SCORE</th></tr></thead><tbody>${timeline.map(event => `<tr><td><button class="text-button" data-action="focus-event" data-value="${event.x}">${number(event.x)}</button></td><td>${escape(event.tag)}</td><td>${event.kind}</td><td class="mono">${number(event.value)}</td><td class="mono" title="${event.period != null ? "Expected value at this phase of a " + number(event.period) + "-unit cycle" : event.score_type === "bernoulli" ? "Expected probability of 1 in the binary context" : "Rolling median baseline of the analyzed signal"}">${number(event.baseline)}</td><td class="mono" title="${escape(eventScoreDetails(event))}">${number(event.score)}</td></tr>`).join("")}</tbody></table></div></article><div class="analysis-grid parallel-card"><article class="card timing-help-card"><header class="card-header"><div>${timingHelp("Event delays", "events")}<div class="card-subtitle">TARGET TIME − REFERENCE TIME</div></div></header><div class="table-wrap"><table><thead><tr><th>TARGET</th><th>MATCHES</th><th>MEDIAN DELAY</th><th>UNMATCHED REF / TARGET</th></tr></thead><tbody>${pairs.map(pair => `<tr><td>${escape(pair.target)}</td><td>${pair.events.matched}</td><td class="mono">${number(pair.events.median_delay)}</td><td>${pair.events.unmatched_reference} / ${pair.events.unmatched_target}</td></tr>`).join("")}</tbody></table></div><div class="notice">Matching is nearest-first and one-to-one inside the tolerance. Logging cadence and asynchronous writes limit ordering precision.</div></article><article class="card timing-help-card"><header class="card-header"><div>${timingHelp("Lagged correlation", "lag")}<div class="card-subtitle" id="lag-note"></div></div><select id="lag-target" aria-label="Correlation target">${data.pairs.map((pair, index) => option(String(index), pair.target, "0")).join("")}</select></header><div id="lag-chart" class="chart"></div></article></div>${data.missing_metrics.length ? `<div class="notice warning">No observations: ${escape(data.missing_metrics.join(", "))}</div>` : ""}`;
    const traces = [];
    tags.forEach(tag => {
      const curve = data.curves[tag], mean = curve.y.reduce((total, value) => total + value, 0) / curve.y.length;
      const deviation = Math.sqrt(curve.y.reduce((total, value) => total + (value - mean) ** 2, 0) / curve.y.length) || 1;
      traces.push({x: curve.x, y: curve.y.map(value => (value - mean) / deviation), customdata: curve.y, name: escape(tag), mode: "lines", type: "scatter", line: {color: color(tag), width: 1.5}, hovertemplate: "Original: %{customdata:.5g} · Display z-score: %{y:.3f}<extra>%{fullData.name}</extra>"});
      const events = data.detections[tag].events;
      traces.push({x: events.map(event => event.x), y: events.map(event => (event.value - mean) / deviation), customdata: events.map(event => [event.value, event.score, event.kind]), name: escape(tag) + " events", showlegend: false, mode: "markers", type: "scatter", marker: {color: color(tag), size: 9, symbol: "diamond"}, hovertemplate: "%{customdata[2]} · Value: %{customdata[0]:.5g} · Score: %{customdata[1]:.3g}<extra>%{fullData.name}</extra>"});
    });
    await plot(byId("event-curves"), traces, {hovermode: "x unified", xaxis: {title: {text: timeUnits()}, gridcolor: "#edf1f8"}, yaxis: {title: {text: "Display z-score"}, gridcolor: "#edf1f8"}});
    await plot(byId("event-timeline"), tags.map((tag, index) => ({x: data.detections[tag].events.map(event => event.x), y: data.detections[tag].events.map(() => index), name: escape(tag), customdata: data.detections[tag].events.map(event => `${event.kind} · value ${number(event.value)} · event score ${number(event.score)} · ${eventScoreDetails(event)}`), mode: "markers", type: "scatter", marker: {size: 11, color: color(tag), symbol: "diamond"}, hovertemplate: "%{x}<br>%{customdata}<extra>%{fullData.name}</extra>"})), {showlegend: false, margin: {l: 180, r: 30, t: 15, b: 40}, yaxis: {tickvals: tags.map((tag, index) => index), ticktext: tags.map(tag => escape(tag).slice(-30)), gridcolor: "#edf1f8"}, xaxis: {title: {text: timeUnits()}, gridcolor: "#edf1f8"}});
    byId("event-timeline").on("plotly_click", event => focusEvent(event.points[0].x));
    await renderLag(0);
  }

  const timeUnits = () => state.time.x_axis === "step" ? "Training step" : state.time.x_axis === "wall" ? "Unix seconds" : "Elapsed seconds";
  function focusEvent(position) {
    const span = Math.max(state.time.tolerance * 2, state.time.max_lag / 3, 1);
    if (byId("event-curves")) Plotly.relayout(byId("event-curves"), {"xaxis.range": [Number(position) - span, Number(position) + span]});
  }

  async function renderLag(index) {
    const pair = state.timeData.pairs[index];
    if (!pair) { byId("lag-chart").innerHTML = empty("Select multiple metrics", "A reference and a target are needed for timing comparisons."); return; }
    const data = pair.correlation;
    await plot(byId("lag-chart"), [{x: data.lags, y: data.correlations, customdata: data.counts, type: "scatter", mode: "lines", line: {color: color(pair.target), width: 2}, hovertemplate: "Lag: %{x:.4g}<br>Correlation: %{y:.3f}<br>Pairs: %{customdata}<extra></extra>"}], {showlegend: false, xaxis: {title: {text: "Target delay · " + timeUnits().toLowerCase()}, gridcolor: "#edf1f8"}, yaxis: {range: [-1.05, 1.05], gridcolor: "#edf1f8"}});
    byId("lag-note").textContent = `Strongest lag ${number(data.best_lag)} · r ${number(data.best_correlation)} · grid ${number(data.resolution)}`;
  }

  async function renderPeriodicity() {
    const data = state.timeData;
    const allTags = Object.keys(data.metrics).sort((first, second) => Math.max(0, ...data.metrics[second].spectrum.powers) - Math.max(0, ...data.metrics[first].spectrum.powers));
    const display = timeDisplay(allTags), tags = display.tags, tag = data.reference;
    if (!allTags.length) {
      byId("time-results").innerHTML = empty("No observations in this window", "Choose different metrics or expand the analysis window.");
      return;
    }
    byId("time-results").innerHTML = `${display.html}<div class="notice">${escape(data.note)} Spectral score is explained variation after the chosen detrending, not a significance probability.</div><div class="chart-grid"><article class="card"><header class="card-header"><div><h2 class="card-title">Candidate period spectrum</h2><div class="card-subtitle">SINUSOIDAL FITS AT RECORDED TIMESTAMPS</div></div><button class="button compact" data-action="time-export">Export analysis ↓</button></header><div id="spectrum-chart" class="chart" style="height:330px"></div></article><article class="card"><header class="card-header"><div><h2 class="card-title">Autocorrelation</h2><div class="card-subtitle">DELAYED SIMILARITY · LARGE GAPS MASKED</div></div></header><div id="acf-chart" class="chart" style="height:330px"></div></article></div><article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Candidate cycles</h2><div class="card-subtitle">COMPARE HARMONICS, CADENCE, AND OBSERVABLE CYCLES</div></div></header><div class="table-wrap"><table><thead><tr><th>METRIC</th><th>PERIOD</th><th>EXPLAINED VARIATION</th><th>AMPLITUDE</th><th>CYCLES</th><th>POINTS USED / RECORDED</th></tr></thead><tbody>${tags.flatMap(metric => data.metrics[metric].spectrum.peaks.map(peak => `<tr><td>${escape(metric)}</td><td><button class="text-button" data-action="phase-at-period" data-value="${peak.period}">${number(peak.period)}</button></td><td class="mono">${number(peak.power)}</td><td class="mono">${number(peak.amplitude)}</td><td class="mono">${number(peak.cycles)}${peak.cycles < 3 ? " ⚠" : ""}</td><td>${data.metrics[metric].spectrum.analyzed_points} / ${data.metrics[metric].spectrum.source_points}</td></tr>`)).join("")}</tbody></table></div></article><div class="chart-grid parallel-card"><article class="card"><header class="card-header"><div><h2 class="card-title">Phase at a common period</h2><div class="card-subtitle">PERIOD ${number(data.phase_period)} · DELAYS MODULO ONE CYCLE</div></div></header><div id="phase-chart" class="chart"></div><div class="chart-footer">Phase delays are shown only when both fitted components explain at least 10% of detrended variation.</div></article><article class="card"><header class="card-header"><div><h2 class="card-title">Repeated-event intervals</h2><div class="card-subtitle">SPACING OF DETECTED SPIKES AND DIPS</div></div></header><div id="interval-chart" class="chart"></div></article></div>${state.time.windowed ? '<article class="card parallel-card"><header class="card-header"><div><h2 class="card-title">Cycle stability across windows</h2><div class="card-subtitle">REFERENCE METRIC · FIVE OVERLAPPING WINDOWS</div></div></header><div id="window-chart" class="chart" style="height:320px"></div></article>' : ""}<div class="notice warning">${tags.map(metric => `${escape(metric)}: ${escape(data.metrics[metric].spectrum.warning || "")}`).join("<br>")}${data.warnings.length ? "<br>" + data.warnings.map(escape).join("<br>") : ""}</div>`;
    await plot(byId("spectrum-chart"), tags.map(metric => ({x: data.metrics[metric].spectrum.periods, y: data.metrics[metric].spectrum.powers, type: "scatter", mode: "lines", name: escape(metric), line: {color: color(metric), width: 1.7}, hovertemplate: "Period: %{x:.5g}<br>Explained variation: %{y:.3f}<extra>%{fullData.name}</extra>"})), {xaxis: {type: "log", title: {text: "Period · " + timeUnits().toLowerCase()}, gridcolor: "#edf1f8"}, yaxis: {title: {text: "Explained variation"}, range: [0, 1.05], gridcolor: "#edf1f8"}});
    await plot(byId("acf-chart"), tags.map(metric => ({x: data.metrics[metric].autocorrelation.lags, y: data.metrics[metric].autocorrelation.correlations, customdata: data.metrics[metric].autocorrelation.counts, type: "scatter", mode: "lines", name: escape(metric), line: {color: color(metric), width: 1.7}, hovertemplate: "Delay: %{x:.5g}<br>Correlation: %{y:.3f}<br>Pairs: %{customdata}<extra>%{fullData.name}</extra>"})), {xaxis: {title: {text: "Delay · " + timeUnits().toLowerCase()}, gridcolor: "#edf1f8"}, yaxis: {range: [-1.05, 1.05], gridcolor: "#edf1f8"}});
    const phases = data.phases.filter(item => item.delay != null && tags.includes(item.tag));
    await plot(byId("phase-chart"), [{x: phases.map(item => item.delay), y: phases.map(item => escape(item.tag)), type: "bar", orientation: "h", marker: {color: phases.map(item => color(item.tag))}, customdata: phases.map(item => item.power), hovertemplate: "Delay: %{x:.4g}<br>Explained variation: %{customdata:.3f}<extra></extra>"}], {showlegend: false, margin: {l: 160, r: 25, t: 15, b: 50}, xaxis: {title: {text: "Signed delay from reference"}, gridcolor: "#edf1f8"}});
    await plot(byId("interval-chart"), tags.map(metric => ({x: data.metrics[metric].event_intervals, name: escape(metric), type: "histogram", opacity: .65, marker: {color: color(metric)}})), {barmode: "overlay", xaxis: {title: {text: "Inter-event interval"}, gridcolor: "#edf1f8"}, yaxis: {title: {text: "Count"}, gridcolor: "#edf1f8"}});
    if (state.time.windowed && data.metrics[tag]) {
      const windows = data.metrics[tag].windows.filter(item => item.spectrum.periods.length);
      const allPeriods = windows.flatMap(item => item.spectrum.periods);
      if (allPeriods.length) {
        const lower = Math.log(Math.min(...allPeriods)), upper = Math.log(Math.max(...allPeriods));
        const periods = Array.from({length: 45}, (unused, index) => Math.exp(lower + (upper - lower) * index / 44));
        const interpolate = (spectrum, position) => {
          const points = spectrum.periods.map((period, index) => [period, spectrum.powers[index]]).reverse();
          if (position < points[0][0] || position > points[points.length - 1][0]) return null;
          const right = points.findIndex(point => point[0] >= position);
          if (!right) return points[0][1];
          const first = points[right - 1], second = points[right];
          return first[1] + (second[1] - first[1]) * (position - first[0]) / (second[0] - first[0]);
        };
        await plot(byId("window-chart"), [{type: "heatmap", x: windows.map(item => (item.start + item.end) / 2), y: periods, z: periods.map(period => windows.map(item => interpolate(item.spectrum, period))), colorscale: "Viridis", zmin: 0, zmax: 1, colorbar: {thickness: 8}, hovertemplate: "Window center: %{x:.4g}<br>Period: %{y:.4g}<br>Explained variation: %{z:.3f}<extra></extra>"}], {xaxis: {title: {text: "Window center · " + timeUnits().toLowerCase()}}, yaxis: {type: "log", title: {text: "Candidate period"}}});
      } else byId("window-chart").innerHTML = empty("Windows too short", "Use a shorter period range or a longer analysis window.");
    }
  }

  function dialog(title, content, form = "", actions = "", submitLabel = "Save") {
    byId("dialog").innerHTML = `${form ? `<form data-form="${form}">` : ""}<header class="dialog-header"><h2 id="dialog-title">${escape(title)}</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Close dialog">×</button></header><div class="dialog-body">${content}</div><footer class="dialog-footer">${actions}<button type="button" class="button" data-action="close-dialog">${form ? "Cancel" : "Close"}</button>${form ? `<button class="button primary" type="submit">${escape(submitLabel)}</button>` : ""}</footer>${form ? "</form>" : ""}`;
    byId("dialog").showModal();
  }

  byId("dialog").addEventListener("close", () => {
    const editing = state.filterEditing;
    state.filterEditing = null;
    if (!editing || !editing.live || editing.committed) return;
    window.clearTimeout(state.filterLiveTimer);
    Object.assign(state, editing.original);
    byId("run-search").value = state.query;
    execute(renderView);
  });

  function checkDialog(title, choices, selected, form) {
    const bulk = form === "panels" ? '<button type="button" class="button compact" data-action="select-matching-choices">Select matching</button><button type="button" class="button compact" data-action="clear-choices">Clear selection</button>' : "";
    dialog(title, `<label class="field">Search<input type="search" id="choice-search" placeholder="Filter available fields…"></label><div class="check-list">${choices.map(choice => `<label data-choice="${escape(choice.toLowerCase())}"><input type="checkbox" name="choices" value="${escape(choice)}" ${selected.includes(choice) ? "checked" : ""}><span>${escape(choice)}</span></label>`).join("")}</div>`, form, bulk);
  }

  function appearanceDialog() {
    const settings = window.ExpmanAppearance.normalize(state.workspace.settings.appearance);
    const colors = {text_color: "Text", background_color: "Page background", surface_color: "Panels and dialogs", accent_color: "Accent", border_color: "Borders and chart grid", difference_color: "Configuration differences", scalar_color: "Default scalar highlight"};
    dialog("Appearance", `<label class="field">Preset<select name="appearance_preset"><option value="">Custom settings</option><option value="light">Light · black text</option><option value="dark">Dark</option><option value="contrast">High contrast</option></select></label><div class="appearance-grid"><label class="field">Interface font<select name="font_family">${[["system", "System sans-serif"], ["arial", "Arial"], ["georgia", "Georgia"], ["monospace", "Monospace"]].map(([key, text]) => option(key, text, settings.font_family)).join("")}</select></label><label class="field">Base font size<input type="number" name="font_size" min="10" max="22" step="1" value="${settings.font_size}"></label>${Object.entries(colors).map(([key, title]) => `<label class="field">${title}<input type="color" name="${key}" value="${settings[key]}"></label>`).join("")}</div><p>Preview</p><div id="appearance-preview" class="appearance-preview"><div><strong>Experiment metrics</strong><p>Training loss · 0.0342<br>Readable labels, tables, and chart text.</p><span>Selected experiment</span><span class="difference-preview">Configuration difference · 0.0003</span></div></div><p>Saved for this user across log directories. TensorBoard uses its own appearance controls.</p>`, "appearance", '<button type="button" class="button" data-action="appearance-reset">Reset defaults</button>');
    previewAppearance();
  }

  function appearanceFromForm() {
    const form = byId("dialog").querySelector('[data-form="appearance"]');
    const fields = Object.fromEntries(new FormData(form));
    fields.font_size = Number(fields.font_size);
    return window.ExpmanAppearance.normalize(fields);
  }

  function previewAppearance() {
    const preview = byId("appearance-preview");
    if (preview) window.ExpmanAppearance.apply(preview, appearanceFromForm());
  }

  function setAppearanceForm(settings) {
    const form = byId("dialog").querySelector('[data-form="appearance"]');
    Object.entries(window.ExpmanAppearance.normalize(settings)).forEach(([key, value]) => { form.elements.namedItem(key).value = value; });
    previewAppearance();
  }

  function filterRule(rule = {key: "", operator: "eq", value: ""}) {
    const operators = [["eq", "Equals"], ["ne", "Does not equal"], ["glob", "Matches glob"], ["gt", "Greater than"], ["gte", "At least"], ["lt", "Less than"], ["lte", "At most"], ["contains", "Contains"], ["not_contains", "Does not contain"], ["exists", "Exists"], ["missing", "Is missing"]];
    return `<div class="filter-rule"><select name="rule_source" aria-label="Filter target">${option("config", "Configuration", rule.source || "config")}${option("path", "Experiment path", rule.source || "config")}</select><input type="text" name="rule_key" list="filter-keys" ${rule.source === "path" ? "disabled" : "required"} value="${escape(rule.source === "path" ? "path" : rule.key)}" placeholder="Configuration path" aria-label="Configuration path"><select name="rule_operator" aria-label="Comparison operator">${operators.map(([key, text]) => option(key, text, rule.operator)).join("")}</select><input type="text" name="rule_value" value="${escape(label(rule.value))}" placeholder="JSON value or text" aria-label="Comparison value" ${["exists", "missing"].includes(rule.operator) ? "disabled" : ""}><button type="button" class="icon-button" data-action="remove-filter-rule" aria-label="Remove condition">×</button></div>`;
  }

  function exclusionsDialog() {
    dialog("Configuration exclusions", `<p>Configuration-row checkboxes include or ignore paths directly. To restore an ignored row, enable Show ignored and check it. Restoring a row removes matching exclusions, including subtree, glob, and filename rules; this also restores other configurations covered by those rules.</p><p>To edit several rules, change the lists below and Save. Exact keys, subtrees, and globs such as <code>seed</code> or <code>paths.*</code> are supported.</p><label class="field">Ignored configuration paths<textarea name="patterns">${escape(state.workspace.state.ignored_configs.join("\n"))}</textarea></label><p>YAML or JSON filenames such as <code>hparams.yml</code> or <code>extra.json</code> match at any directory depth. Include <code>/</code> to match a relative path, such as <code>123/hparams.yml</code>.</p><label class="field">Ignored configuration filenames or paths<textarea name="files">${escape(state.workspace.state.ignored_files.join("\n"))}</textarea></label>`, "ignored");
  }

  function filterRulesFromForm() {
    return Array.from(byId("dialog").querySelectorAll(".filter-rule")).map(row => {
      const source = row.querySelector('[name="rule_source"]').value;
      const key = source === "path" ? "path" : row.querySelector('[name="rule_key"]').value.trim();
      const operator = row.querySelector('[name="rule_operator"]').value;
      const raw = row.querySelector('[name="rule_value"]').value;
      let value = raw;
      try { value = JSON.parse(raw); } catch (error) { value = raw; }
      return {source, key, operator, value: ["exists", "missing"].includes(operator) ? null : value};
    }).filter(rule => rule.key);
  }

  function previewFilters() {
    const target = byId("filter-preview");
    if (!target) return;
    const filters = filterRulesFromForm();
    const editing = state.filterEditing;
    const signature = rules => window.ExpmanViews.signature({filters: rules.map(rule => ({...rule, source: rule.source || "config"}))});
    if (editing && editing.live && signature(filters) !== signature(state.filters)) {
      state.filters = filters;
      const saved = (state.workspace.state.named_filters || []).find(item => item.id === editing.identifier);
      state.activeFilter = saved && signature(saved.filters) === signature(filters) ? saved.id : "";
      const changed = followFilterSelection();
      renderChrome(); renderRuns(); remember();
      if (changed) { window.clearTimeout(state.filterLiveTimer); state.filterLiveTimer = window.setTimeout(() => execute(selectionChanged), 200); }
    }
    const count = editing && editing.live ? visibleRuns().length : state.runs.filter(item => !item.archived && window.ExpmanFilters.matches(item.config, filters, item.path)).length;
    target.textContent = `${count} experiments match ${filters.length ? "all " + filters.length + " conditions" : "the current filters"}.`;
  }

  function filterDialog(identifier = "", namedRequired = false) {
    const saved = (state.workspace.state.named_filters || []).find(item => item.id === identifier);
    const rules = saved ? saved.filters : state.filters;
    const original = {filters: JSON.parse(JSON.stringify(state.filters)), activeFilter: state.activeFilter, collection: state.collection, query: state.query};
    const keys = Array.from(new Set(state.runs.flatMap(item => Object.keys(item.config)))).sort();
    const extra = `${saved ? `<button type="button" class="button danger" data-action="delete-named-filter" data-value="${saved.id}">Delete</button>` : ""}<button type="submit" class="button" data-select-matches="true">Select matching</button>`;
    dialog(saved ? "Edit named filter" : namedRequired ? "New named filter" : "Filter experiments", `<input type="hidden" name="filter_id" value="${escape(identifier)}"><label class="field">Name${saved || namedRequired ? "" : " · optional, saves this set for reuse"}<input type="text" name="filter_name" maxlength="120" value="${escape(saved ? saved.name : "")}" ${saved || namedRequired ? "required" : ""} placeholder="For example: transformer baselines"></label><p>All conditions must match. Changes update the Experiments table immediately; Cancel restores the previous filters. Manual selection is preserved; Select matching replaces it. Save filter stores the named set for reuse. Choose Experiment path for paths relative to the log directory, including globs such as <code>*/exp07*</code>. Numeric and boolean values use JSON literals; quoted values stay strings. Archived runs are excluded.</p><datalist id="filter-keys">${keys.map(key => `<option value="${escape(key)}"></option>`).join("")}</datalist><div id="filter-rules">${(rules.length ? rules : [{key: "", operator: "eq", value: ""}]).map(filterRule).join("")}</div><button type="button" class="button compact" data-action="add-filter-rule">+ Add condition</button><button type="button" class="text-button" data-action="clear-filters">Clear current filters</button><p id="filter-preview"></p>`, "filter-set", extra, saved || namedRequired ? "Save filter" : "Done");
    state.filterEditing = {original, identifier, live: state.tab === "runs", committed: false};
    previewFilters();
  }

  function applyNamedDefinition(saved) {
    state.activeFilter = saved.id;
    state.filters = JSON.parse(JSON.stringify(saved.filters));
    state.collection = "all";
    state.query = "";
    byId("run-search").value = "";
  }

  function openGroup(identifier = "") {
    const group = state.workspace.state.groups.find(item => item.id === identifier);
    dialog(group ? "Edit experiment group" : "Create experiment group", `<input type="hidden" name="identifier" value="${escape(identifier)}"><label class="field">Group name<input name="name" required maxlength="120" value="${escape(group ? group.name : "")}" placeholder="For example: baseline · three seeds"></label><p>Group membership is explicit. A run can belong to more than one group.</p><div class="check-list">${state.runs.map(item => `<label><input type="checkbox" name="members" value="${item.id}" ${(group ? group.experiment_ids.includes(item.id) : state.selected.has(item.id)) ? "checked" : ""}>${escape(item.name)}</label>`).join("")}</div>`, "group", group ? `<button type="button" class="button danger" data-action="delete-group" data-value="${group.id}">Delete group</button>` : "");
  }

  async function editRun(identifier) {
    dialog("Experiment details", loading("Loading experiment details…"));
    const pending = byId("dialog").querySelector(".dialog-body");
    let item;
    try { item = await api("/api/experiments/" + identifier); }
    catch (error) {
      if (byId("dialog").open && pending.isConnected) pending.innerHTML = `<div class="notice warning" role="alert">${escape(errorText(error))}</div><button class="button" data-action="edit-run" data-value="${escape(identifier)}">Retry</button>`;
      throw error;
    }
    if (!byId("dialog").open || !pending.isConnected) return;
    dialog("Experiment details", `<input type="hidden" name="identifier" value="${item.id}"><label class="field">Display name<input name="name" maxlength="200" value="${escape(item.name)}"></label><label class="field">Tags · comma separated<input name="tags" value="${escape(item.tags.join(", "))}"></label><label class="field">Notes<textarea name="notes" maxlength="20000">${escape(item.notes)}</textarea></label><label><input type="checkbox" name="starred" ${item.starred ? "checked" : ""}> Favorite</label> <label><input type="checkbox" name="archived" ${item.archived ? "checked" : ""}> Archived</label><p class="mono">${escape(item.path)}</p>${item.warnings.map(warning => `<div class="notice warning">${escape(warning)}</div>`).join("")}${item.files.map(file => `<details><summary>${escape(file.name)} ${file.primary ? "· primary" : ""}</summary><pre class="source-code">${escape(file.content)}</pre></details>`).join("")}`, "run");
  }

  async function toggleFavorite(identifier) {
    if (state.pendingStars.has(identifier)) return;
    const item = state.runs.find(run => run.id === identifier);
    if (!item) return;
    state.pendingStars.add(identifier);
    const controls = () => document.querySelectorAll('[data-action="star"][data-value="' + identifier + '"]');
    controls().forEach(button => { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "…"; });
    try {
      mergeRunAnnotations(await api("/api/experiments/" + identifier, {starred: !item.starred}, "PATCH"));
      if (followFilterSelection()) await selectionChanged();
      renderChrome();
    } finally {
      state.pendingStars.delete(identifier);
      if (state.tab === "runs") renderRuns();
    }
  }

  function saveFile(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], {type: type || "application/json"}));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveCSV(filename, rows) {
    saveFile(filename, rows.map(row => row.map(value => {
      let text = value == null ? "" : String(value);
      if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    }).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }

  async function renderView() {
    if (followFilterSelection()) { await selectionChanged(); return; }
    cancelCombinedDrag();
    if (state.tab !== "overview" && state.overviewObserver) { state.overviewObserver.disconnect(); state.overviewObserver = null; }
    if (state.tab !== "overview" && byId("panel-dialog").open) byId("panel-dialog").close();
    if (state.tab !== "configs") disconnectConfigScrolling();
    const serial = ++state.serial;
    if (state.configResizing && state.tab !== "configs") finishConfigResize(true);
    if (state.relationshipKey && state.relationshipKey !== relationshipKey()) cancelRelationships();
    if (state.viewController) state.viewController.abort();
    state.viewController = new AbortController();
    window.clearTimeout(state.nativeTimer);
    renderChrome(); remember();
    if (state.tab === "runs") { renderRuns(); return; }
    if (state.tab === "native") {
      byId("view").innerHTML = '<div class="toolbar"><strong>Native TensorBoard</strong><span class="muted">Plugins appear when supported data is logged.</span><a class="button push" href="/tensorboard/" target="_blank" rel="noopener">Open separately ↗</a></div><div id="native-status" class="notice"><span id="native-status-text">Starting TensorBoard…</span><progress id="native-progress" aria-label="TensorBoard indexing"></progress></div><iframe id="native-frame" class="native-frame" title="TensorBoard" src="/tensorboard/"></iframe>';
      let waitingForIndex = false, partialShown = false;
      const poll = async () => {
        const response = await fetch("/api/tensorboard/status"), status = await response.json();
        if (serial !== state.serial || state.tab !== "native") return;
        if (status.error) {
          byId("native-status").classList.add("warning");
          byId("native-status-text").textContent = "TensorBoard indexing error: " + status.error;
          byId("native-progress").hidden = true;
        } else if (status.backend === "fast") {
          byId("native-status").hidden = false;
          byId("native-progress").hidden = status.ready;
          byId("native-status-text").textContent = `TensorBoard fast reader · ${status.streams_with_data || 0} streams available · data appears as files are indexed and refreshes automatically`;
          if (status.ready && !partialShown) { partialShown = true; byId("native-frame").src = "/tensorboard/?streaming=" + Date.now(); }
        } else if (status.ready) {
          byId("native-status").hidden = true;
          if (waitingForIndex) {
            waitingForIndex = false;
            byId("native-frame").src = "/tensorboard/?indexed=" + Date.now();
          }
        } else {
          waitingForIndex = true;
          byId("native-status-text").textContent = `TensorBoard Python reader is indexing event files · ${status.streams_with_data || 0} of ${status.streams_discovered || 0} discovered streams have data · ${Math.floor(status.elapsed || 0)}s${status.fallback_reason ? " · Fast reader unavailable: " + status.fallback_reason : ""}`;
          if (status.streams_with_data && !partialShown) { partialShown = true; byId("native-frame").src = "/tensorboard/?partial=" + Date.now(); }
        }
        state.nativeTimer = window.setTimeout(() => execute(poll), 2000);
      };
      execute(poll);
      return;
    }
    if (state.tab === "time") { await renderTime(serial); return; }
    if (!state.selected.size) { byId("view").innerHTML = empty("Select experiments to get started", "Use the Experiments view, or select all visible runs with the button above."); return; }
    if (state.tab === "overview") {
      if (state.metricsLoading && !state.tags.length) { byId("view").innerHTML = metricLoading(); return; }
      if (state.metricsError) { byId("view").innerHTML = empty("Could not read scalar metrics", state.metricsError) + '<button class="button primary" data-action="reload-metrics">Retry metric discovery</button>'; return; }
      await renderOverview(serial);
    }
    if (state.tab === "configs") await renderConfigs(serial);
    if (state.tab === "analysis") await renderAnalysis(serial);
  }

  function jsonMetricStatus(status) {
    return `<p>${status.matched_experiments} experiments · ${status.metric_values} summary values · ${status.summary_tags.length} metric names</p>${(status.errors || []).concat(status.warnings || []).map(message => `<p class="warning">${escape(message)}</p>`).join("")}`;
  }

  function renderJSONMetricProgress(extra = "") {
    const progress = state.jsonMetricProgress || {percent: 0, stage: "Starting JSON metric loading", elapsed: 0};
    const target = byId("json-metric-status");
    if (target) target.innerHTML = `<div role="status" aria-live="polite"><p>${Math.floor(progress.percent || 0)}% · ${escape(progress.stage)} · ${Math.floor(progress.elapsed || 0)}s${progress.metric ? " · " + escape(progress.metric) : ""}</p><progress max="100" value="${progress.percent || 0}" aria-label="JSON metric loading progress"></progress>${extra}</div>`;
    byId("dialog").querySelectorAll('[data-form="json-metrics"] textarea, [data-form="json-metrics"] button[type="submit"]').forEach(control => { control.disabled = state.jsonMetricLoading; });
  }

  function jsonMetricFailure(error) {
    state.jsonMetricLoading = false;
    renderJSONMetricProgress(`<p class="warning">${escape(error.message)}</p>${state.jsonMetricJob ? '<button type="button" class="button" data-action="retry-json-metrics">Retry loading status</button>' : ""}`);
  }

  async function pollJSONMetrics() {
    const identifier = state.jsonMetricJob;
    if (!identifier) return;
    try {
      const status = await api("/api/json-metrics/jobs/" + identifier);
      state.jsonMetricProgress = status;
      if (["error", "cancelled"].includes(status.status)) {
        state.jsonMetricJob = null;
        throw new Error(status.error || "JSON metric loading was cancelled");
      }
      renderJSONMetricProgress();
      if (status.status !== "complete") {
        window.setTimeout(() => execute(pollJSONMetrics), 500);
        return;
      }
      const result = await api("/api/json-metrics/jobs/" + identifier + "/result");
      state.workspace.state.json_metrics = result.paths;
      state.runs = []; mergeRuns(result.experiments);
      state.selected = new Set(ids().filter(id => state.runs.some(item => item.id === id)));
      state.scalarEpoch = (state.scalarEpoch || 0) + 1; state.curveEpoch = (state.curveEpoch || 0) + 1;
      state.jsonMetricLoading = false; state.jsonMetricJob = null;
      renderJSONMetricProgress(jsonMetricStatus(result));
      await selectionChanged();
      notify(`Loaded ${result.metric_values} JSON summary values for ${result.matched_experiments} experiments`);
    } catch (error) { jsonMetricFailure(error); }
  }

  async function loadJSONMetrics(paths) {
    if (state.jsonMetricLoading) return;
    if (state.jsonMetricJob) {
      state.jsonMetricLoading = true; renderJSONMetricProgress();
      await pollJSONMetrics(); return;
    }
    state.jsonMetricLoading = true; state.jsonMetricProgress = null;
    renderJSONMetricProgress();
    try {
      const job = await api("/api/json-metrics/jobs", {paths});
      state.jsonMetricJob = job.id;
      await pollJSONMetrics();
    } catch (error) { jsonMetricFailure(error); }
  }

  async function jsonMetricsDialog() {
    const status = await api("/api/json-metrics");
    dialog("Additional JSON metrics", `<p>One JSON filename per line, loaded inside each experiment folder. For example, <code>evaluation_metrics.json</code> reads each experiment's evaluation results. For nested files, use <code>{experiment}/evaluation/metrics.json</code>.</p><label class="field">JSON metric files<textarea name="json_metric_paths" rows="5" placeholder="evaluation_metrics.json&#10;{experiment}/evaluation/metrics.json">${escape(status.paths.join("\n"))}</textarea></label><p>Paths are saved in <code>${escape(state.workspace.state_file)}</code> and automatically loaded when this log directory is opened again. Refresh reloads changed values.</p><p>File format:</p><pre>{"metrics": {"accuracy": 0.9}}</pre><p>A direct numeric object such as <code>{"accuracy": 0.9}</code> and evaluation records containing <code>experiment</code>, <code>status</code>, and <code>metrics</code> are also supported. Imported values are named <code>JSON/source/metric</code> and support Latest scalar rows and Final-value Relationships.</p><div id="json-metric-status">${jsonMetricStatus(status)}</div>`, "json-metrics", "", "Load summaries");
    if (state.jsonMetricLoading || state.jsonMetricJob) renderJSONMetricProgress();
  }

  function discoverySignature(runs, includeMetrics = true) {
    const fields = ["id", "path", "config", "config_files", ...annotationFields, ...(includeMetrics ? ["modified"] : [])];
    return window.ExpmanViews.signature({experiments: runs.map(run => ({...Object.fromEntries(fields.map(key => [key, run[key]])), ...(includeMetrics ? {summaries: Object.fromEntries(Object.entries(run.metrics || {}).filter(([tag, metric]) => metric.summary_only))} : {})})).sort((first, second) => first.id.localeCompare(second.id))});
  }

  function notifyDiscoveryWarnings(warnings) {
    const seen = state.discoveryWarningsSeen || (state.discoveryWarningsSeen = new Set());
    const added = warnings.filter(warning => !seen.has(warning));
    warnings.forEach(warning => seen.add(warning));
    if (added.length) notify(`${warnings.length} discovery ${warnings.length === 1 ? "warning" : "warnings"}. For details, open “How this workspace works ↗” at the bottom of the left sidebar.`);
  }

  async function refresh(background = false) {
    if (state.refreshing || state.busy || state.metricsLoading || state.jsonMetricLoading || state.configScalarJob || state.relationshipJob || state.relationshipStarting || state.configResizing) return;
    if (background && (byId("dialog").open || byId("panel-dialog").open || state.combinedDrag || state.combinedFitting || state.configDragging || Array.from(state.curveRefreshes.values()).some(item => item.current()))) return;
    state.refreshing = true;
    try {
      const result = await api("/api/refresh", {});
      const refreshMetrics = !background || state.workspace.settings.auto_refresh === true;
      const unchanged = (!refreshMetrics || !result.revision || !state.workspace.revision || result.revision === state.workspace.revision) && discoverySignature(result.experiments, refreshMetrics) === discoverySignature(state.runs, refreshMetrics);
      state.workspace.warnings = result.warnings;
      state.workspace.last_scan = result.last_scan;
      state.workspace.revision = result.revision;
      notifyDiscoveryWarnings(result.warnings);
      if (background && unchanged) return;
      state.runs = []; mergeRuns(result.experiments);
      state.selected = new Set(ids().filter(identifier => state.runs.some(item => item.id === identifier)));
      followFilterSelection();
      state.time.loadedExperiment = "";
      state.scalarEpoch = (state.scalarEpoch || 0) + 1;
      state.curveEpoch = (state.curveEpoch || 0) + 1;
      await selectionChanged();
    } finally { state.refreshing = false; }
  }

  const actions = {
    "new-named-view": () => namedViewDialog(),
    "rename-named-view": () => namedViewDialog(true),
    "update-named-view": () => { const view = (state.workspace.state.named_views || []).find(item => item.id === state.activeNamedView); if (view) return writeNamedView(view.name, view.id); },
    "revert-named-view": () => loadNamedView(state.activeNamedView),
    "delete-named-view": deleteNamedView,
    "appearance": appearanceDialog,
    "json-metrics": jsonMetricsDialog,
    "retry-json-metrics": async () => { state.jsonMetricLoading = true; renderJSONMetricProgress(); await pollJSONMetrics(); },
    "appearance-reset": () => setAppearanceForm(window.ExpmanAppearance.defaults),
    "new-named-filter": () => filterDialog("", true),
    "edit-named-filter": () => filterDialog(state.activeFilter, true),
    "select-named-filter": async () => {
      const saved = state.workspace.state.named_filters.find(item => item.id === state.activeFilter);
      if (!saved) throw new Error("Choose a named filter first");
      const result = await api("/api/filters/" + saved.id + "/matches", {});
      applyNamedDefinition(saved); manualSelection(); state.selected = new Set(result.experiment_ids);
      await selectionChanged(); notify(`${result.count} experiments selected using ${saved.name}`);
    },
    "delete-named-filter": async identifier => {
      state.workspace.state.named_filters = await api("/api/filters/" + identifier, {}, "DELETE");
      if (state.activeFilter === identifier || state.filterEditing && state.filterEditing.identifier === identifier) { state.activeFilter = ""; state.filters = []; }
      if (state.filterEditing) state.filterEditing.committed = true;
      byId("dialog").close(); await renderView(); notify("Named filter deleted");
    },
    "add-filter-rule": () => {
      if (byId("filter-rules").children.length >= 100) throw new Error("A filter set supports up to 100 conditions");
      byId("filter-rules").insertAdjacentHTML("beforeend", filterRule()); previewFilters();
    },
    "remove-filter-rule": (value, button) => { button.closest(".filter-rule").remove(); previewFilters(); },
    "tab": async value => { state.tab = value; await renderView(); },
    "collection": async value => { state.collection = value; state.tab = "runs"; await renderView(); },
    "refresh": () => refresh(),
    "select-visible": async () => { manualSelection(); visibleRuns().forEach(item => state.selected.add(item.id)); await selectionChanged(); },
    "clear-selection": async () => { manualSelection(); state.selected.clear(); await selectionChanged(); },
    "unselect": async value => { manualSelection(); state.selected.delete(value); await selectionChanged(); },
    "new-group": () => openGroup(),
    "edit-group": value => openGroup(value),
    "select-group": async value => { manualSelection(); const group = state.workspace.state.groups.find(item => item.id === value); state.selected = new Set(group.experiment_ids.filter(identifier => state.runs.some(item => item.id === identifier))); state.options.group = "saved"; state.tab = "overview"; await selectionChanged(); },
    "delete-group": async value => { state.workspace.state = await api("/api/groups/" + value, {}, "DELETE"); byId("dialog").close(); renderChrome(); await renderView(); },
    "close-dialog": () => byId("dialog").close(),
    "edit-run": editRun,
    "star": toggleFavorite,
    "combined-metrics": combinedDialog,
    "remove-combined": async () => { state.combinedPlot = null; state.combinedData = null; invalidateCombinedFull(); await renderView(); },
    "retry-combined": () => { if (state.combinedData && state.combinedData.result.source !== "all-values") state.combinedData = null; return renderCombined(state.serial); },
    "fit-combined-y": fitCombinedY,
    "toggle-combined-drag": toggleCombinedDrag,
    "reset-combined-offsets": resetCombinedOffsets,
    "load-combined-full": loadCombinedFull,
    "cancel-combined-full": cancelCombinedFull,
    "panel-help": (value, button) => showPanelHelp(button.closest(".panel-help")),
    "panels": () => checkDialog("Choose scalar panels", state.tags, state.panels, "panels"),
    "all-panels": async () => { state.showAllPanels = true; state.panels = state.tags.slice(); state.panelQuery = ""; state.panelPage = 0; await renderView(); },
    "reload-metrics": selectionChanged,
    "toggle-panel-group": async prefix => { state.collapsedPanelGroups = state.collapsedPanelGroups.includes(prefix) ? state.collapsedPanelGroups.filter(item => item !== prefix) : state.collapsedPanelGroups.concat(prefix); state.panelPage = 0; await renderView(); },
    "show-panel-group": async prefix => {
      const tree = window.ExpmanPanels.tree(state.panels, state.panelQuery, state.collapsedPanelGroups);
      const index = tree.tags.findIndex(tag => tag.startsWith(prefix + "/"));
      if (index < 0) return;
      state.panelPage = Math.floor(index / state.panelPageSize);
      await renderView();
      const section = Array.from(document.querySelectorAll("[data-panel-prefix]")).find(item => item.dataset.panelPrefix === prefix);
      if (section) section.scrollIntoView({behavior: "smooth", block: "start"});
    },
    "expand-panel-groups": async () => { state.collapsedPanelGroups = []; state.panelPage = 0; await renderView(); },
    "collapse-panel-groups": async () => { state.collapsedPanelGroups = window.ExpmanPanels.tree(state.panels).prefixes; state.panelPage = 0; await renderView(); },
    "panels-prev": async () => { state.panelPage -= 1; await renderView(); },
    "panels-next": async () => { state.panelPage += 1; await renderView(); },
    "select-matching-choices": () => document.querySelectorAll('#dialog [data-choice]:not([hidden]) input[name="choices"]').forEach(input => { input.checked = true; }),
    "clear-choices": () => document.querySelectorAll('#dialog input[name="choices"]').forEach(input => { input.checked = false; }),
    "remove-panel": async value => { state.showAllPanels = false; state.panels = state.panels.filter(tag => tag !== value); await renderView(); },
    "expand-panel": expandPanel,
    "load-full-panel": loadFullPanel,
    "refresh-panel-curves": refreshVisibleCurves,
    "refresh-combined-curves": () => refreshVisibleCurves(null),
    "cancel-full-panel": cancelFullPanel,
    "close-expanded-panel": () => byId("panel-dialog").close(),
    "show-all-curves": showAllOverviewCurves,
    "apply-global-smoothing": applyGlobalSmoothing,
    "toggle-overview-curve": toggleOverviewCurve,
    "isolate-overview-curve": value => isolateOverviewCurve(value),
    "columns": () => checkDialog("Experiment table columns", Array.from(new Set(state.runs.flatMap(item => Object.keys(item.config)))).sort(), state.columns, "columns"),
    "group-keys": () => checkDialog("Group by configuration fields", state.keys, state.options.groupKeys, "group-keys"),
    "retry-relationships": async () => { window.clearTimeout(state.relationshipTimer); state.relationshipError = ""; state.relationshipFailures = 0; await renderAnalysis(state.serial); },
    "cancel-relationships": async () => { cancelRelationships(); state.relationshipKey = relationshipKey(); state.relationshipError = "Relationship analysis cancelled."; await renderAnalysis(state.serial); },
    "parallel-keys": parallelDialog,
    "reset-parallel": async () => { state.parallelKeys = window.ExpmanRelationships.defaults(state.analysis); state.parallelKeysConfigured = false; remember(); await renderParallel(); },
    "clear-parallel-brush": renderParallel,
    "retry-parallel": renderParallel,
    "condition": async value => { state.condition = value; byId("condition-select").value = value; await renderCondition(); },
    "apply-brush": async () => { manualSelection(); state.selected = new Set(state.brushed); await selectionChanged(); },
    "config-prev": () => { state.configPage -= 1; renderConfigTable(); },
    "config-next": () => { state.configPage += 1; renderConfigTable(); },
    "search-all-config-fields": async () => { state.showIgnored = true; state.diffOnly = false; state.configPage = 0; await renderView(); },
    "include-config-path": includeConfigPath,
    "config-display": configDisplayDialog,
    "add-config-text-rule": () => { const list = byId("config-text-rules"); list.insertAdjacentHTML("beforeend", configTextRule()); list.lastElementChild.querySelector("input").focus(); },
    "remove-config-text-rule": (value, button) => button.closest("[data-config-text-rule]").remove(),
    "reset-config-text": () => { if (state.configDisplayEditing) { delete state.configDisplayEditing.draft[state.configDisplayEditing.key]; renderConfigDisplayEditor(); } },
    "reset-config-order": () => { state.configOrder = []; state.configPage = 0; renderConfigTable(); remember(); },
    "reset-config-widths": () => { state.configColumnWidths = {}; renderConfigTable(); remember(); },
    "retry-config-scalars": () => { state.configScalarError = ""; return ensureConfigScalars(); },
    "add-config-scalar": () => configScalarDialog(),
    "edit-config-scalar": configScalarDialog,
    "remove-config-scalar": async identifier => { state.configScalars = state.configScalars.filter(item => item.id !== identifier); state.configOrder = state.configOrder.filter(key => key !== "scalar:" + identifier); await renderView(); },
    "ignored": exclusionsDialog,
    "ignore-key": value => setConfigIncluded(value, false),
    "raw-csv": value => { window.location.href = "/api/export/scalars.csv?ids=" + encodeURIComponent(ids().join(",")) + "&tag=" + encodeURIComponent(value); },
    "compare-csv": () => { if (state.comparison) saveCSV("expman-config-comparison.csv", window.ExpmanConfigurations.comparisonRecords(state.comparison, configurationRows(), (field, cell) => configCellText(field, cell, false))); },
    "analysis-csv": () => { if (!state.analysis) return; const keys = Array.from(new Set(state.analysis.records.flatMap(record => Object.keys(record.config)))).sort(); saveCSV("expman-condition-analysis.csv", [["experiment", "metric", "reduction", "smoothing", "at_step", "outcome", "first_step", "last_step", ...keys], ...state.analysis.records.map(record => [record.name, state.analysis.metric, state.analysis.reduction, state.analysis.smoothing, state.analysis.at_step, record.result, record.first_step, record.last_step, ...keys.map(key => has(record.config, key) ? label(record.config[key]) : "(missing)")])]); },
    "analysis-window": () => { const settings = state.analysisWindow || {}, summary = relationshipSummary(); dialog("Outcome settings", `<p>Automatic summaries inherit the configured scalar’s mode, target step, and smoothing. Smoothed outcomes use complete history before the window or fixed-step interpolation. Clear an override to inherit it again.</p><label class="field">Start step<input type="number" name="start_step" value="${settings.start_step == null ? "" : settings.start_step}"></label><label class="field">End step<input type="number" name="end_step" value="${settings.end_step == null ? "" : settings.end_step}"></label><label class="field">Target step override<input type="number" name="at_step" placeholder="${summary.at_step == null ? "Required for fixed-step summaries" : summary.at_step}" value="${settings.at_step == null ? "" : settings.at_step}"></label><label class="field">Smoothing override<input type="number" name="smoothing" min="0" max="0.999" step="any" placeholder="${summary.smoothing}" value="${state.relationshipSmoothing == null ? "" : state.relationshipSmoothing}"></label>`, "analysis-window"); },
    "index-visible": async () => { if (state.indexing) return; state.indexing = true; try { const runs = visibleRuns(); for (let offset = 0; offset < runs.length; offset += 5) { const result = await api("/api/metrics", {experiment_ids: runs.slice(offset, offset + 5).map(item => item.id)}); mergeRuns(result.experiments, true); if (state.tab === "runs") renderRuns(); } notify("Visible experiment summaries loaded"); } finally { state.indexing = false; } },
    "filters": () => filterDialog(state.activeFilter),
    "clear-filters": async () => { state.filters = []; state.activeFilter = ""; if (state.filterEditing) state.filterEditing.committed = true; byId("dialog").close(); await renderView(); },
    "clear-all-filters": async () => { state.filters = []; state.activeFilter = ""; state.query = ""; state.collection = "all"; byId("run-search").value = ""; await renderView(); },
    "analyze-time": analyzeTime,
    "retry-time": async () => {
      state.timeError = ""; state.timePollFailures = 0; showTimeError();
      if (state.timeJob) await pollTimeJob(state.timeJob.id);
      else if (state.timeData) await renderView();
      else await analyzeTime();
    },
    "cancel-time": async () => { await cancelTime(); await renderView(); notify("Analysis cancelled"); },
    "time-prev": async () => { state.timePlotPage = Math.max(0, (state.timePlotPage || 0) - 1); await renderView(); },
    "time-next": async () => { state.timePlotPage = (state.timePlotPage || 0) + 1; await renderView(); },
    "focus-event": value => focusEvent(Number(value)),
    "phase-at-period": async value => { state.time.phase_period = Number(value); await analyzeTime(); },
    "time-export": () => { if (state.timeData) saveFile("expman-" + state.time.mode + ".json", JSON.stringify(state.timeData, null, 2)); },
    "onsets-csv": () => { const query = (state.timePlotQuery || "").trim().toLowerCase(); saveCSV("expman-onsets.csv", [["metric", "correlation", "change_correlation", "onset", "onset_lower", "onset_upper", "delay", "direction", "status", "related"], ...onsetRows().filter(row => row.tag.toLowerCase().includes(query)).map(row => [row.tag, row.correlation, row.change_correlation, row.onset, row.onset_bracket && row.onset_bracket[0], row.onset_bracket && row.onset_bracket[1], row.delay, row.direction, row.status, row.related])]); },
    "focus-onset": position => { if (byId("onset-curves")) { const span = Math.max(state.time.onset_duration * 3, state.timeData.analysis.resolution * 10); return Plotly.relayout(byId("onset-curves"), {"xaxis.range": [Number(position) - span, Number(position) + span]}); } },
    "events-csv": () => { if (state.timeData) saveCSV("expman-events.csv", [["metric", "position", "start", "end", "kind", "value", "baseline", "deviation", "score", "score_type", "context_window", "scale", "period", "baseline_type", "boundary_context"], ...state.timeData.timeline.slice().sort(compareEventStrength).map(event => [event.tag, event.x, event.start, event.end, event.kind, event.value, event.baseline, event.deviation, event.score, event.score_type || "mad", event.context_window, event.scale, event.period, event.baseline_type, event.boundary_context])]); },
    "exports": () => dialog("Export workspace data", '<p>Raw CSV downloads are available on each scalar panel. Configuration and relationship views export their displayed records. Time-series views export full results and settings.</p><p><a class="button" href="/api/export/workspace.json" download>Download annotations, groups, and exclusions ↓</a></p>'),
    "help": () => dialog("About this workspace", `<p>Expman reads TensorBoard events and YAML/JSON configurations from <code>${escape(state.workspace.logdir)}</code>. Renaming, archiving, notes, groups, exclusions, and saved views are stored in <code>${escape(state.workspace.state_file)}</code>.</p><p>User-wide settings are stored in <code>${escape(state.workspace.settings_file)}</code>.</p>${state.workspace.migrated_from ? `<p>Existing workspace state was copied from <code>${escape(state.workspace.migrated_from)}</code>. The original remains as a backup.</p>` : ""}<p>Choose runs in Experiments, then compare their curves, configurations, and outcomes. Time series investigates one experiment independently of the shared selection. TensorBoard provides the native logging plugins.</p><p>Use <kbd>/</kbd> to search and Escape to close dialogs. Auto refresh rescans every 30 seconds when requests are idle.</p>${state.workspace.warnings.length ? '<h3>Discovery warnings</h3>' + state.workspace.warnings.map(warning => `<div class="notice warning">${escape(warning)}</div>`).join("") : ""}<p><a href="/design" target="_blank" rel="noopener">Read the design document ↗</a></p>`)
  };

  for (const name of ["pointerover", "focusin"]) document.addEventListener(name, event => {
    const help = event.target.closest && event.target.closest(".panel-help");
    if (!help || help.contains(event.relatedTarget)) return;
    showPanelHelp(help);
  });
  for (const name of ["pointerout", "focusout"]) document.addEventListener(name, event => {
    const help = event.target.closest && event.target.closest(".panel-help");
    if (!help || help.contains(event.relatedTarget)) return;
    help.expmanHideTimer = window.setTimeout(() => {
      if (!help.contains(document.activeElement) && !help.matches(":hover")) help.querySelector('[role="tooltip"]').hidden = true;
    }, 120);
  });

  document.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (button && button.dataset.action === "toggle-overview-curve" && event.detail > 0) {
      const id = button.dataset.value, pending = state.overviewLegendClicks.get(id);
      if (pending) window.clearTimeout(pending.timer);
      if (event.detail === 1) {
        const click = {hidden: state.hiddenOverviewCurves.slice()};
        click.timer = window.setTimeout(() => execute(() => toggleOverviewCurve(id)), 300);
        state.overviewLegendClicks.set(id, click);
      }
      return;
    }
    if (button && !button.disabled && actions[button.dataset.action]) execute(() => actions[button.dataset.action](button.dataset.value, button));
  });

  document.addEventListener("dblclick", event => {
    const button = event.target.closest('[data-action="toggle-overview-curve"]');
    if (!button) return;
    const id = button.dataset.value, pending = state.overviewLegendClicks.get(id);
    if (pending) window.clearTimeout(pending.timer);
    state.overviewLegendClicks.delete(id);
    event.preventDefault();
    execute(() => isolateOverviewCurve(id, pending ? pending.hidden : state.hiddenOverviewCurves));
  });

  document.addEventListener("input", event => {
    const element = event.target;
    if (element.id === "time-result-filter" && state.time.mode === "onsets") {
      state.timePlotQuery = element.value; state.timePlotPage = 0;
      window.clearTimeout(state.timeFilterTimer);
      state.timeFilterTimer = window.setTimeout(() => execute(async () => {
        if (state.tab !== "time" || state.time.mode !== "onsets" || !state.timeData) return;
        const focused = document.activeElement && document.activeElement.id === "time-result-filter", position = element.selectionStart;
        const pending = renderOnsets(), input = byId("time-result-filter");
        if (focused && input) { input.focus(); if (position != null) input.setSelectionRange(position, position); }
        await pending;
      }), 200);
      return;
    }
    if (element.id === "combined-smoothing" && state.combinedPlot) {
      const value = optionalNumber(element.value);
      if (validSmoothing(value) && value !== state.combinedPlot.smoothing) { state.combinedPlot.smoothing = value; remember(); execute(() => renderCombined(state.serial)); }
      return;
    }
    if (element.closest('[data-form="appearance"]')) previewAppearance();
    if (element.closest('[data-form="filter-set"]')) previewFilters();
    if (element.id === "choice-search") document.querySelectorAll("[data-choice]").forEach(choice => { choice.hidden = !choice.dataset.choice.includes(element.value.toLowerCase()); });
    if (["smoothing", "smoothing-value"].includes(element.id)) {
      const value = optionalNumber(element.value);
      if (validSmoothing(value)) return execute(() => setSmoothing(value, null, element));
      return;
    }
    if (element.dataset && typeof element.dataset.panelSmoothing === "string") {
      const value = optionalNumber(element.value);
      if (validSmoothing(value)) return execute(() => setSmoothing(value, element.dataset.panelSmoothing, element));
      return;
    }
    if (element.id === "panel-filter") {
      state.panelQuery = element.value;
      window.clearTimeout(state.panelFilterTimer);
      state.panelFilterTimer = window.setTimeout(() => { if (state.tab === "overview") execute(renderView); }, 250);
    }
    if (element.id === "run-search") {
      state.query = element.value; renderChrome(); remember();
      window.clearTimeout(state.runSearchTimer);
      if (state.selectionMode === "filters") {
        followFilterSelection(); renderChrome(); remember();
        if (state.tab === "runs") renderRuns();
        state.runSearchTimer = window.setTimeout(() => execute(selectionChanged), 250);
        return;
      }
      if (state.tab === "runs") renderRuns();
      if (state.tab === "overview") {
        state.serial += 1;
        if (state.viewController) state.viewController.abort();
        state.runSearchTimer = window.setTimeout(() => execute(async () => { if (state.tab === "overview") await renderView(); }), 250);
      }
    }
    if (element.id === "config-search") {
      state.configQuery = element.value; state.configPage = 0; remember();
      const position = element.selectionStart; renderConfigTable(); byId("config-search").focus();
      if (position != null) byId("config-search").setSelectionRange(position, position);
    }
  });

  document.addEventListener("change", event => execute(async () => {
    const element = event.target, identifier = element.id;
    if (identifier === "onset-sort" || identifier === "onset-show-all") {
      state.time[identifier === "onset-sort" ? "onset_sort" : "onset_show_all"] = identifier === "onset-sort" ? element.value : element.checked;
      state.timePlotPage = 0; remember(); if (state.timeData) await renderOnsets(); return;
    }
    if (identifier === "config-display-key") {
      if (!collectConfigDisplay()) { element.value = state.configDisplayEditing.key; return; }
      state.configDisplayEditing.key = element.value; renderConfigDisplayEditor(); return;
    }
    if (identifier === "named-view-choice") { await loadNamedView(element.value); return; }
    if (identifier === "selection-mode") {
      state.selectionMode = element.value === "filters" ? "filters" : "manual";
      followFilterSelection(); setAutoRefresh(state.workspace.settings.auto_refresh);
      await selectionChanged(); return;
    }
    if (identifier === "combined-scale" || identifier === "combined-smoothing") {
      if (!state.combinedPlot) return;
      if (identifier === "combined-scale") { state.combinedPlot.scale = element.value; state.combinedPlot.scaleWindow = null; }
      else {
        const value = optionalNumber(element.value);
        if (!validSmoothing(value)) { element.value = String(state.combinedPlot.smoothing); throw new Error("Smoothing must be between 0 and 0.999"); }
        if (value === state.combinedPlot.smoothing) return;
        state.combinedPlot.smoothing = value;
      }
      remember(); await renderCombined(state.serial); return;
    }
    if (element.name === "combined_experiment") {
      const form = element.closest('[data-form="combined"]');
      const selected = Array.from(form.querySelectorAll('input[name="choices"]:checked')).map(control => control.value);
      form.querySelector(".check-list").innerHTML = combinedChoices(element.value, selected);
      form.querySelector("#choice-search").value = "";
      return;
    }
    if (["smoothing", "smoothing-value"].includes(identifier)) { await setSmoothing(optionalNumber(element.value)); return; }
    if (typeof element.dataset.panelSmoothing === "string") { await setSmoothing(optionalNumber(element.value), element.dataset.panelSmoothing); return; }
    if (typeof element.dataset.overviewColor === "string") { await setOverviewColor(element.dataset.overviewColor, element.value); return; }
    if (typeof element.dataset.configInclude === "string") { await setConfigIncluded(element.dataset.configInclude, element.checked); return; }
    if (identifier === "config-full-names") { state.configFullNames = element.checked; renderConfigTable(); remember(); return; }
    if (typeof element.dataset.panelLogY === "string") { await setPanelLogY(element.dataset.panelLogY, element.checked); return; }
    if (identifier === "panel-size") { await setPanelSize(element.value); return; }
    if (identifier === "ignore-outliers") { await setIgnoreOutliers(element.checked); return; }
    const scalarForm = element.closest('[data-form="config-scalar"]');
    if (scalarForm) {
      const control = scalarForm.elements.namedItem("scalar_mode");
      const summary = state.summaryTags.includes(scalarForm.elements.namedItem("scalar_tag").value);
      Array.from(control.options || []).forEach(option => { option.disabled = summary && option.value !== "latest"; });
      if (summary) control.value = "latest";
      const mode = control.value;
      scalarForm.elements.namedItem("scalar_step").disabled = !mode.includes("step");
      scalarForm.elements.namedItem("scalar_step").required = mode.includes("step");
      scalarForm.elements.namedItem("scalar_smoothing").disabled = !mode.includes("smoothed");
      return;
    }
    if (identifier === "named-filter-choice") {
      const saved = (state.workspace.state.named_filters || []).find(item => item.id === element.value);
      if (saved) applyNamedDefinition(saved);
      else { state.activeFilter = ""; state.filters = []; }
      await renderView(); return;
    }
    if (element.closest('[data-form="filter-set"]')) {
      const row = element.closest(".filter-rule");
      if (row) {
        row.querySelector('[name="rule_value"]').disabled = ["exists", "missing"].includes(row.querySelector('[name="rule_operator"]').value);
        const path = row.querySelector('[name="rule_source"]').value === "path", key = row.querySelector('[name="rule_key"]');
        key.disabled = path; key.required = !path;
        if (path) key.value = "path";
      }
      previewFilters(); return;
    }
    if (element.closest('[data-form="appearance"]')) {
      if (element.name === "appearance_preset" && element.value) setAppearanceForm(window.ExpmanAppearance.presets[element.value]);
      else previewAppearance();
      return;
    }
    if (element.dataset.selectRun) { manualSelection(); if (element.checked) state.selected.add(element.dataset.selectRun); else state.selected.delete(element.dataset.selectRun); syncSelectionCheckboxes(); await selectionChanged(); return; }
    if (identifier === "toggle-visible") { manualSelection(); visibleRuns().forEach(item => element.checked ? state.selected.add(item.id) : state.selected.delete(item.id)); syncSelectionCheckboxes(); await selectionChanged(); return; }
    if (identifier === "auto-refresh") {
      try {
        state.workspace.settings = await api("/api/settings", {auto_refresh: element.checked}, "PUT");
        setAutoRefresh(state.workspace.settings.auto_refresh);
      } catch (error) { element.checked = state.workspace.settings.auto_refresh; throw error; }
      return;
    }
    if (identifier === "lag-target") { await renderLag(Number(element.value)); return; }
    if (identifier === "time-include" || identifier === "time-exclude") {
      const cancellation = cancelTime(), generation = state.timeGeneration;
      state.time[identifier === "time-include" ? "include" : "exclude"] = element.value.split("\n").map(pattern => pattern.trim()).filter(Boolean);
      updateTimeSettings();
      try { await cancellation; } catch (error) { if (generation === state.timeGeneration) { state.timeError = "Could not confirm cancellation: " + error.message; showTimeError(); } }
      return;
    }
    if (identifier === "time-result-filter") {
      if (state.time.mode === "onsets" && state.timePlotQuery === element.value) return;
      state.timePlotQuery = element.value; state.timePlotPage = 0;
      if (state.time.mode === "onsets") await renderOnsets(); else await renderView(); return;
    }
    if (identifier === "condition-select") { state.condition = element.value; await renderCondition(); return; }
    if (["condition-type", "condition-missing", "condition-merge-null"].includes(identifier)) {
      if (!state.condition) return;
      const key = identifier === "condition-type" ? "categoricalConditions" : identifier === "condition-missing" ? "excludedMissingConditions" : "separateNullConditions";
      const enabled = identifier === "condition-type" ? element.value === "categorical" : !element.checked;
      state[key] = Array.from(new Set(state[key].filter(value => value !== state.condition).concat(enabled ? [state.condition] : [])));
      cancelRelationships(); remember(); await renderView(); return;
    }
    if (identifier === "panels-per-page") { state.panelPageSize = Number(element.value); state.panelPage = 0; await renderView(); return; }
    const chartControls = {"x-axis": "x_axis", "band": "band", "alignment": "alignment"};
    if (chartControls[identifier]) {
      state.options[chartControls[identifier]] = element.value; await renderView(); return;
    }
    if (identifier === "group-mode") { state.options.group = element.value; if (element.value === "config" && !state.options.groupKeys.length) actions["group-keys"](); else await renderView(); return; }
    const commonControls = {"result-metric": "metric", "analysis-metric": "relationshipMetric", "association-scope": "associationScope", "run-sort": "sort", "baseline": "baseline", "reduction": "relationshipReduction", "direction": "direction", "diff-only": "diffOnly", "show-ignored": "showIgnored"};
    if (commonControls[identifier]) { state[commonControls[identifier]] = element.type === "checkbox" ? element.checked : element.value; state.configPage = 0; await renderView(); return; }
    const timeControls = {"time-experiment": "experiment", "time-mode": "mode", "time-axis": "x_axis", "time-start": "start", "time-end": "end", "event-threshold": "threshold", "event-window": "window", "binary-window": "binary_window", "event-tolerance": "tolerance", "event-max-lag": "max_lag", "event-detector": "detector", "event-period-aware": "period_aware", "onset-smoothing": "onset_smoothing", "onset-duration": "onset_duration", "onset-threshold": "onset_threshold", "onset-min-correlation": "onset_min_correlation", "onset-min-change-correlation": "onset_min_change_correlation", "onset-baseline-start": "onset_baseline_start", "onset-baseline-end": "onset_baseline_end", "min-period": "min_period", "max-period": "max_period", "phase-period": "phase_period", "period-detrend": "detrend", "period-windowed": "windowed"};
    if (timeControls[identifier]) {
      if (identifier.startsWith("onset-") && element.type === "number" && !["onset-baseline-start", "onset-baseline-end"].includes(identifier) && (!Number.isFinite(optionalNumber(element.value)) || element.validity && !element.validity.valid)) { element.reportValidity(); return; }
      const cancellation = cancelTime(), generation = state.timeGeneration;
      state.time[timeControls[identifier]] = element.type === "number" ? optionalNumber(element.value) : element.type === "checkbox" ? element.checked : element.value;
      updateTimeSettings();
      if (["time-experiment", "time-mode"].includes(identifier)) await renderView();
      try { await cancellation; } catch (error) { if (generation === state.timeGeneration) { state.timeError = "Could not confirm cancellation: " + error.message; showTimeError(); } }
    }
  }));

  document.addEventListener("submit", event => {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    const selectMatches = Boolean(event.submitter && event.submitter.dataset.selectMatches === "true");
    execute(async () => {
      const data = new FormData(form), type = form.dataset.form, choices = data.getAll("choices");
      if (type === "config-display") { saveConfigDisplay(); return; }
      if (type === "new-view" || type === "rename-view") { await writeNamedView(String(data.get("view_name")), type === "rename-view" ? state.activeNamedView : "", type === "rename-view"); return; }
      if (type === "json-metrics") {
        await loadJSONMetrics(String(data.get("json_metric_paths") || "").split("\n").map(path => path.trim()).filter(Boolean));
        return;
      }
      if (type === "config-scalar") saveConfigScalar(data);
      if (type === "combined") {
        if (!choices.length || choices.length > 32) throw new Error("Choose between 1 and 32 metrics for the combined plot");
        state.combinedPlot = window.ExpmanCombined.preferences({experiment: data.get("combined_experiment"), tags: choices, scale: data.get("combined_scale"), smoothing: state.combinedPlot ? state.combinedPlot.smoothing : state.options.smoothing, offsets: state.combinedPlot && state.combinedPlot.experiment === data.get("combined_experiment") ? state.combinedPlot.offsets : {}, scaleWindow: state.combinedPlot && state.combinedPlot.experiment === data.get("combined_experiment") ? state.combinedPlot.scaleWindow : null});
        if (!state.combinedData || state.combinedData.key !== combinedKey()) state.combinedData = null;
        invalidateCombinedFull();
      }
      if (type === "appearance") {
        state.workspace.settings = await api("/api/settings", {appearance: appearanceFromForm()}, "PUT");
        window.ExpmanAppearance.apply(document.documentElement, state.workspace.settings.appearance);
      }
      if (type === "filter-set") {
        const filters = filterRulesFromForm(), name = String(data.get("filter_name")).trim();
        const identifier = String(data.get("filter_id"));
        if (!filters.length && (name || identifier)) throw new Error("Add at least one condition to save a named filter");
        let saved = null;
        if (name || identifier) {
          saved = await api("/api/filters" + (identifier ? "/" + identifier : ""), {name, filters}, identifier ? "PUT" : "POST");
          state.workspace.state.named_filters = await api("/api/filters");
        }
        state.activeFilter = saved ? saved.id : "";
        state.filters = filters;
        if (selectMatches || !state.filterEditing || !state.filterEditing.live) { state.collection = "all"; state.query = ""; byId("run-search").value = ""; }
        if (selectMatches) {
          const result = saved ? await api("/api/filters/" + saved.id + "/matches", {}) : {experiment_ids: state.runs.filter(item => !item.archived && window.ExpmanFilters.matches(item.config, filters, item.path)).map(item => item.id)};
          manualSelection(); state.selected = new Set(result.experiment_ids);
          if (state.filterEditing) state.filterEditing.committed = true;
          byId("dialog").close(); await selectionChanged(); notify(`${state.selected.size} matching experiments selected`); return;
        }
        if (state.filterEditing) state.filterEditing.committed = true;
        state.tab = "runs";
      }
      if (type === "panels") { state.panels = choices; state.showAllPanels = choices.length === state.tags.length; state.panelPage = 0; state.panelQuery = ""; }
      if (type === "columns") state.columns = choices;
      if (type === "group-keys") { if (!choices.length) throw new Error("Choose at least one grouping field"); state.options.groupKeys = choices; state.options.group = "config"; }
      if (type === "parallel-keys") { if (choices.length > 10) throw new Error("Choose at most 10 dimensions"); state.parallelKeys = choices; state.parallelKeysConfigured = true; }
      if (type === "ignored") await updateConfigExclusions({patterns: String(data.get("patterns")).split("\n"), files: String(data.get("files")).split("\n")});
      if (type === "group") { const identifier = data.get("identifier"); await api("/api/groups" + (identifier ? "/" + identifier : ""), {name: data.get("name"), experiment_ids: data.getAll("members")}, identifier ? "PUT" : "POST"); state.workspace.state = (await api("/api/workspace")).state; }
      if (type === "run") { mergeRunAnnotations(await api("/api/experiments/" + data.get("identifier"), {name: data.get("name"), notes: data.get("notes"), tags: String(data.get("tags")).split(",").map(tag => tag.trim()).filter(Boolean), starred: data.has("starred"), archived: data.has("archived")}, "PATCH")); }
      if (type === "analysis-window") {
        const smoothing = optionalNumber(String(data.get("smoothing") || ""));
        if (smoothing != null && (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > .999)) throw new Error("Smoothing must be between 0 and 0.999");
        state.relationshipSmoothing = smoothing;
        state.analysisWindow = {start_step: optionalNumber(String(data.get("start_step"))), end_step: optionalNumber(String(data.get("end_step"))), at_step: optionalNumber(String(data.get("at_step")))};
      }
      byId("dialog").close();
      if (type === "ignored") { renderChrome(); renderConfigTable(); remember(); } else await renderView();
      notify("Workspace updated");
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && state.tab === "configs" && event.target.id === "config-search") {
      const key = exactConfigPath(event.target.value);
      if (key) { event.preventDefault(); if (!event.repeat) execute(() => includeConfigPath(key)); return; }
    }
    if (event.key === "Escape" && state.combinedDrag) { event.preventDefault(); cancelCombinedDrag(); return; }
    if (event.key === "Escape") {
      const help = document.querySelectorAll(".panel-help-tooltip:not([hidden])");
      if (help.length) { help.forEach(tooltip => { tooltip.hidden = true; }); event.preventDefault(); return; }
    }
    const separator = event.target.closest && event.target.closest("[data-config-resize]");
    if (separator && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const key = separator.dataset.configResize, widths = readConfigWidths();
      if (!Number.isFinite(widths[key])) return;
      const delta = (event.shiftKey ? 50 : 10) * (event.key === "ArrowLeft" ? -1 : 1);
      state.configColumnWidths = {...state.configColumnWidths, [key]: window.ExpmanConfigurations.columnWidth(key, widths[key] + delta)};
      applyConfigWidths(); remember(); return;
    }
    if (event.key === "Escape" && state.configResizing) { event.preventDefault(); finishConfigResize(true); return; }
    const handle = event.target.closest && event.target.closest("[data-config-drag]");
    if (handle && event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const rows = configurationRows(), index = rows.findIndex(row => window.ExpmanConfigurations.rowId(row) === handle.dataset.configDrag);
      const before = ["ArrowLeft", "ArrowUp"].includes(event.key), neighbor = rows[index + (before ? -1 : 1)];
      if (neighbor) moveConfigRow(handle.dataset.configDrag, window.ExpmanConfigurations.rowId(neighbor), before);
      return;
    }
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !byId("dialog").open && !byId("panel-dialog").open) { event.preventDefault(); byId("run-search").focus(); }
  });

  window.addEventListener("pagehide", () => {
    if (state.namedViewLoading) return;
    if (!state.pendingView) return;
    window.clearTimeout(state.saveViewTimer);
    fetch("/api/view", {method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({view: state.pendingView}), keepalive: true}).catch(() => {});
  });

  async function boot() {
    const results = await Promise.all([api("/api/workspace"), api("/api/experiments")]);
    state.workspace = results[0]; mergeRuns(results[1].experiments);
    state.workspace.settings = state.workspace.settings || {auto_refresh: false};
    state.workspace.state.named_filters = state.workspace.state.named_filters || [];
    state.workspace.state.named_views = state.workspace.state.named_views || [];
    window.ExpmanAppearance.apply(document.documentElement, state.workspace.settings.appearance);
    try {
      const persisted = state.workspace.state.view || {};
      const saved = Object.keys(persisted).length ? persisted : JSON.parse(localStorage.getItem("expman:" + state.workspace.id) || "null");
      if (saved) {
        state.activeNamedView = state.workspace.state.named_views.some(view => view.id === saved.namedView) ? saved.namedView : "";
        state.selectionMode = saved.selectionMode === "filters" ? "filters" : "manual";
        state.selected = new Set((saved.selected || []).filter(identifier => state.runs.some(item => item.id === identifier)));
        state.panels = saved.panels || []; state.metric = saved.metric || ""; state.columns = saved.columns || []; state.parallelKeys = saved.parallelKeys || [];
        state.baseline = typeof saved.baseline === "string" ? saved.baseline : "";
        state.associationScope = saved.associationScope === "all" ? "all" : "configurations";
        for (const key of ["categoricalConditions", "excludedMissingConditions", "separateNullConditions"]) state[key] = Array.from(new Set((Array.isArray(saved[key]) ? saved[key] : []).filter(value => typeof value === "string" && value.length > 0 && value.length <= 4000))).slice(0, 2000);
        state.relationshipMetric = typeof saved.relationshipMetric === "string" ? saved.relationshipMetric : "";
        state.relationshipReduction = ["last", "last_smoothed", "best", "mean", "min", "max", "at_step", "smoothed_at_step"].includes(saved.relationshipReduction) ? saved.relationshipReduction : "";
        state.relationshipSmoothing = Number.isFinite(saved.relationshipSmoothing) && saved.relationshipSmoothing >= 0 && saved.relationshipSmoothing <= .999 ? saved.relationshipSmoothing : null;
        state.parallelKeysConfigured = typeof saved.parallelKeysConfigured === "boolean" ? saved.parallelKeysConfigured : state.parallelKeys.length > 0;
        state.diffOnly = saved.diffOnly !== false;
        state.configQuery = typeof saved.configQuery === "string" ? saved.configQuery : "";
        state.sort = ["name", "updated", "result"].includes(saved.sort) ? saved.sort : "name";
        state.showIgnored = saved.showIgnored === true;
        state.condition = typeof saved.condition === "string" ? saved.condition : "";
        state.analysisWindow = Object.fromEntries(["start_step", "end_step", "at_step"].filter(key => saved.analysisWindow && (saved.analysisWindow[key] === null || Number.isFinite(saved.analysisWindow[key]))).map(key => [key, saved.analysisWindow[key]]));
        state.showAllPanels = saved.showAllPanels === true;
        state.panelQuery = typeof saved.panelQuery === "string" ? saved.panelQuery : "";
        state.panelPage = Number.isFinite(saved.panelPage) ? saved.panelPage : 0;
        state.panelPageSize = [8, 16, 32].includes(saved.panelPageSize) ? saved.panelPageSize : 16;
        state.collapsedPanelGroups = Array.isArray(saved.collapsedPanelGroups) ? saved.collapsedPanelGroups.filter(prefix => typeof prefix === "string") : [];
        Object.assign(state, window.ExpmanPanels.preferences(saved));
        Object.assign(state, window.ExpmanConfigurations.preferences(saved));
        if (saved.time && typeof saved.time === "object") {
          Object.keys(state.time).filter(key => !["tags", "available"].includes(key)).forEach(key => { if (has(saved.time, key)) state.time[key] = saved.time[key]; });
        state.time.period_aware = state.time.period_aware !== false;
        state.time.include = Array.isArray(state.time.include) ? state.time.include.filter(pattern => typeof pattern === "string") : ["*"];
          state.time.exclude = Array.isArray(state.time.exclude) ? state.time.exclude.filter(pattern => typeof pattern === "string") : [];
        }
        Object.assign(state.time, window.ExpmanOnsets.preferences(state.time));
        if (saved.options) Object.assign(state.options, saved.options);
        if (!Number.isFinite(state.options.smoothing) || state.options.smoothing < 0 || state.options.smoothing > .999) state.options.smoothing = .4;
        state.combinedPlot = window.ExpmanCombined.preferences(saved.combinedPlot, state.options.smoothing);
        delete state.options.logY;
        delete state.options.curveSource;
        state.options.ignoreOutliers = state.options.ignoreOutliers === true;
        state.filters = Array.isArray(saved.filters) ? saved.filters.filter(rule => rule && typeof rule.key === "string" && typeof rule.operator === "string") : [];
        state.activeFilter = state.workspace.state.named_filters.some(item => item.id === saved.activeFilter) ? saved.activeFilter : "";
        state.query = typeof saved.query === "string" ? saved.query : "";
        state.collection = ["all", "starred", "archived"].includes(saved.collection) ? saved.collection : "all";
        byId("run-search").value = state.query;
        if (tabs[saved.tab]) state.tab = saved.tab;
      } else state.selected = new Set(state.runs.filter(item => !item.archived).sort((first, second) => second.modified - first.modified).slice(0, 4).map(item => item.id));
    } catch (error) { state.selected = new Set(state.runs.slice(-4).map(item => item.id)); }
    followFilterSelection(); renderChrome(); await selectionChanged(); setAutoRefresh(state.workspace.settings.auto_refresh);
  }

  boot().catch(error => { byId("view").innerHTML = empty("Could not open this workspace", error.message); notify(error.message, true); });
})();

"use strict";

const configValueLabelCache = new WeakMap();

window.ExpmanConfigurations = {
  preferences(view = {}) {
    const seen = new Set();
    const scalars = (Array.isArray(view.configScalars) ? view.configScalars : []).filter(spec => {
      if (!spec || typeof spec.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.id) || seen.has(spec.id) || typeof spec.tag !== "string" || !spec.tag || !["latest", "latest_smoothed", "at_step", "smoothed_at_step"].includes(spec.mode)) return false;
      if (spec.mode.includes("step") && !Number.isFinite(spec.step)) return false;
      seen.add(spec.id); return true;
    }).slice(0, 100).map(spec => ({id: spec.id, tag: spec.tag, mode: spec.mode, step: spec.mode.includes("step") ? spec.step : null, smoothing: Number.isFinite(spec.smoothing) && spec.smoothing >= 0 && spec.smoothing <= .999 ? spec.smoothing : .4,
      highlight: ["largest", "smallest"].includes(spec.highlight) ? spec.highlight : "none", highlight_color: /^#[0-9a-f]{6}$/i.test(spec.highlight_color || "") ? spec.highlight_color : null}));
    const widths = view.configColumnWidths && typeof view.configColumnWidths === "object" && !Array.isArray(view.configColumnWidths) ? view.configColumnWidths : {};
    return {configScalars: scalars, configOrder: Array.from(new Set((Array.isArray(view.configOrder) ? view.configOrder : []).filter(key => typeof key === "string"))),
      configFullNames: view.configFullNames === true,
      configDisplay: this.displayPreferences(view.configDisplay),
      configColumnWidths: Object.fromEntries(Object.entries(widths).filter(([key, width]) => /^(experiment-name|config:.+|scalar:[A-Za-z0-9_-]{1,64})$/.test(key) && Number.isFinite(width))
        .map(([key, width]) => [key, this.columnWidth(key, width)]))};
  },
  valueKey(value) {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Mapping values must contain finite numbers");
      return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([first], [second]) => first.localeCompare(second))) : item;
    });
  },
  displayPreferences(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 2000).flatMap(([key, entry]) => {
      if (!key || key.length > 4000 || !entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 4000) : "", seen = new Set(), values = [];
      for (const rule of (Array.isArray(entry.values) ? entry.values : []).slice(0, 1000)) {
        if (!rule || typeof rule.text !== "string" || rule.text.length > 4000 || !Object.prototype.hasOwnProperty.call(rule, "value")) continue;
        try {
          const identity = this.valueKey(rule.value);
          if (!identity || identity.length > 80000 || seen.has(identity)) continue;
          seen.add(identity); values.push({value: JSON.parse(identity), text: rule.text});
        } catch (error) { continue; }
      }
      return name || values.length ? [[key, {name, values}]] : [];
    }));
  },
  displayValue(value, entry, fallback) {
    if (!entry || !Array.isArray(entry.values) || !entry.values.length) return fallback(value);
    let labels = configValueLabelCache.get(entry);
    if (!labels) {
      labels = new Map(entry.values.map(rule => [this.valueKey(rule.value), rule.text]));
      configValueLabelCache.set(entry, labels);
    }
    const key = this.valueKey(value);
    return labels.has(key) ? labels.get(key) : fallback(value);
  },
  columnWidth(key, width) { return Math.round(Math.max(key === "experiment-name" ? 120 : 44, Math.min(2000, width))); },
  automaticWidths(fields, experiments, renderValue, measure = value => Array.from(value).length * 6, scale = 1, baseline = "") {
    const width = (values, minimum) => Math.ceil(Math.min(320 * scale, Math.max(minimum * scale, ...values.map(value => measure(value) + 18 * scale))));
    return {"experiment-name": width(experiments.map(item => item.name + (item.id === baseline ? " BASELINE" : "")), 120),
      ...Object.fromEntries(fields.map(field => [this.rowId(field), width(field.cells.map(cell => renderValue(field, cell)), 44)]))};
  },
  comparisonRecords(data, fields, renderValue) {
    return [["Experiment", ...fields.map(field => field.key + (field.kind === "scalar" ? " · " + this.description(field.scalar) : ""))],
      ...data.experiments.map((item, index) => [item.name, ...fields.map(field => field.pending ? "" : renderValue(field, field.cells[index]))])];
  },
  rowId(row) { return row.id || "config:" + row.key; },
  ignoredPath(key, patterns) { return patterns.some(pattern => key === pattern || key.startsWith(pattern + ".") || window.ExpmanSignals.match(key, pattern)); },
  inclusionUpdate(key, included, metadata, experiments = []) {
    const patterns = metadata.ignored_configs || [], files = metadata.ignored_files || [];
    if (!included) return {patterns: Array.from(new Set(patterns.concat(key))), files};
    const namespace = key.startsWith("@") ? key.indexOf("::") : -1;
    const sources = namespace >= 0 ? [key.slice(1, namespace)] : experiments
      .filter(item => Object.prototype.hasOwnProperty.call(item.config || {}, key))
      .map(item => (item.config_files || [])[0] || "");
    return {patterns: patterns.filter(pattern => !this.ignoredPath(key, [pattern])),
      files: files.filter(pattern => !sources.some(filename => window.ExpmanSignals.match(pattern.includes("/") ? filename : filename.split("/").pop(), pattern)))};
  },
  uniqueSuffixes(keys, separator = ".") {
    const candidates = new Map(), counts = new Map();
    for (const key of new Set(keys)) {
      const namespace = separator === "." && key.startsWith("@") ? key.indexOf("::") : -1;
      const start = namespace >= 0 ? namespace + 2 : 0, offsets = start ? [0, start] : [0];
      let depth = 0;
      for (let index = start; index < key.length; index += 1) {
        if (separator === "." && key[index] === "\\") index += 1;
        else if (separator === "/" && "([".includes(key[index])) depth += 1;
        else if (separator === "/" && ")]".includes(key[index])) depth = Math.max(0, depth - 1);
        else if (key[index] === separator && !depth && index + 1 < key.length) offsets.push(index + 1);
      }
      const suffixes = offsets.reverse().map(offset => key.slice(offset));
      candidates.set(key, suffixes);
      for (const suffix of suffixes) counts.set(suffix, (counts.get(suffix) || 0) + 1);
    }
    return new Map(Array.from(candidates, ([key, suffixes]) => [key, suffixes.find(suffix => counts.get(suffix) === 1) || key]));
  },
  scalarTooltip(spec, defaultColor) {
    return [
      "TensorBoard scalar: " + spec.tag,
      "Summary: " + this.description(spec) + " (" + spec.mode + ")",
      "Training step: " + (spec.step == null ? "Latest" : spec.step),
      "Exponential smoothing: " + spec.smoothing,
      "Highlight: " + (spec.highlight || "none"),
      "Highlight color: " + (spec.highlight_color || defaultColor)
    ].join("\n");
  },
  highlightedCells(row) {
    if (row.kind !== "scalar" || row.pending || !["largest", "smallest"].includes(row.scalar.highlight)) return [];
    const values = row.cells.filter(cell => cell.present && typeof cell.value === "number" && Number.isFinite(cell.value)).map(cell => cell.value);
    if (!values.length) return [];
    const target = row.scalar.highlight === "largest" ? Math.max(...values) : Math.min(...values);
    return row.cells.map((cell, index) => cell.present && cell.value === target ? index : -1).filter(index => index >= 0);
  },
  selectedComparison(data, selected) {
    const wanted = new Map(selected.map((id, index) => [id, index]));
    const indices = data.experiments.map((item, index) => ({item, index})).filter(entry => wanted.has(entry.item.id));
    indices.sort((first, second) => wanted.get(first.item.id) - wanted.get(second.item.id));
    const canonical = cell => JSON.stringify(cell, (key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    return {experiments: indices.map(entry => entry.item), rows: data.rows.map(row => {
      const cells = indices.map(entry => row.cells[entry.index]);
      return {...row, cells, different: new Set(cells.map(canonical)).size > 1};
    })};
  },
  orderedRows(rows, order = []) {
    const positions = new Map(order.map((key, index) => [key, index]));
    return rows.map((row, index) => ({row, position: positions.has(this.rowId(row)) ? positions.get(this.rowId(row)) : order.length + index}))
      .sort((first, second) => first.position - second.position).map(item => item.row);
  },
  move(order, rows, source, target, before = true) {
    const available = rows.map(row => this.rowId(row));
    if (source === target || !available.includes(source) || !available.includes(target)) return order.slice();
    const result = Array.from(new Set(order.concat(available))).filter(key => key !== source);
    result.splice(result.indexOf(target) + (before ? 0 : 1), 0, source);
    return result;
  },
  description(spec) {
    const mode = {latest: "Latest", latest_smoothed: "Latest smoothed", at_step: "Value at step", smoothed_at_step: "Smoothed value at step"}[spec.mode];
    return mode + (spec.mode.includes("step") ? " " + spec.step : "") + (spec.mode.includes("smoothed") ? " · smoothing " + spec.smoothing : "");
  }
};

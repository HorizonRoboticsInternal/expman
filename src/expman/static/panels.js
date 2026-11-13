"use strict";

const overviewPalette = [
  "#2e91e5", "#e15f99", "#1ca71c", "#fb0d0d", "#da16ff", "#222a2a", "#b68100", "#750d86",
  "#eb663b", "#511cfb", "#00a08b", "#fb00d1", "#fc0080", "#b2828d", "#6c7c32", "#778aae",
  "#862a16", "#a777f1", "#620042", "#1616a7", "#da60ca", "#6c4516", "#0d2a63", "#af0038",
  "#007f5f", "#9d4e00", "#005f73", "#8f2d56", "#4f5d2f", "#3f607c", "#a60a9a", "#997100"
];
const overviewMemberCache = new WeakMap();

window.ExpmanPanels = {
  traceUid(identifier, role) {
    const encode = value => String(value).split("").map(character => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    return "expman-" + encode(identifier) + "-" + encode(role);
  },
  smooth(values, weight) {
    if (!weight || values.every(value => value === values[0])) return values.slice();
    let accumulator = 0, count = 0;
    return values.map(value => {
      if (typeof value !== "number" || !Number.isFinite(value)) return value;
      accumulator = weight * accumulator + (1 - weight) * value;
      count += 1;
      return accumulator / (weight === 1 ? 1 : 1 - Math.pow(weight, count));
    });
  },
  prepareMember(member, options) {
    let axes = overviewMemberCache.get(member);
    if (!axes) { axes = new Map(); overviewMemberCache.set(member, axes); }
    const axis = options.x_axis || "step";
    let base = axes.get(axis);
    if (!base) {
      const points = member.points, origin = member.origin == null && points.length ? points[0][2] : member.origin;
      const values = points.map(point => point[1]), elapsed = points.map(point => point[2] - origin);
      const positions = points.map(point => axis === "wall" ? point[2] : axis === "relative" ? point[2] - origin : point[0]);
      if (positions.every((position, index) => !index || position > positions[index - 1])) base = {x: positions, original: values, elapsed, values, indices: null};
      else {
        const unique = new Map();
        positions.forEach((position, index) => unique.set(position, index));
        const x = Array.from(unique.keys()).sort((first, second) => first - second), indices = x.map(position => unique.get(position));
        base = {x, original: indices.map(index => values[index]), elapsed: indices.map(index => elapsed[index]), values, indices};
      }
      axes.set(axis, base);
    }
    const smoothed = this.smooth(base.values, options.smoothing);
    return {...base, y: base.indices ? base.indices.map(index => smoothed[index]) : smoothed};
  },
  sampleIndices(values, limit) {
    const length = values.length;
    if (length <= limit) return Array.from({length}, (unused, index) => index);
    if (limit < 4) return Array.from(new Set(Array.from({length: limit}, (unused, index) => Math.floor(index * (length - 1) / (limit - 1)))));
    const indices = new Set([0, length - 1]), buckets = Math.floor((limit - 2) / 2), size = Math.floor((length - 2) / buckets), remainder = (length - 2) % buckets;
    let start = 1;
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const end = start + size + (bucket < remainder ? 1 : 0);
      let lower = start, upper = start;
      for (let index = start + 1; index < end; index += 1) {
        if (values[index] < values[lower]) lower = index;
        if (values[index] > values[upper]) upper = index;
      }
      indices.add(lower); indices.add(upper); start = end;
    }
    return Array.from(indices).sort((first, second) => first - second);
  },
  aggregateMembers(members, options) {
    members = members.filter(member => member.x.length);
    if (members.length === 1) {
      const member = members[0], indices = this.sampleIndices(member.y, options.max_points || 2000);
      const values = indices.map(index => member.y[index]);
      return {x: indices.map(index => member.x[index]), y: values, original_y: indices.map(index => member.original[index]), elapsed: indices.map(index => member.elapsed[index]), lower: options.band === "sem" ? indices.map(() => null) : values.slice(), upper: options.band === "sem" ? indices.map(() => null) : values.slice(), count: indices.map(() => 1), source_points: member.x.length, sampled: indices.length < member.x.length};
    }
    let grid = Array.from(new Set(members.flatMap(member => member.x))).sort((first, second) => first - second);
    if (members.length && options.alignment !== "union") {
      const start = Math.max(...members.map(member => member.x[0])), end = Math.min(...members.map(member => member.x[member.x.length - 1]));
      grid = grid.filter(position => position >= start && position <= end);
    }
    const length = grid.length, count = new Uint32Array(length), mean = new Float64Array(length), variance = new Float64Array(length);
    const minimum = new Float64Array(length).fill(Infinity), maximum = new Float64Array(length).fill(-Infinity);
    const original = new Float64Array(length), elapsed = new Float64Array(length);
    for (const member of members) {
      let cursor = 0;
      for (let index = 0; index < length; index += 1) {
        const position = grid[index];
        if (position < member.x[0] || position > member.x[member.x.length - 1]) continue;
        while (cursor + 1 < member.x.length && member.x[cursor + 1] <= position) cursor += 1;
        const next = cursor + 1 < member.x.length ? cursor + 1 : cursor, ratio = position === member.x[cursor] ? 0 : (position - member.x[cursor]) / (member.x[next] - member.x[cursor]);
        const value = ratio ? member.y[cursor] + (member.y[next] - member.y[cursor]) * ratio : member.y[cursor];
        if (!Number.isFinite(value)) continue;
        count[index] += 1;
        const difference = value - mean[index];
        mean[index] += difference / count[index];
        variance[index] += difference * (value - mean[index]);
        if (value < minimum[index]) minimum[index] = value;
        if (value > maximum[index]) maximum[index] = value;
        original[index] += ratio ? member.original[cursor] + (member.original[next] - member.original[cursor]) * ratio : member.original[cursor];
        elapsed[index] += ratio ? member.elapsed[cursor] + (member.elapsed[next] - member.elapsed[cursor]) * ratio : member.elapsed[cursor];
      }
    }
    const indices = this.sampleIndices(mean, options.max_points || 2000), result = {x: [], y: [], original_y: [], elapsed: [], lower: [], upper: [], count: [], source_points: length, sampled: indices.length < length};
    for (const index of indices) {
      const contributors = count[index];
      let deviation = contributors ? Math.sqrt(Math.max(variance[index] / contributors, 0)) : 0;
      if (options.band === "sem") deviation /= Math.sqrt(Math.max(contributors - 1, 1));
      const band = contributors && (options.band !== "sem" || contributors > 1);
      result.x.push(grid[index]); result.y.push(contributors ? mean[index] : null); result.count.push(contributors);
      result.original_y.push(contributors ? original[index] / contributors : null);
      result.elapsed.push(contributors ? elapsed[index] / contributors : null);
      result.lower.push(band ? options.band === "range" ? minimum[index] : mean[index] - deviation : null);
      result.upper.push(band ? options.band === "range" ? maximum[index] : mean[index] + deviation : null);
    }
    return result;
  },
  prepareCurves(curves, options) {
    const prepared = new Map();
    return curves.map(curve => {
      if (!Array.isArray(curve.members)) return curve;
      const members = curve.members.map(member => {
        if (!prepared.has(member.id)) prepared.set(member.id, this.prepareMember(member, options));
        return prepared.get(member.id);
      });
      return {...curve, ...this.aggregateMembers(members, options), elapsed_kind: members.length > 1 ? "mean" : "individual"};
    });
  },
  defaultColors(identifiers, previous = {}) {
    const assigned = new Map(Object.entries(previous));
    for (const identifier of identifiers) {
      if (assigned.has(identifier)) continue;
      const index = assigned.size, layer = Math.floor(index / overviewPalette.length);
      const shade = overviewPalette[index % overviewPalette.length];
      const strength = 1 - Math.pow(.78, Math.ceil(layer / 2)), target = layer % 2 ? 0 : 255;
      const components = shade.slice(1).match(/../g).map(value => Math.round(parseInt(value, 16) * (1 - strength) + target * strength).toString(16).padStart(2, "0"));
      assigned.set(identifier, "#" + components.join(""));
    }
    return Object.fromEntries(assigned);
  },
  elapsedText(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
    const total = Math.round(Math.abs(seconds));
    const days = Math.floor(total / 86400);
    return (seconds < 0 ? "-" : "") + (days ? days + "d " : "") + [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, "0")).join(":");
  },
  traceVisibility(traces, hidden) {
    const excluded = new Set(hidden);
    return traces.map(trace => excluded.has(trace.legendgroup) ? "legendonly" : true);
  },
  preferences(view = {}) {
    const legacy = view.options && view.options.logY === true && Array.isArray(view.panels) ? view.panels : [];
    const tags = Array.isArray(view.logYPanels) ? view.logYPanels : legacy;
    const colors = view.overviewColors && typeof view.overviewColors === "object" && !Array.isArray(view.overviewColors) ? view.overviewColors : {};
    const smoothing = view.panelSmoothing && typeof view.panelSmoothing === "object" && !Array.isArray(view.panelSmoothing) ? view.panelSmoothing : {};
    return {
      panelSize: ["small", "medium", "large"].includes(view.panelSize) ? view.panelSize : "medium",
      panelSmoothing: Object.fromEntries(Object.entries(smoothing).filter(([tag, value]) => tag && tag.length <= 4000 && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= .999).slice(0, 2000)),
      logYPanels: Array.from(new Set(tags.filter(tag => typeof tag === "string"))),
      overviewColors: Object.fromEntries(Object.entries(colors).filter(([key, value]) => key.length > 0 && key.length <= 16000 && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)).slice(0, 2000).map(([key, value]) => [key, value.toLowerCase()])),
      hiddenOverviewCurves: Array.from(new Set((Array.isArray(view.hiddenOverviewCurves) ? view.hiddenOverviewCurves : []).filter(key => typeof key === "string" && key.length > 0 && key.length <= 16000))).slice(0, 2000)
    };
  },
  outlierRange(traces, logarithmic = false) {
    const values = [];
    for (const trace of traces || []) {
      if (trace.visible === false || trace.visible === "legendonly") continue;
      for (const value of trace.y || []) {
        if (typeof value === "number" && Number.isFinite(value) && (!logarithmic || value > 0)) values.push(logarithmic ? Math.log10(value) : value);
      }
    }
    if (!values.length) return null;
    values.sort((first, second) => first - second);
    let first = Math.ceil((values.length - 1) * .05), last = Math.floor((values.length - 1) * .95);
    if (first > last) { first = 0; last = values.length - 1; }
    const lower = values[first], upper = values[last], span = upper - lower;
    const padding = span ? span * .05 : logarithmic ? .1 : Math.abs(lower) * .05 || 1;
    const range = [lower - padding, upper + padding];
    return range.every(Number.isFinite) ? range : [lower, upper];
  },
  tree(tags, query = "", collapsed = []) {
    const root = {prefix: "", tags: [], groups: [], count: 0}, closed = new Set(collapsed);
    const matching = tags.filter(tag => tag.toLowerCase().includes(query.trim().toLowerCase()));
    for (const tag of matching.slice().sort()) {
      const parts = tag.split("/"), prefixes = parts.slice(0, -1);
      let node = root;
      node.count += 1;
      for (let depth = 0; depth < prefixes.length; depth += 1) {
        const prefix = prefixes.slice(0, depth + 1).join("/");
        let child = node.groups.find(group => group.prefix === prefix);
        if (!child) {
          child = {prefix, tags: [], groups: [], count: 0, collapsed: closed.has(prefix)};
          node.groups.push(child);
        }
        child.count += 1;
        node = child;
      }
      node.tags.push(tag);
    }
    const expanded = [], prefixes = [];
    function visit(node, hidden) {
      if (node !== root) prefixes.push(node.prefix);
      if (!hidden && !node.collapsed) expanded.push(...node.tags);
      node.groups.forEach(group => visit(group, hidden || node.collapsed));
    }
    visit(root, false);
    return {root, tags: expanded, prefixes, total: matching.length};
  },
  page(tags, query = "", page = 0, pageSize = 16) {
    const size = Number.isFinite(Number(pageSize)) ? Math.max(1, Math.min(32, Math.floor(Number(pageSize)))) : 16;
    const filtered = tags.filter(tag => tag.toLowerCase().includes(query.trim().toLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const requested = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 0;
    const current = Math.max(0, Math.min(requested, pages - 1));
    const start = current * size;
    return {
      tags: filtered.slice(start, start + size),
      page: current,
      pages,
      size,
      total: filtered.length,
      from: filtered.length ? start + 1 : 0,
      to: Math.min(start + size, filtered.length)
    };
  }
};

"use strict";

window.ExpmanCombined = {
  preferences(value, smoothing = .4) {
    if (!value || typeof value.experiment !== "string" || !value.experiment) return null;
    const tags = Array.from(new Set((Array.isArray(value.tags) ? value.tags : []).filter(tag => typeof tag === "string" && tag.length > 0 && tag.length <= 4000))).slice(0, 32);
    if (!tags.length) return null;
    const offsets = Object.fromEntries(["minmax", "standard", "raw"].map(mode => [mode, Object.fromEntries(Object.entries(value.offsets && value.offsets[mode] || {}).filter(([tag, offset]) => tags.includes(tag) && typeof offset === "number" && Number.isFinite(offset)))]));
    const window = value.scaleWindow;
    const scaleWindow = window && ["step", "relative", "wall"].includes(window.axis) && Number.isFinite(window.start) && Number.isFinite(window.end) ? {axis: window.axis, start: Math.min(window.start, window.end), end: Math.max(window.start, window.end)} : null;
    return {experiment: value.experiment, tags, offsets, scaleWindow, scale: ["minmax", "standard", "raw"].includes(value.scale) ? value.scale : "minmax", smoothing: Number.isFinite(value.smoothing) && value.smoothing >= 0 && value.smoothing <= .999 ? value.smoothing : smoothing};
  },
  lowerBound(positions, value, coordinate = Number) {
    let start = 0, end = positions.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (coordinate(positions[middle]) < value) start = middle + 1;
      else end = middle;
    }
    return start;
  },
  valueAt(trace, position, coordinate = Number) {
    const x = trace.x || [], y = trace.y || [], index = this.lowerBound(x, position, coordinate);
    if (index < x.length && coordinate(x[index]) === position) return typeof y[index] === "number" && Number.isFinite(y[index]) ? y[index] : null;
    if (!index || index >= x.length) return null;
    const left = coordinate(x[index - 1]), right = coordinate(x[index]);
    if (![left, right, y[index - 1], y[index]].every(value => typeof value === "number" && Number.isFinite(value)) || right <= left) return null;
    return y[index - 1] + (y[index] - y[index - 1]) * ((position - left) / (right - left));
  },
  visibleYRange(traces, bounds, coordinate = Number) {
    if (!bounds || !bounds.every(Number.isFinite)) return null;
    const start = Math.min(...bounds), end = Math.max(...bounds);
    let lower = Infinity, upper = -Infinity;
    const include = value => { if (typeof value === "number" && Number.isFinite(value)) { lower = Math.min(lower, value); upper = Math.max(upper, value); } };
    for (const trace of traces) {
      if (trace.visible === false || trace.visible === "legendonly") continue;
      const x = trace.x || [], y = trace.y || [];
      const first = this.lowerBound(x, start, coordinate), last = this.lowerBound(x, end, coordinate);
      for (let index = first; index <= last && index < x.length && coordinate(x[index]) <= end; index += 1) include(y[index]);
      include(this.valueAt(trace, start, coordinate)); include(this.valueAt(trace, end, coordinate));
    }
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    const padding = upper > lower ? (upper - lower) * .05 : Math.abs(lower) * .05 || 1;
    const range = [lower - padding, upper + padding];
    return range.every(Number.isFinite) ? range : [lower, upper];
  },
  windowValues(trace, bounds, coordinate = Number) {
    const values = [], x = trace.x || [], y = trace.y || [];
    const first = this.lowerBound(x, bounds[0], coordinate), last = this.lowerBound(x, bounds[1], coordinate);
    for (let index = first; index <= last && index < x.length && coordinate(x[index]) <= bounds[1]; index += 1) if (typeof y[index] === "number" && Number.isFinite(y[index])) values.push(y[index]);
    for (const boundary of Array.from(new Set(bounds))) {
      const index = this.lowerBound(x, boundary, coordinate);
      if (index < x.length && coordinate(x[index]) === boundary) continue;
      const value = this.valueAt(trace, boundary, coordinate);
      if (value != null) values.push(value);
    }
    return values;
  },
  scale(values, mode, reference = values) {
    const valid = reference.filter(value => typeof value === "number" && Number.isFinite(value));
    if (!valid.length) return reference !== values ? this.scale(values, mode) : values.map(() => null);
    let lower = Infinity, upper = -Infinity, mean = 0, variance = 0, count = 0;
    valid.forEach(value => {
      lower = Math.min(lower, value); upper = Math.max(upper, value);
      count += 1;
      const delta = value - mean;
      mean += delta / count; variance += delta * (value - mean);
    });
    const deviation = Math.sqrt(Math.max(0, variance / count));
    return values.map(value => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      if (mode === "minmax") return upper === lower ? .5 : (value - lower) / (upper - lower);
      if (mode === "standard") return deviation ? (value - mean) / deviation : 0;
      return value;
    });
  }
};

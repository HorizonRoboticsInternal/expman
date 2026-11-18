"use strict";

window.ExpmanOnsets = {
  defaults: {onset_baseline_start: null, onset_baseline_end: null, onset_smoothing: 50, onset_duration: 50,
    onset_threshold: 5, onset_min_correlation: .7, onset_min_change_correlation: .15, onset_sort: "correlation", onset_show_all: false},
  preferences(time = {}) {
    const result = {...this.defaults};
    for (const key of ["onset_baseline_start", "onset_baseline_end"]) if (Number.isFinite(time[key])) result[key] = time[key];
    for (const key of ["onset_smoothing", "onset_duration", "onset_threshold", "onset_min_correlation", "onset_min_change_correlation"]) {
      const value = time[key], minimum = key === "onset_threshold" ? 1 : key === "onset_duration" ? Number.MIN_VALUE : 0;
      if (Number.isFinite(value) && value >= minimum && (!key.includes("correlation") || value <= 1)) result[key] = value;
    }
    result.onset_sort = time.onset_sort === "onset" ? "onset" : "correlation";
    result.onset_show_all = time.onset_show_all === true;
    return result;
  },
  rows(data, time) {
    const position = row => time.onset_sort === "onset" ? Number.isFinite(row.onset) ? row.onset : Infinity : Number.isFinite(row.correlation) ? -Math.abs(row.correlation) : Infinity;
    return (data.rows || []).filter(row => time.onset_show_all || row.related).slice().sort((first, second) => position(first) - position(second) || first.tag.localeCompare(second.tag));
  },
  normalized(curve, start, end) {
    const deviations = curve.y.map((value, index) => Number.isFinite(value) && Number.isFinite(curve.baseline[index]) ? value - curve.baseline[index] : null);
    const amplitude = Math.max(1e-12, ...deviations.filter((value, index) => value != null && curve.x[index] >= start && curve.x[index] <= end).map(Math.abs));
    const x = [], y = [], customdata = [];
    for (let index = 0; index < curve.x.length; index += 1) {
      if (index && curve.segments[index] !== curve.segments[index - 1]) { x.push(curve.x[index]); y.push(null); customdata.push([null, null, null]); }
      x.push(curve.x[index]); y.push(deviations[index] == null ? null : deviations[index] / amplitude);
      customdata.push([curve.y[index], curve.raw[index], curve.baseline[index]]);
    }
    return {x, y, customdata, amplitude};
  }
};

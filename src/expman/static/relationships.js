"use strict";

window.ExpmanRelationships = (() => {
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const display = value => typeof value === "string" ? value : canonical(value);
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const records = data => (data.records || []).filter(record => finite(record.result));
  const keys = data => Array.isArray(data.condition_keys) ? data.condition_keys : Array.from(new Set(records(data).flatMap(record => Object.keys(record.config)))).sort();

  function condition(data, key) {
    const rows = records(data), includeMissing = (data.missing_conditions || []).includes(key);
    const mergeNull = includeMissing && !(data.separate_null_conditions || []).includes(key);
    const entries = rows.filter(record => includeMissing || has(record.config, key)).map(record => {
      const missing = !has(record.config, key) || (mergeNull && record.config[key] === null);
      const value = record.config[key];
      return {record, value, missing, id: missing ? "missing" : "value:" + canonical(value)};
    });
    const categories = Array.from(new Map(entries.map(entry => [entry.id, {id: entry.id, value: entry.value, missing: entry.missing,
      name: entry.missing ? mergeNull ? "(missing or null)" : "(missing)" : typeof entry.value === "string" && ["(missing)", "(missing or null)", "null"].includes(entry.value) ? entry.value + " [string]" : display(entry.value)}])).values());
    if (categories.filter(item => !item.missing).every(item => finite(item.value))) categories.sort((a, b) => Number(a.missing) - Number(b.missing) || (a.missing ? 0 : a.value - b.value));
    return {entries, categories, includeMissing, mergeNull, missing: rows.filter(record => !has(record.config, key)).length,
      numeric: entries.length > 0 && !(data.categorical_conditions || []).includes(key) && entries.every(entry => !entry.missing && finite(entry.value))};
  }

  function available(data) {
    const rows = records(data);
    return keys(data).map(key => {
      const values = rows.filter(record => has(record.config, key)).map(record => record.config[key]);
      const grouped = condition(data, key);
      return {key, count: values.length, total: rows.length, distinct: grouped.categories.length, numeric: grouped.numeric};
    });
  }

  function defaults(data) {
    const ranks = new Map((data.associations || []).map((entry, index) => [entry.key, index]));
    return available(data).filter(item => item.distinct > 1 && (item.numeric || item.distinct <= Math.max(12, item.count / 2)))
      .sort((a, b) => b.count - a.count || (ranks.has(a.key) ? ranks.get(a.key) : Infinity) - (ranks.has(b.key) ? ranks.get(b.key) : Infinity) || a.key.localeCompare(b.key))
      .slice(0, 4).map(item => item.key);
  }

  function dimension(rows, key, name, categorical = false, mergeNull = false) {
    const present = record => has(record.config, key) && !(mergeNull && record.config[key] === null);
    const values = rows.filter(present).map(record => record.config[key]);
    const missing = values.length < rows.length;
    if (!categorical && values.length && values.every(finite)) {
      const low = Math.min(...values), high = Math.max(...values);
      if (!missing) return {label: name, values: rows.map(record => record.config[key])};
      const padding = (high - low || Math.abs(low) || 1) * .2, absent = low - padding;
      if (finite(absent) && absent < low && finite(high - low)) {
        const ticks = low === high ? [low] : Array.from({length: 5}, (_, index) => index === 4 ? high : low + (high - low) * index / 4);
        return {label: name, values: rows.map(record => present(record) ? record.config[key] : absent), range: [absent, high],
          tickvals: [absent, ...ticks], ticktext: ["(missing)", ...ticks.map(value => Number(value.toPrecision(5)).toString())]};
      }
    }
    const categories = Array.from(new Map(values.map(value => [canonical(value), value])).entries());
    if (values.every(finite)) categories.sort((a, b) => a[1] - b[1]);
    const positions = new Map(categories.map(([value], index) => [value, index]));
    return {label: name, values: rows.map(record => present(record) ? positions.get(canonical(record.config[key])) : -1),
      tickvals: (missing ? [-1] : []).concat(categories.map((item, index) => index)),
      ticktext: (missing ? [mergeNull ? "(missing or null)" : "(missing)"] : []).concat(categories.map(([, value]) => typeof value === "string" && ["(missing)", "(missing or null)", "null"].includes(value) ? value + " [string]" : display(value))),
      range: [missing ? -1 : 0, Math.max(1, categories.length - 1)]};
  }

  function build(data, selected, metric) {
    const rows = records(data);
    const names = window.ExpmanConfigurations.uniqueSuffixes(selected.concat(metric));
    return {records: rows, dimensions: selected.map(key => {
      const grouped = condition(data, key);
      return dimension(rows, key, names.get(key) || key, !grouped.numeric, grouped.mergeNull);
    })
      .concat({label: names.get(metric) || metric, values: rows.map(record => record.result)}),
    incomplete: rows.filter(record => selected.some(key => !has(record.config, key)
      || ((data.missing_conditions || []).includes(key) && !(data.separate_null_conditions || []).includes(key) && record.config[key] === null))).length};
  }

  function brushed(rows, dimensions) {
    const constrained = dimensions.filter(item => Array.isArray(item.constraintrange) && item.constraintrange.length);
    if (!constrained.length) return [];
    return rows.filter((record, index) => constrained.every(item => {
      const ranges = Array.isArray(item.constraintrange[0]) ? item.constraintrange : [item.constraintrange];
      return ranges.some(range => Array.isArray(range) && range.length === 2 && range.every(finite)
        && item.values[index] >= Math.min(...range) && item.values[index] <= Math.max(...range));
    })).map(record => record.id);
  }

  return {keys, available, defaults, build, brushed, condition};
})();

"use strict";

(() => {
  function canonical(value) {
    return JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) : item);
  }
  const text = value => typeof value === "string" ? value : canonical(value);
  function matches(config, filters, path = "") {
    return filters.every(filter => {
      const values = filter.source === "path" ? {[filter.key]: path} : config;
      const present = Object.prototype.hasOwnProperty.call(values, filter.key);
      if (filter.operator === "exists") return present;
      if (filter.operator === "missing") return !present;
      if (!present) return false;
      const actual = values[filter.key], expected = filter.value;
      if (filter.operator === "eq") return canonical(actual) === canonical(expected);
      if (filter.operator === "ne") return canonical(actual) !== canonical(expected);
      if (filter.operator === "contains") return text(actual).toLowerCase().includes(text(expected).toLowerCase());
      if (filter.operator === "not_contains") return !text(actual).toLowerCase().includes(text(expected).toLowerCase());
      if (filter.operator === "glob") return window.ExpmanSignals.match(text(actual), text(expected));
      if (typeof actual !== "number" || typeof expected !== "number" || !Number.isFinite(actual) || !Number.isFinite(expected)) return false;
      if (filter.operator === "gt") return actual > expected;
      if (filter.operator === "gte") return actual >= expected;
      if (filter.operator === "lt") return actual < expected;
      if (filter.operator === "lte") return actual <= expected;
      return false;
    });
  }
  window.ExpmanFilters = {matches};
})();

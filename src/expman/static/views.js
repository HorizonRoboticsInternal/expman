"use strict";

window.ExpmanViews = {
  signature(view) {
    const copy = JSON.parse(JSON.stringify(view || {}));
    delete copy.namedView;
    if (copy.selectionMode === "filters") delete copy.selected;
    else if (Array.isArray(copy.selected)) copy.selected.sort();
    if (copy.showAllPanels) delete copy.panels;
    if (copy.panelSmoothing && copy.options) copy.panelSmoothing = Object.fromEntries(Object.entries(copy.panelSmoothing).filter(([tag, weight]) => weight !== copy.options.smoothing));
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return JSON.stringify(canonical(copy));
  }
};

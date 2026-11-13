"use strict";

self.window = self;
importScripts("panels.js");
const panels = new Map();
self.onmessage = event => {
  const request = event.data;
  try {
    const curves = request.curves || panels.get(request.tag);
    if (!curves) throw new Error("Panel observations are no longer cached");
    panels.delete(request.tag); panels.set(request.tag, curves);
    const evicted = [];
    while (panels.size > 8) {
      const tag = panels.keys().next().value;
      panels.delete(tag); evicted.push(tag);
    }
    const result = self.ExpmanPanels.prepareCurves(curves, request.options).map(curve => {
      const {members, ...prepared} = curve;
      return prepared;
    });
    self.postMessage({id: request.id, result, evicted});
  } catch (error) { self.postMessage({id: request.id, error: error.message}); }
};

"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const context = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/expman/static/panels.js"), "utf8"), context);
const panels = context.window.ExpmanPanels;
const identities = ["cbe57802fd3ed8a375", "saved:control", "config:[α/value]", "a-b", "a_b", "😀", ""];
const traceIds = identities.flatMap(id => ["value", "lower", "upper"].map(role => panels.traceUid(id, role)));
assert(traceIds.every(id => /^[a-z][a-z0-9-]+$/.test(id)), "Plotly cleanup inserts trace IDs into CSS selectors");
assert.equal(new Set(traceIds).size, traceIds.length);
assert.equal(panels.traceUid("saved:control", "value"), panels.traceUid("saved:control", "value"));
assert.notEqual(panels.traceUid("a", "bc"), panels.traceUid("ab", "c"));
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => expected[index] == null ? assert.equal(value, null) : assert(Math.abs(value - expected[index]) <= 1e-9 * Math.max(1, Math.abs(expected[index])), `${value} != ${expected[index]} at ${index}`));
};
for (const weight of [0, .4, .9, .999]) {
  const values = [0, 10, -5, 3, 8];
  const expected = values.map((unused, index) => {
    const weights = values.slice(0, index + 1).map((value, earlier) => Math.pow(weight, index - earlier));
    return values.slice(0, index + 1).reduce((sum, value, earlier) => sum + value * weights[earlier], 0) / weights.reduce((sum, value) => sum + value, 0);
  });
  close(panels.smooth(values, weight), expected);
  assert.deepEqual(values, [0, 10, -5, 3, 8]);
}
close(panels.smooth([0, 10], .9), [0, 100 / 19]);
close(panels.smooth([7, 7, 7], .999), [7, 7, 7]);
const nonfinite = panels.smooth([NaN, 2, Infinity, 6], .5);
assert(Number.isNaN(nonfinite[0])); assert.equal(nonfinite[2], Infinity); close([nonfinite[1], nonfinite[3]], [2, 14 / 3]);
const member = {id: "a", origin: 100, points: [[0, 1, 100], [0, 4, 102], [2, 8, 104]]};
const original = JSON.stringify(member);
const prepared = panels.prepareMember(member, {smoothing: .5, x_axis: "step"});
close(prepared.original, [4, 8]); close(prepared.elapsed, [2, 4]); close(prepared.y, [3, 41 / 7]);
assert.equal(JSON.stringify(member), original);
const dense = {id: "dense", members: [{id: "dense", origin: 0, points: Array.from({length: 1001}, (unused, index) => [index, index === 517 ? 100000 : 1, index])}]};
const sampled = panels.prepareCurves([dense], {smoothing: 0, x_axis: "step", max_points: 20})[0];
assert(sampled.x.includes(517)); assert(sampled.y.includes(100000)); assert(sampled.sampled);
assert.equal(panels.prepareCurves([dense], {smoothing: .8, x_axis: "step", max_points: Number.MAX_SAFE_INTEGER})[0].x.length, 1001);
assert.deepEqual(JSON.parse(JSON.stringify(panels.preferences({panelSmoothing: {a: .9, b: 0, c: -1, d: 1, e: "0.5"}}).panelSmoothing)), {a: .9, b: 0});
const messages = [], worker = {postMessage(message) { messages.push(message); }};
worker.self = worker;
vm.createContext(worker);
worker.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/expman/static", filename), "utf8"), worker);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/expman/static/overview_worker.js"), "utf8"), worker);
worker.onmessage({data: {id: 1, tag: "dense", curves: [dense], options: {smoothing: .9, x_axis: "step", max_points: 20}}});
assert.equal(messages[0].result[0].members, undefined);
close(messages[0].result[0].y, panels.prepareCurves([dense], {smoothing: .9, x_axis: "step", max_points: 20})[0].y);
worker.onmessage({data: {id: 2, tag: "dense", options: {smoothing: 0, x_axis: "step", max_points: 20}}});
assert(messages[1].result[0].y.includes(100000));
for (let index = 0; index < 8; index += 1) worker.onmessage({data: {id: index + 3, tag: "other" + index, curves: [dense], options: {smoothing: 0, x_axis: "step", max_points: 20}}});
assert(messages[messages.length - 1].evicted.includes("dense"));
worker.onmessage({data: {id: 99, tag: "dense", options: {smoothing: 0}}});
assert(messages[messages.length - 1].error.includes("no longer cached"));
if (process.argv[2]) {
  const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  for (const item of cases) {
    const actual = panels.prepareCurves(item.curves, item.options);
    assert.equal(actual.length, item.expected.length);
    actual.forEach((curve, index) => {
      for (const field of ["x", "y", "lower", "upper", "count", "original_y", "elapsed"]) close(curve[field], item.expected[index][field]);
      assert.equal(curve.source_points, item.expected[index].source_points || 0);
      assert.equal(curve.sampled, Boolean(item.expected[index].sampled));
    });
  }
  console.log(`Browser smoothing: ${cases.length} real API cases match backend group statistics and original values`);
}
console.log("TensorBoard smoothing: debiased weights, finite observations, constants, duplicate positions, preserved originals, sampled spikes, full histories, and saved panel settings verified");

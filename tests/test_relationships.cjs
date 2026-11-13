"use strict";

const assert = require("assert").strict, fs = require("fs"), path = require("path"), vm = require("vm");
const context = {window: {}};
vm.createContext(context);
for (const name of ["configurations", "relationships"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/expman/static/", name + ".js"), "utf8"), context);
const charts = context.window.ExpmanRelationships;
const names = ["algo.use_clipped_value_loss", "robot.assignment_mode", "algo.hindsight.weight", "algo.hindsight.enabled"];
const records = Array.from({length: 25}, (_, index) => ({id: "exp" + index, result: index, config: {
  [names[0]]: index % 2 === 0,
  ...(index < 22 ? {[names[1]]: index % 2 ? "batch" : "per_env", [names[3]]: index % 3 === 0} : {}),
  ...(index === 0 ? {[names[2]]: .1} : {})
}}));
const data = {records, associations: names.map(key => ({key}))};
const built = charts.build(data, names, "Train/reward");
assert.equal(built.records.length, 25);
assert.equal(built.incomplete, 24);
assert(built.dimensions.every(item => item.values.length === 25 && item.values.every(Number.isFinite)));
assert.equal(built.dimensions[2].ticktext[0], "(missing)");
assert.equal(built.dimensions[2].values.filter(value => value === built.dimensions[2].tickvals[0]).length, 24);
assert.equal(charts.available(data).find(item => item.key === names[2]).count, 1);
assert(!charts.defaults(data).includes(names[2]), "A condition with only one observed value must not be selected by default");
assert.equal(built.dimensions[0].label, "use_clipped_value_loss");

built.dimensions[4].constraintrange = [[1, 2], [20, 21]];
assert.deepEqual(Array.from(charts.brushed(built.records, built.dimensions.slice().reverse())), ["exp1", "exp2", "exp20", "exp21"]);
built.dimensions[2].constraintrange = [built.dimensions[2].tickvals[0], built.dimensions[2].tickvals[0]];
assert.deepEqual(Array.from(charts.brushed(built.records, built.dimensions)), ["exp1", "exp2", "exp20", "exp21"]);
built.dimensions[2].constraintrange = [.1, .1];
assert.equal(charts.brushed(built.records, built.dimensions).length, 0);
built.dimensions[4].constraintrange = null;
assert.deepEqual(Array.from(charts.brushed(built.records, built.dimensions)), ["exp0"]);
built.dimensions[2].constraintrange = [];
assert.equal(charts.brushed(built.records, built.dimensions).length, 0);

const values = [null, "null", "001", true, "true", 1, "1", "(missing)"];
const typed = {records: values.map((value, index) => ({id: "typed" + index, result: index, config: {condition: value}})).concat({id: "absent", result: 10, config: {}})};
const categories = charts.build(typed, ["condition"], "reward").dimensions[0];
assert.equal(new Set(categories.values).size, values.length + 1);
assert.equal(categories.ticktext[0], "(missing)");
assert(categories.ticktext.includes("(missing) [string]"));
assert(categories.ticktext.includes("001"));
assert.deepEqual(Array.from(charts.keys({...typed, condition_keys: []})), []);
const optional = {records: [1, 1, 2, 2, null].map((value, index) => ({id: String(index), result: index, config: {condition: value}})).concat({id: "missing", result: 5, config: {}})};
assert.equal(charts.condition(optional, "condition").entries.length, 5);
const numeric = {records: optional.records.slice(0, 4)};
assert(charts.condition(numeric, "condition").numeric);
assert(!charts.condition({...numeric, categorical_conditions: ["condition"]}, "condition").numeric);
const merged = {...optional, missing_conditions: ["condition"]};
const grouped = charts.condition(merged, "condition");
assert.equal(grouped.entries.length, 6);
assert.equal(grouped.categories.length, 3);
assert.equal(grouped.entries.filter(item => item.missing).length, 2);
assert(grouped.categories.some(item => item.name === "(missing or null)"));
const mergedAxis = charts.build(merged, ["condition"], "reward").dimensions[0];
assert.equal(mergedAxis.values[4], mergedAxis.values[5]);
assert(mergedAxis.ticktext.includes("(missing or null)"));
const separate = {...merged, separate_null_conditions: ["condition"]};
assert.equal(charts.condition(separate, "condition").categories.length, 4);
const separateAxis = charts.build(separate, ["condition"], "reward").dimensions[0];
assert(separateAxis.values[4] !== separateAxis.values[5]);
assert(separateAxis.ticktext.includes("null"));
assert(separateAxis.ticktext.includes("(missing)"));

for (const value of [0, -1, Number.MAX_VALUE, -Number.MAX_VALUE]) {
  const result = charts.build({records: [{id: "present", result: 1, config: {number: value}}, {id: "missing", result: 2, config: {}}]}, ["number"], "reward");
  assert(result.dimensions.every(item => item.values.every(Number.isFinite)));
  assert(result.dimensions[0].values[0] !== result.dimensions[0].values[1]);
}
assert.deepEqual(Array.from(charts.defaults({records: [{id: "one", result: 1, config: {constant: 2}}]})), []);
console.log("Parallel coordinates: 25 experiments retained across sparse axes, typed missing values, defaults, labels, and disjoint/reordered/cleared brushes verified");

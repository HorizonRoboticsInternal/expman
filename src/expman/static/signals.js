"use strict";

window.ExpmanSignals = {
  match(tag, pattern) {
    let expression = "^";
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      if (character === "*") expression += ".*";
      else if (character === "?") expression += ".";
      else if (character === "[") {
        let end = index + 1;
        if (pattern[end] === "!") end += 1;
        if (pattern[end] === "]") end += 1;
        while (end < pattern.length && pattern[end] !== "]") end += 1;
        if (end === pattern.length) expression += "\\[";
        else {
          let contents = pattern.slice(index + 1, end).replace(/\\/g, "\\\\");
          if (contents[0] === "!") contents = "^" + contents.slice(1);
          else if (contents[0] === "^") contents = "\\" + contents;
          expression += "[" + contents + "]";
          index = end;
        }
      } else expression += character.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
    try { return new RegExp(expression + "$", "s").test(tag); }
    catch (error) { return false; }
  },
  select(tags, include = ["*"], exclude = []) {
    const patterns = include.length ? include : ["*"];
    return tags.filter(tag => patterns.some(pattern => this.match(tag, pattern)) && !exclude.some(pattern => this.match(tag, pattern)));
  }
};

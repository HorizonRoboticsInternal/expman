"use strict";

(() => {
  const defaults = {
    font_family: "system", font_size: 13, text_color: "#000000", background_color: "#f7f8fc",
    surface_color: "#ffffff", accent_color: "#4668e8", border_color: "#e7eaf1", difference_color: "#dcfce7", scalar_color: "#fbcfe8"
  };
  const fonts = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    arial: 'Arial, Helvetica, sans-serif',
    georgia: 'Georgia, "Times New Roman", serif',
    monospace: 'Consolas, "Liberation Mono", monospace'
  };
  const presets = {
    light: {...defaults},
    dark: {...defaults, text_color: "#ffffff", background_color: "#101217", surface_color: "#1d212a", accent_color: "#9eb5ff", border_color: "#4d5566", difference_color: "#1f4a32"},
    contrast: {...defaults, background_color: "#ffffff", border_color: "#000000", accent_color: "#0033cc", font_size: 15}
  };
  function normalize(settings = {}) {
    const result = {...defaults};
    for (const key of Object.keys(defaults)) {
      if (key.endsWith("_color") && /^#[0-9a-f]{6}$/i.test(settings[key] || "")) result[key] = settings[key].toLowerCase();
    }
    if (Object.prototype.hasOwnProperty.call(fonts, settings.font_family)) result.font_family = settings.font_family;
    if (Number.isInteger(settings.font_size) && settings.font_size >= 10 && settings.font_size <= 22) result.font_size = settings.font_size;
    return result;
  }
  const channels = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
  function blend(first, second, amount) {
    const target = channels(second);
    return "#" + channels(first).map((value, index) => Math.round(value * (1 - amount) + target[index] * amount).toString(16).padStart(2, "0")).join("");
  }
  function luminance(hex) {
    const linear = channels(hex).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  }
  function tokens(settings = {}) {
    const appearance = normalize(settings);
    const light = luminance(appearance.accent_color);
    const difference = luminance(appearance.difference_color);
    return {
      "--font-family": fonts[appearance.font_family], "--font-scale": String(appearance.font_size / 13),
      "--ink": appearance.text_color, "--muted": appearance.text_color,
      "--canvas": appearance.background_color, "--paper": appearance.surface_color,
      "--accent": appearance.accent_color, "--line": appearance.border_color,
      "--difference-background": appearance.difference_color,
      "--difference-ink": (difference + .05) / .05 >= 1.05 / (difference + .05) ? "#000000" : "#ffffff",
      "--accent-soft": blend(appearance.surface_color, appearance.accent_color, .1),
      "--soft-surface": blend(appearance.surface_color, appearance.text_color, .035),
      "--warning-surface": blend(appearance.surface_color, "#e8a45c", .14),
      "--on-accent": (light + .05) / .05 >= 1.05 / (light + .05) ? "#000000" : "#ffffff"
    };
  }
  function apply(element, settings) {
    const properties = tokens(settings);
    Object.entries(properties).forEach(([key, value]) => element.style.setProperty(key, value));
    element.style.colorScheme = luminance(normalize(settings).surface_color) < .2 ? "dark" : "light";
    return properties;
  }
  function plotLayout(layout, settings) {
    const appearance = normalize(settings), scale = appearance.font_size / 13;
    const font = original => ({...original, family: fonts[appearance.font_family], color: appearance.text_color, size: (original && original.size || 10) * scale});
    const result = {...layout, font: font(layout.font), paper_bgcolor: appearance.surface_color, plot_bgcolor: appearance.surface_color};
    for (const key of Object.keys(layout).filter(key => /^[xy]axis\d*$/.test(key))) {
      const axis = layout[key];
      result[key] = {...axis, gridcolor: appearance.border_color, linecolor: appearance.border_color,
        zerolinecolor: appearance.border_color, tickfont: font(axis.tickfont)};
      if (axis.title) result[key].title = typeof axis.title === "string" ? {text: axis.title, font: font()} : {...axis.title, font: font(axis.title.font)};
    }
    result.legend = {...layout.legend, font: font(layout.legend && layout.legend.font)};
    result.hoverlabel = {...layout.hoverlabel, bgcolor: appearance.surface_color, bordercolor: appearance.border_color, font: font(layout.hoverlabel && layout.hoverlabel.font)};
    return result;
  }
  function plotTraces(traces, settings) {
    const appearance = normalize(settings), scale = appearance.font_size / 13;
    const font = original => ({...original, color: appearance.text_color, family: fonts[appearance.font_family], size: (original && original.size || 10) * scale});
    return traces.map(trace => {
      const result = {...trace};
      for (const key of ["labelfont", "tickfont", "textfont"]) if (trace[key]) result[key] = font(trace[key]);
      if (trace.colorbar) result.colorbar = {...trace.colorbar, tickfont: font(trace.colorbar.tickfont)};
      if (trace.line && trace.line.colorbar) result.line = {...trace.line, colorbar: {...trace.line.colorbar, tickfont: font(trace.line.colorbar.tickfont)}};
      return result;
    });
  }
  const contrastInk = hex => luminance(hex) > .179 ? "#000000" : "#ffffff";
  window.ExpmanAppearance = {defaults, fonts, presets, normalize, tokens, apply, plotLayout, plotTraces, contrastInk};
})();

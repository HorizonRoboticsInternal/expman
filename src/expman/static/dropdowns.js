"use strict";

(() => {
  const menu = document.createElement("div");
  menu.className = "search-dropdown";
  menu.setAttribute("popover", "manual");
  menu.innerHTML = `<input class="search-dropdown-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="search-dropdown-choices" autocomplete="off" spellcheck="false" placeholder="Type to filter…"><div id="search-dropdown-choices" role="listbox"></div><div class="search-dropdown-empty" role="status" hidden>No matching options</div>`;
  const input = menu.querySelector("input");
  const list = menu.querySelector('[role="listbox"]');
  const empty = menu.querySelector('[role="status"]');
  let source = null;
  let choices = [];
  let active = -1;

  function controlAt(target) {
    return target.closest && target.closest("select:not([multiple]):not(:disabled)");
  }

  function controlLabel(select) {
    const explicit = select.getAttribute("aria-label");
    if (explicit) return explicit;
    const label = select.labels && select.labels[0];
    if (!label) return "options";
    const copy = label.cloneNode(true);
    copy.querySelectorAll("select").forEach(child => child.remove());
    return copy.textContent.trim().replace(/\s+/g, " ") || "options";
  }

  function position() {
    const bounds = source.getBoundingClientRect();
    const viewport = document.documentElement;
    const below = viewport.clientHeight - bounds.bottom;
    const above = below < 250 && bounds.top > below;
    const width = Math.min(Math.max(bounds.width, 340), viewport.clientWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(bounds.left, viewport.clientWidth - width - 8))}px`;
    menu.style.maxHeight = `${Math.max(80, Math.min(350, (above ? bounds.top : below) - 12))}px`;
    const top = above ? bounds.top - menu.offsetHeight - 4 : bounds.bottom + 4;
    menu.style.top = `${Math.max(8, Math.min(top, viewport.clientHeight - menu.offsetHeight - 8))}px`;
  }

  function activate(index) {
    if (active >= 0 && list.children[active]) list.children[active].classList.remove("active");
    active = index;
    if (active < 0) { input.removeAttribute("aria-activedescendant"); return; }
    const row = list.children[active];
    row.classList.add("active");
    input.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({block: "nearest"});
  }

  function optionDisabled(option) {
    return option.disabled || (option.parentElement.tagName === "OPTGROUP" && option.parentElement.disabled);
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    choices = Array.from(source.options).filter(option => !option.hidden && option.label.toLowerCase().includes(query));
    const rows = choices.map((option, index) => {
      const row = document.createElement("div");
      row.id = `search-dropdown-option-${index}`;
      row.dataset.optionIndex = index;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.selected));
      if (optionDisabled(option)) row.setAttribute("aria-disabled", "true");
      row.textContent = option.label;
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = Boolean(rows.length);
    position();
    const selected = query ? -1 : choices.findIndex(option => option.selected && !optionDisabled(option));
    activate(selected >= 0 ? selected : choices.findIndex(option => !optionDisabled(option)));
  }

  const observer = new MutationObserver(records => {
    if (!source) return;
    if (!source.isConnected || source.matches(":disabled") || !source.getClientRects().length) {
      close();
    } else if (records.some(record => source.contains(record.target))) render();
  });

  function close(restoreFocus = false) {
    const select = source;
    if (!select) return;
    source = null;
    observer.disconnect();
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    menu.remove();
    if (restoreFocus && select.isConnected) select.focus({preventScroll: true});
  }

  function open(select, initial = "") {
    close();
    if (!select.options.length) return;
    source = select;
    input.value = initial;
    const label = controlLabel(select);
    input.setAttribute("aria-label", `Filter ${label}`);
    list.setAttribute("aria-label", label);
    (select.closest("dialog") || document.body).appendChild(menu);
    if (typeof menu.showPopover === "function") menu.showPopover();
    render();
    input.focus({preventScroll: true});
    observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden", "label", "open", "selected"]});
  }

  function choose(index) {
    const option = choices[index], select = source;
    if (!select || !option || optionDisabled(option)) return;
    const changed = select.selectedIndex !== option.index;
    select.selectedIndex = option.index;
    close(true);
    if (changed) {
      select.dispatchEvent(new Event("input", {bubbles: true}));
      select.dispatchEvent(new Event("change", {bubbles: true}));
    }
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Tab") { close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { close(true); return; }
    if (event.key === "Enter") { choose(active); return; }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    let index = active < 0 && direction < 0 ? choices.length : active;
    for (let attempts = 0; attempts < choices.length; attempts += 1) {
      index = (index + direction + choices.length) % choices.length;
      if (!optionDisabled(choices[index])) { activate(index); return; }
    }
  });

  list.addEventListener("pointerdown", event => {
    if (event.target.closest("[data-option-index]")) event.preventDefault();
  });
  list.addEventListener("click", event => {
    const row = event.target.closest("[data-option-index]");
    if (row) choose(Number(row.dataset.optionIndex));
  });

  document.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const select = controlAt(event.target);
    if (select) {
      event.preventDefault();
      if (source === select) close(true);
      else open(select);
    } else if (source && !menu.contains(event.target)) close();
  }, true);

  document.addEventListener("click", event => {
    const select = controlAt(event.target);
    if (!select) return;
    event.preventDefault();
    if (event.detail === 0 && source !== select) open(select);
  }, true);

  document.addEventListener("keydown", event => {
    const select = controlAt(event.target);
    if (!select || event.isComposing || event.ctrlKey || event.metaKey) return;
    const opener = ["Enter", " ", "ArrowUp", "ArrowDown", "F4"].includes(event.key);
    const printable = event.key.length === 1 && !event.altKey;
    if (!opener && !printable) return;
    event.preventDefault();
    event.stopPropagation();
    open(select, opener ? "" : event.key);
  }, true);

  document.addEventListener("focusin", event => {
    if (source && !menu.contains(event.target)) close();
  });
  document.addEventListener("change", event => { if (event.target === source) close(); }, true);
  window.addEventListener("resize", () => { if (source) position(); });
  window.addEventListener("scroll", event => {
    if (source && (event.target === document || !menu.contains(event.target))) position();
  }, true);
})();

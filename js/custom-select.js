// Replaces every plain <select> under a given root with a custom-styled dropdown (button +
// floating option panel), while leaving the original <select> in the DOM as the source of
// truth (hidden, not removed). Picking a custom option sets the real select's value and
// dispatches a real 'change' event on it, so every existing data-bind / onchange handler in
// the app (project-form.js, entity-form.js, app.js) keeps working completely unchanged —
// this module only touches presentation, never how form values are read or validated.

let openPanel = null;

function closeOpenPanel() {
  if (!openPanel) return;
  openPanel.panel.hidden = true;
  openPanel.trigger.classList.remove('open');
  openPanel = null;
}

// Plain bubble phase, no stopPropagation: clicking a different select's trigger must still
// reach that trigger's own click handler in the same click (close old panel, open the new
// one) rather than needing a second click.
document.addEventListener('click', (e) => {
  if (openPanel && !openPanel.wrap.contains(e.target)) closeOpenPanel();
});
// Captures Escape ahead of any modal's own Escape-to-close handler (registered later, on
// modal open, so it would otherwise fire in the same tick) so closing a dropdown never also
// closes the modal it lives in.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPanel) { e.stopImmediatePropagation(); closeOpenPanel(); }
}, true);

function syncTrigger(wrap, select) {
  const label = wrap.querySelector('.cs-trigger-label');
  const opt = select.options[select.selectedIndex];
  label.textContent = opt ? opt.textContent : '';
  label.classList.toggle('placeholder', !select.value);
  wrap.querySelectorAll('.cs-option').forEach(o => o.classList.toggle('selected', o.dataset.csValue === select.value));
}

// Options panels get their own search box once there are enough options that scanning them
// is slower than typing a few letters (e.g. Developers, Projects) — short enum-style lists
// (project type, status, …) stay exactly as they were.
const SEARCH_THRESHOLD = 8;

function filterPanel(panel, query) {
  const q = query.trim().toLowerCase();
  let anyVisible = false;
  panel.querySelectorAll('.cs-option').forEach(o => {
    const match = !q || o.textContent.toLowerCase().includes(q);
    o.hidden = !match;
    if (match) anyVisible = true;
  });
  const empty = panel.querySelector('.cs-no-match');
  if (empty) empty.hidden = anyVisible;
}

function openWrapPanel(wrap) {
  if (openPanel && openPanel.wrap === wrap) { closeOpenPanel(); return; }
  closeOpenPanel();
  const trigger = wrap.querySelector('.cs-trigger');
  const panel = wrap.querySelector('.cs-panel');
  const search = panel.querySelector('.cs-search');
  panel.hidden = false;
  trigger.classList.add('open');
  const rect = trigger.getBoundingClientRect();
  panel.classList.toggle('cs-panel-up', window.innerHeight - rect.bottom < 260 && rect.top > 260);
  // A panel wider than its trigger (max-content) can spill past the right edge near the
  // end of a row — anchor it to the trigger's right edge instead when there isn't room.
  panel.classList.toggle('cs-panel-right', window.innerWidth - rect.left < 340);
  openPanel = { wrap, trigger, panel };
  if (search) {
    search.value = '';
    filterPanel(panel, '');
    search.focus();
  } else {
    const active = panel.querySelector('.cs-option.selected') || panel.querySelector('.cs-option');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function buildPanelOptions(panel, select) {
  panel.querySelectorAll('.cs-option, .cs-no-match').forEach(el => el.remove());
  [...select.options].forEach(opt => {
    const item = document.createElement('div');
    item.className = 'cs-option' + (opt.disabled ? ' disabled' : '');
    item.dataset.csValue = opt.value;
    item.textContent = opt.textContent;
    panel.appendChild(item);
  });
  const noMatch = document.createElement('div');
  noMatch.className = 'cs-no-match';
  noMatch.hidden = true;
  noMatch.textContent = 'No matches';
  panel.appendChild(noMatch);
}

// root: the container to scan (re-run safely after every re-render — already-enhanced
// selects are skipped via the .cs-native-select marker class).
export function enhanceSelects(root) {
  root.querySelectorAll('select:not(.cs-native-select)').forEach(select => {
    const wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('cs-native-select');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.disabled = select.disabled;
    trigger.innerHTML = `<span class="cs-trigger-label"></span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
    wrap.appendChild(trigger);

    const panel = document.createElement('div');
    panel.className = 'cs-panel';
    panel.hidden = true;
    if (select.options.length > SEARCH_THRESHOLD) {
      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'cs-search';
      search.placeholder = 'Search…';
      search.autocomplete = 'off';
      panel.appendChild(search);
      search.addEventListener('click', (e) => e.stopPropagation());
      search.addEventListener('keydown', (e) => e.stopPropagation());
      search.addEventListener('input', () => filterPanel(panel, search.value));
    }
    buildPanelOptions(panel, select);
    wrap.appendChild(panel);

    syncTrigger(wrap, select);

    trigger.addEventListener('click', () => { if (!trigger.disabled) openWrapPanel(wrap); });
    trigger.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openWrapPanel(wrap); }
    });
    panel.addEventListener('click', (e) => {
      const opt = e.target.closest('.cs-option');
      if (!opt || opt.classList.contains('disabled')) return;
      select.value = opt.dataset.csValue;
      // Sync the visible trigger/close the panel BEFORE dispatching change — a bound
      // 'change' handler elsewhere in the app may synchronously re-render this whole
      // subtree (e.g. the project wizard re-rendering a step when city changes), which
      // would otherwise leave this closure updating an already-detached copy of the DOM.
      syncTrigger(wrap, select);
      closeOpenPanel();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// Rebuilds an already-enhanced select's custom panel from its current <option> list — for
// selects whose options are replaced at runtime (e.g. a "Project" dropdown repopulated after
// a "Developer" dropdown changes), instead of only ever reading their options once.
export function refreshSelect(select) {
  const wrap = select.closest('.cs-wrap');
  if (!wrap) return;
  const panel = wrap.querySelector('.cs-panel');
  buildPanelOptions(panel, select);
  syncTrigger(wrap, select);
  wrap.querySelector('.cs-trigger').disabled = select.disabled;
}

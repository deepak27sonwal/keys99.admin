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

function openWrapPanel(wrap) {
  if (openPanel && openPanel.wrap === wrap) { closeOpenPanel(); return; }
  closeOpenPanel();
  const trigger = wrap.querySelector('.cs-trigger');
  const panel = wrap.querySelector('.cs-panel');
  panel.hidden = false;
  trigger.classList.add('open');
  const rect = trigger.getBoundingClientRect();
  panel.classList.toggle('cs-panel-up', window.innerHeight - rect.bottom < 260 && rect.top > 260);
  // A panel wider than its trigger (max-content) can spill past the right edge near the
  // end of a row — anchor it to the trigger's right edge instead when there isn't room.
  panel.classList.toggle('cs-panel-right', window.innerWidth - rect.left < 340);
  openPanel = { wrap, trigger, panel };
  const active = panel.querySelector('.cs-option.selected') || panel.querySelector('.cs-option');
  if (active) active.scrollIntoView({ block: 'nearest' });
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
    [...select.options].forEach(opt => {
      const item = document.createElement('div');
      item.className = 'cs-option' + (opt.disabled ? ' disabled' : '');
      item.dataset.csValue = opt.value;
      item.textContent = opt.textContent;
      panel.appendChild(item);
    });
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

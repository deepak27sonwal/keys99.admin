import { escapeHtml, icon } from './utils.js';

// Filters for a list table. A Filters button in the panel's toolbar (with a count badge when
// any are on) slides a sheet up from the bottom of the screen holding the page's dropdowns,
// a live "Show N …" button and Clear all; active filters show as removable chips under the
// panel head with a "Showing X of Y" count. Optionally adds a search box too.
//
// Filtering is client-side over rows already rendered, so it works on any table whose
// <tbody> rows line up one-to-one with `items`.
//
// Each filter: { key, label, get(item) → value } — dropdown options are built from the
// loaded items with counts, so a dropdown only offers values that match something; `raw`
// shows values as-is (names), `labels` overrides the default title-casing. Or, for ranges,
// { key, label, options: [{ value, label, match(item) → bool }] } with fixed options.
//
// Choices are kept per `stateKey` for the rest of the session, so they survive opening a
// record and coming back to the list.

const saved = {};
const FILTER_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';

export const titleCase = v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const optLabel = (f, v) => f.options?.find(o => o.value === v)?.label || f.labels?.[v] || (f.raw ? v : titleCase(v));
const matches = (f, item, v) => f.options ? !!f.options.find(o => o.value === v)?.match(item) : f.get(item) === v;

// Fixed date-range options for a timestamp field.
export function dateRangeOptions(get) {
  const within = days => item => {
    const t = get(item);
    return !!t && Date.now() - new Date(t).getTime() <= days * 864e5;
  };
  return [
    { value: '1', label: 'Last 24 hours', match: within(1) },
    { value: '7', label: 'Last 7 days', match: within(7) },
    { value: '30', label: 'Last 30 days', match: within(30) },
    { value: '90', label: 'Last 3 months', match: within(90) },
    { value: 'older', label: 'Older than 3 months', match: item => !!get(item) && !within(90)(item) }
  ];
}

// panel:        the .panel element holding the table
// items / rows: the data and its rendered <tr>s, in the same order
// filters:      see above
// stateKey:     where to keep this list's choices
// title:        sheet heading, e.g. "Filter Enquiries"
// noun:         [singular, plural] for counts, e.g. ['enquiry', 'enquiries']
// searchText:   item → text to search; adds a search box unless `searchInput` is given
// searchInput:  an existing search <input> to combine with the filters
// searchPlaceholder
export function attachListFilters({ panel, items, rows, filters, stateKey, title, noun = ['item', 'items'], searchText, searchInput, searchPlaceholder = 'Search' }) {
  if (!items.length) return;
  const chosen = saved[stateKey] ||= {};
  const tbody = rows[0].parentElement;
  const head = panel.querySelector('.panel-head');
  let toolbar = head.querySelector('.toolbar');
  if (!toolbar) { toolbar = document.createElement('div'); toolbar.className = 'toolbar'; head.appendChild(toolbar); }

  if (!searchInput && searchText) {
    const box = document.createElement('div');
    box.className = 'list-search';
    box.innerHTML = `${icon('search', 15)}<input type="text" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off">`;
    toolbar.prepend(box);
    searchInput = box.querySelector('input');
  }
  const texts = rows.map((r, i) => (searchText ? searchText(items[i]) : r.textContent).toLowerCase());

  const fieldsHtml = filters.map(f => {
    let opts;
    if (f.options) {
      opts = f.options.map(o => [o.value, items.filter(o.match).length]).filter(([, n]) => n);
    } else {
      const counts = new Map();
      items.forEach(it => { const v = f.get(it); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
      opts = [...counts].sort((a, b) => optLabel(f, a[0]).localeCompare(optLabel(f, b[0])));
    }
    if (chosen[f.key] && !opts.some(([v]) => v === chosen[f.key])) delete chosen[f.key];
    const html = opts.map(([v, n]) => `<option value="${escapeHtml(v)}"${chosen[f.key] === v ? ' selected' : ''}>${escapeHtml(optLabel(f, v))} (${n})</option>`).join('');
    return `<label class="list-filter"><span>${escapeHtml(f.label)}</span><select data-filter="${f.key}"${opts.length ? '' : ' disabled'}><option value="">All</option>${html}</select></label>`;
  }).join('');

  const noMatchRow = document.createElement('tr');
  noMatchRow.hidden = true;
  noMatchRow.innerHTML = `<td colspan="${rows[0].cells.length}"><div class="empty">No ${noun[1]} match your search or filters.</div></td>`;
  tbody.appendChild(noMatchRow);

  const filtersBtn = document.createElement('button');
  filtersBtn.type = 'button';
  filtersBtn.className = 'btn-outline filters-btn';
  filtersBtn.setAttribute('aria-haspopup', 'dialog');
  filtersBtn.innerHTML = `${FILTER_ICON}<span>Filters</span><span class="filters-badge" hidden></span>`;
  const search = searchInput?.closest('.list-search');
  if (search && search.parentElement === toolbar) search.after(filtersBtn); else toolbar.prepend(filtersBtn);

  const summary = document.createElement('div');
  summary.className = 'filter-summary';
  summary.hidden = true;
  head.after(summary);

  const sheet = document.createElement('div');
  sheet.className = 'filter-sheet-layer';
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="filter-sheet-backdrop" data-close-sheet></div>
    <div class="filter-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="filter-sheet-grip"></div>
      <div class="filter-sheet-head">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" data-close-sheet aria-label="Close">✕</button>
      </div>
      <div class="filter-sheet-body">${fieldsHtml}</div>
      <div class="filter-sheet-foot">
        <button type="button" class="btn-outline" data-sheet-clear>Clear all</button>
        <button type="button" class="btn-primary" data-sheet-apply data-close-sheet></button>
      </div>
    </div>`;
  // Next to the panel (inside the page's content), so it goes away with the page.
  panel.after(sheet);

  const escClose = (e) => { if (e.key === 'Escape') closeSheet(); };
  const openSheet = () => {
    sheet.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
    document.addEventListener('keydown', escClose);
    sheet.querySelector('select:not(:disabled)')?.focus({ preventScroll: true });
  };
  function closeSheet() {
    if (!sheet.classList.contains('open')) return;
    sheet.classList.remove('open');
    document.removeEventListener('keydown', escClose);
    setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 260);
    filtersBtn.focus({ preventScroll: true });
  }
  filtersBtn.addEventListener('click', openSheet);
  sheet.querySelectorAll('[data-close-sheet]').forEach(el => el.addEventListener('click', closeSheet));

  const apply = () => {
    const q = (searchInput?.value || '').trim().toLowerCase();
    const active = filters.filter(f => chosen[f.key]);
    let shown = 0;
    rows.forEach((row, i) => {
      const match = (!q || texts[i].includes(q)) && active.every(f => matches(f, items[i], chosen[f.key]));
      row.hidden = !match;
      if (match) shown++;
    });
    noMatchRow.hidden = shown > 0;

    const badge = filtersBtn.querySelector('.filters-badge');
    badge.hidden = !active.length;
    badge.textContent = active.length;
    filtersBtn.classList.toggle('active', active.length > 0);
    sheet.querySelector('[data-sheet-apply]').textContent = `Show ${shown} ${shown === 1 ? noun[0] : noun[1]}`;
    sheet.querySelector('[data-sheet-clear]').disabled = !active.length;
    sheet.querySelectorAll('select[data-filter]').forEach(sel => sel.classList.toggle('active', !!sel.value));

    summary.hidden = !active.length && !q;
    summary.innerHTML = active.map(f => `<span class="chip active filter-chip">${escapeHtml(f.label)}: ${escapeHtml(optLabel(f, chosen[f.key]))}<button type="button" data-remove-filter="${f.key}" aria-label="Remove ${escapeHtml(f.label)} filter">✕</button></span>`).join('') +
      `<span class="filter-summary-count">Showing ${shown} of ${items.length}</span><button type="button" class="panel-link" data-clear-all>Clear all</button>`;
  };
  const setFilter = (key, value) => {
    if (value) chosen[key] = value; else delete chosen[key];
    const sel = sheet.querySelector(`select[data-filter="${key}"]`);
    if (sel) sel.value = value || '';
  };
  const clearAll = (alsoSearch) => {
    Object.keys(chosen).forEach(k => setFilter(k, ''));
    if (alsoSearch && searchInput) searchInput.value = '';
    apply();
  };
  sheet.querySelectorAll('select[data-filter]').forEach(sel => sel.addEventListener('change', () => { setFilter(sel.dataset.filter, sel.value); apply(); }));
  sheet.querySelector('[data-sheet-clear]').addEventListener('click', () => clearAll(false));
  summary.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-filter]');
    if (rm) { setFilter(rm.dataset.removeFilter, ''); apply(); }
    else if (e.target.closest('[data-clear-all]')) clearAll(true);
  });
  searchInput?.addEventListener('input', apply);
  apply();
}

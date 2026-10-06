/* Filterable legend, anchored to the bottom-left of the map by CSS.
   The box is deliberately NOT draggable: its position is owned entirely by
   app.css, and this file only manages the filter checkboxes, the counts and
   the collapse toggle. Per-brand visibility and the collapsed state are still
   remembered in localStorage. */
(function (global) {
  'use strict';

  // Unchanged from v3 on purpose. That key already holds the per-brand
  // visibility and collapsed state we still want to keep; drag coordinates
  // used to live in the same record and are now simply ignored on read.
  var STORE_KEY = 'bgm.legend.v3';

  function Legend(el, options) {
    this.el = el;
    this.head = el.querySelector('#legend-head');
    this.body = el.querySelector('.legend-body');
    this.brandBox = el.querySelector('#legend-brands');
    this.collapseBtn = el.querySelector('#legend-collapse');
    this.allBtn = el.querySelector('#legend-all');
    this.noneBtn = el.querySelector('#legend-none');
    this.onToggle = (options && options.onToggle) || function () {};
    this.hidden = {};
    this.collapsed = false;
  }

  Legend.prototype.start = function (brands) {
    this.brands = brands;
    this._restore();
    this._render();
    this._bindCollapse();
    return this;
  };

  Legend.prototype._loadStore = function () {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  };

  /** Persists only what is still remembered: per-brand visibility and the
      collapsed state. Coordinates are gone from the record entirely. */
  Legend.prototype._saveStore = function () {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ collapsed: this.collapsed, hidden: this.hidden }),
      );
    } catch (e) {
      /* private mode / quota - state simply will not persist */
    }
  };

  Legend.prototype._restore = function () {
    var self = this;
    var saved = this._loadStore();
    if (saved.collapsed) this.setCollapsed(true, true);
    // Any x/y left in an older record is ignored: the box is CSS-anchored now
    // and must not be placed from stale data.

    // Stations start VISIBLE. This used to be the other way round
    // (`savedHidden[b.slug] !== false`), which meant a slug with no saved
    // entry - i.e. every slug on a first visit, since localStorage is empty -
    // evaluated to hidden. A brand's markers and rows therefore only appeared
    // once the visitor manually ticked it, and the map greeted everyone with
    // "All brands are hidden" and zero pins.
    //
    // Now only an explicit `true` hides a brand, so a stored "I hid this" is
    // still remembered while a first-time visitor sees the whole map.
    var savedHidden = saved.hidden && typeof saved.hidden === 'object' ? saved.hidden : {};
    this.hidden = {};
    this.brands.forEach(function (b) {
      self.hidden[b.slug] = savedHidden[b.slug] === true;
    });
  };

  Legend.prototype._render = function () {
    var self = this;
    var html = this.brands
      .map(function (b) {
        var isHidden = !!self.hidden[b.slug];
        return (
          '<label class="legend-row' + (isHidden ? ' off' : '') + '" data-slug="' + MapIcons.escape(b.slug) + '">' +
          '<input type="checkbox" data-slug="' + MapIcons.escape(b.slug) + '"' + (isHidden ? '' : ' checked') + '>' +
          MapIcons.brandLogo(b) +
          '<span>' + MapIcons.escape(b.name) + '</span>' +
          '<span class="legend-count" data-count="' + MapIcons.escape(b.slug) + '">' + (b.stationCount || 0) + '</span>' +
          '</label>'
        );
      })
      .join('');

    this.brandBox.innerHTML = html || '<p class="empty-note">No brands configured.</p>';

    this.brandBox.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      input.addEventListener('change', function () {
        self._setHidden(input.dataset.slug, !input.checked);
      });
    });
  };

  /** The checkbox row for a brand slug, or null. */
  Legend.prototype._rowFor = function (slug) {
    var safe = global.CSS && global.CSS.escape ? global.CSS.escape(slug) : slug;
    return this.brandBox.querySelector('.legend-row[data-slug="' + safe + '"]');
  };

  Legend.prototype._setHidden = function (slug, hidden) {
    this.hidden[slug] = hidden;
    var row = this._rowFor(slug);
    if (row) row.classList.toggle('off', hidden);
    this._saveStore();
    this.onToggle(slug, !hidden);
  };

  /**
   * Show all / Hide all, applied in a single pass.
   *
   * These used to loop _setHidden over every brand, and each call fired
   * onToggle, which re-filters every marker and rebuilds the whole station
   * list. One click therefore rewrote the list once per brand - five full
   * innerHTML passes for five brands - which is what read as "weird": the
   * list flickered, jumped back to the top, and the brand logos re-decoded
   * mid-click. Row classes, the localStorage write and the callback now each
   * happen exactly once. onToggle gets a null slug to mean "no single brand".
   */
  Legend.prototype._setAll = function (hidden) {
    var self = this;
    var changed = false;
    this.brands.forEach(function (b) {
      if (!!self.hidden[b.slug] !== hidden) {
        self.hidden[b.slug] = hidden;
        changed = true;
      }
      var row = self._rowFor(b.slug);
      if (row) row.classList.toggle('off', hidden);
    });
    // Nothing moved, so skip the re-render rather than churn the list for it.
    if (!changed) return;
    this._saveStore();
    this.onToggle(null, !hidden);
    this._syncInputs();
  };

  /** Updates the per-brand station counts without re-rendering checkboxes. */
  Legend.prototype.setCounts = function (counts) {
    var self = this;
    Object.keys(counts || {}).forEach(function (slug) {
      var el = self.brandBox.querySelector('[data-count="' + (global.CSS && CSS.escape ? CSS.escape(slug) : slug) + '"]');
      if (el) el.textContent = counts[slug];
    });
  };

  Legend.prototype.isVisible = function (slug) {
    return !this.hidden[slug];
  };

  /**
   * Reveals a single brand and ticks its checkbox. Used when a station is picked
   * from the search results: its brand may have been unticked, so without this
   * the map would fly to a marker that is not on it and show no popup.
   */
  Legend.prototype.showBrand = function (slug) {
    if (this.isVisible(slug)) return;
    this._setHidden(slug, false);
    this._syncInputs();
  };

  Legend.prototype._bindCollapse = function () {
    var self = this;
    this.collapseBtn.addEventListener('click', function () {
      self.setCollapsed(!self.collapsed);
    });
    this.allBtn.addEventListener('click', function () { self._setAll(false); });
    this.noneBtn.addEventListener('click', function () { self._setAll(true); });
  };

  Legend.prototype._syncInputs = function () {
    var self = this;
    this.brandBox.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      input.checked = self.isVisible(input.dataset.slug);
      var row = input.closest('.legend-row');
      if (row) row.classList.toggle('off', !input.checked);
    });
  };

  Legend.prototype.setCollapsed = function (collapsed, silent) {
    this.collapsed = collapsed;
    this.el.classList.toggle('collapsed', collapsed);
    this.collapseBtn.textContent = collapsed ? '+' : '−';
    this.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    this.collapseBtn.setAttribute('aria-label', collapsed ? 'Expand legend' : 'Collapse legend');
    if (!silent) this._saveStore();
  };

  global.Legend = Legend;
})(window);

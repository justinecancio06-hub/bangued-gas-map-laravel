/* Refuelio - Bangued's Gas Station Hub: public, read-only view, on the Maps
   JavaScript API. */
(function () {
  'use strict';

  /* The base maps, keyed by the value the pill persists in localStorage.
     `hybrid` is the one the old Esri labels overlay stood in for: Google's
     hybrid view already draws place names over the imagery, so there is nothing
     left to toggle.

     `cyclosm` has no mapTypeId on purpose. It is an OpenStreetMap tile server,
     so it only exists on the free Leaflet map; picking it while Google is live
     hands the map over to that fallback rather than pretending. */
  var MAP_TYPES = [
    { mode: 'street', mapTypeId: 'roadmap', label: 'Default' },
    { mode: 'satellite', mapTypeId: 'satellite', label: 'Satellite' },
    { mode: 'hybrid', mapTypeId: 'hybrid', label: 'Hybrid' },
    { mode: 'cyclosm', mapTypeId: null, label: 'CyclOSM' },
  ];

  var state = {
    provider: 'google',
    gmaps: null,
    map: null,
    bounds: null,        // google.maps.LatLngBounds covering Bangued
    boundary: null,
    fallbackMap: null,
    fallbackBounds: null,
    fallbackBoundary: null,
    fallbackMarkers: {},
    fallbackBases: {},
    activeBase: null,
    infoWindow: null,
    stations: [],
    brands: [],
    cfg: null,
    // Fuel types from /api/meta, offered as datalist options in the inline
    // price editor.
    fuelTypes: [],
    // The signed-in user as /api/me reports them, or null for a visitor and
    // for anyone whose probe failed. Only a station_manager with a station
    // gets the inline price editor, and only on that station.
    me: null,
    // stationId -> { marker: google.maps.Marker, ready: boolean }
    markers: {},
    legend: null,
    activeId: null,
  };

  var el = {};

  /* ------------------------------------------------------------------ utils */

  function peso(value) {
    return '₱' + Number(value).toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatTimestamp(value) {
    return FmtTime.format(value);
  }

  function escapeHtml(s) {
    return MapIcons.escape(s);
  }

  var LAYER_KEY = 'bgm.layer';

  /**
   * The saved base layer, or 'street'.
   *
   * Reading localStorage throws a SecurityError outright wherever storage is
   * unavailable - hardened Firefox, a sandboxed iframe, some private modes -
   * and this file already guards its sessionStorage reads for exactly that
   * reason. The bare getItem in boot() did not: it threw after the legend and
   * the markers were already drawn, the rejection was unhandled, and
   * hideLoader() never ran, so the loader covered the map and the list for good.
   */
  function readLayer() {
    try {
      return localStorage.getItem(LAYER_KEY) || 'street';
    } catch (e) {
      return 'street';
    }
  }

  function writeLayer(mode) {
    try {
      localStorage.setItem(LAYER_KEY, mode);
    } catch (e) {
      /* private mode / quota - the choice simply will not persist */
    }
  }

  var toastTimer;
  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, ms || 6000);
  }

  function hideLoader() {
    el.loader.classList.add('fade');
    setTimeout(function () { el.loader.hidden = true; }, 320);
  }

  /** Fails the loader with a message and a hint, rather than leaving a blank map. */
  function failLoader(message, hint) {
    el.loaderText.textContent = message;
    el.loader.hidden = false;
    el.loader.classList.remove('fade');
    toast(message + (hint ? ' ' + hint : ''), 15000);
  }

  /**
   * Detects Google Maps refusing to authenticate and reacts.
   *
   * An invalid key, a key without billing, an exhausted quota or a referrer
   * restriction all fail *quietly*: the Maps script still loads, google.maps.Map
   * still constructs, and no exception is thrown. Google just paints its own
   * grey panel over the map saying "Oops! Something went wrong ... see the
   * JavaScript console" - a dead end for whoever has to fix it. The failure is
   * therefore detected from Google's own error overlay, .gm-err-container.
   *
   * A demo key's quota is the case worth retrying: it is shared and comes back
   * intermittently, so the same page that failed a minute ago works now. The
   * auth failure is sticky for the lifetime of the loaded script - there is no
   * way to re-authenticate in place - so recovering means reloading the page
   * and asking again. That is bounded and rate-limited below; after the last
   * attempt the explanatory card stands instead, and everything else on the page
   * (list, search, legend) keeps working.
   *
   * It deliberately does NOT use failLoader(): that overlay covers the whole
   * viewport and would hide the station list and legend, both of which keep
   * working because a key failure has no effect on the data.
   *
   * A MutationObserver is used rather than a poll so a healthy map costs
   * nothing after boot.
   */
  function watchForMapAuthFailure() {
    var node = el.map;
    // This file is wrapped in a bare IIFE with no `global` alias, unlike
    // admin.js and icons.js - reaching for one here threw
    // "ReferenceError: global is not defined" and aborted boot() outright,
    // leaving the map stuck on "Loading Google Maps...".
    if (!node || !window.MutationObserver) return;

    mapWatch = new window.MutationObserver(function () {
      if (!node.querySelector('.gm-err-container')) return;

      if (window.L && state.provider !== 'fallback' && state.cfg) {
        switchToFallbackMap();
        toast('Google Maps stopped drawing, so the free OpenStreetMap fallback is shown.', 10000);
        return;
      }
      handleMapAuthFailure();
    });

    mapWatch.observe(node, { childList: true, subtree: true });
  }

  /* The observer watching for Google's own failure panel. Held so
     switchToFallbackMap() can disconnect it: an emptied container is exactly what
     it watches for, so leaving it attached would have it fire on the teardown it
     was meant to detect the failure before. */
  var mapWatch = null;

  /** Retry attempts allowed per browser session before giving up. */
  var MAP_RETRY_KEY = 'bgm.mapRetries';
  var MAP_RETRY_LIMIT = 3;

  /**
   * Retries the page a bounded number of times while Google is rejecting the
   * key, then falls back to the explanatory card.
   */
  function handleMapAuthFailure() {
    var attempts = 0;
    try {
      attempts = Number(window.sessionStorage.getItem(MAP_RETRY_KEY)) || 0;
    } catch (e) {
      // Private mode with storage disabled: treat as no retries rather than
      // reloading forever.
      showMapNotice();
      return;
    }

    if (attempts >= MAP_RETRY_LIMIT) {
      showMapNotice();
      return;
    }

    attempts += 1;
    try {
      window.sessionStorage.setItem(MAP_RETRY_KEY, String(attempts));
    } catch (e) { /* nothing to persist to; the reload still helps */ }

    // Back off a little further each time so a tight loop cannot hammer Google.
    var waitSeconds = 6 * attempts;
    var notice = ensureRetryNotice();
    notice.hidden = false;
    notice.innerHTML =
      '<div class="map-notice-card">' +
      '<h2>Google Maps is rate-limiting this key</h2>' +
      '<p>Retrying automatically in ' + waitSeconds + ' seconds ' +
      '(attempt ' + attempts + ' of ' + MAP_RETRY_LIMIT + ').</p>' +
      '<p>A demo API key has a small shared quota that frees up intermittently, so the ' +
      'map often appears on a later attempt. The station list and search work now regardless.</p>' +
      '</div>';

    window.setTimeout(function () {
      window.location.reload();
    }, waitSeconds * 1000);
  }

  /** Creates the retry card once and returns it. */
  function ensureRetryNotice() {
    if (!el.retryNotice) {
      el.retryNotice = document.createElement('div');
      el.retryNotice.className = 'map-notice';
      el.retryNotice.setAttribute('role', 'status');
      document.body.appendChild(el.retryNotice);
    }

    if (el.loader && !el.loader.hidden) {
      el.loader.classList.add('fade');
      window.setTimeout(function () { el.loader.hidden = true; }, 320);
    }

    return el.retryNotice;
  }

  /**
   * Shows the map-scoped "Google Maps could not load" card, and repeats the
   * detail in a toast so it is seen even if the card is scrolled past.
   */
  function showMapNotice() {
    // The loading spinner has done its job either way; the card replaces it so
    // the list and legend are not sitting behind a blurred backdrop.
    if (el.loader && !el.loader.hidden) {
      el.loader.classList.add('fade');
      setTimeout(function () { el.loader.hidden = true; }, 320);
    }

    if (el.retryNotice) {
      el.retryNotice.hidden = true;
    }

    if (!el.mapNotice) {
      el.mapNotice = document.createElement('div');
      el.mapNotice.className = 'map-notice';
      el.mapNotice.setAttribute('role', 'alert');
      el.mapNotice.innerHTML =
        '<div class="map-notice-card">' +
        '<h2>Google Maps could not load</h2>' +
        '<p>This is an API key problem, not an application error. The browser console names the ' +
        'exact cause.</p>' +
        '<p>Usual causes: the daily quota is exhausted (a demo key), billing is not enabled on the ' +
        'Cloud project, or the key\'s HTTP-referrer restriction does not match this site.</p>' +
        '<p>Check <code>GOOGLE_MAPS_API_KEY</code> in <code>.env</code>. The station list, search ' +
        'and legend below still work.</p>' +
        '</div>';
      document.body.appendChild(el.mapNotice);
    }

    el.mapNotice.hidden = false;
    toast('Google Maps rejected the API key - check GOOGLE_MAPS_API_KEY in .env. Stations still searchable.', 15000);
  }

  /* ----------------------------------------------------------------- popup */

  /**
   * True when the station name already spells out its brand, e.g. "Blu Gas
   * Station #1" or a station literally named "Petron". In that case the brand
   * is suppressed anywhere it would just repeat the title.
   */
  function nameContainsBrand(station) {
    var name = String(station.name || '').toLowerCase();
    var brand = String(station.brand.name || '').toLowerCase();
    if (!brand) return false;
    return name === brand || name.indexOf(brand) !== -1;
  }

  /**
   * True only for a signed-in station_manager looking at their own station.
   * Drives the Edit Prices button; the same rule is re-checked server-side in
   * AdminApiController::savePrices(), which is what actually protects the data.
   */
  function canManagePrices(station) {
    var me = state.me;
    return !!me &&
      me.role === 'station_manager' &&
      me.station_id != null &&
      Number(me.station_id) === Number(station.id);
  }

  function buildPopup(station) {
    var brand = station.brand;

    // Option A: the title is the station name only. The brand is never
    // concatenated onto it - it is carried by the brand logo, the header
    // gradient, and a chip in the body when it adds information.
    var head =
      '<div class="pop-head" style="background:linear-gradient(135deg,' + escapeHtml(brand.colorPrimary) + ' 0%,' +
      shade(brand.colorPrimary, -18) + ' 100%)">' +
      '<span class="pop-mark">' +
      MapIcons.brandLogo(brand, {
        lazy: true,
        // The white pin stands in if the brand has no logo file.
        fallback: MapIcons.pinSvg({ colorPrimary: '#ffffff', colorSecondary: 'transparent' }, 20),
      }) +
      '</span>' +
      '<span class="pop-name">' + escapeHtml(station.name) + '</span>' +
      // Our own close button rather than the one Google injects: the InfoWindow
      // content is handed over as a DOM node, so this can be wired up directly
      // and styled to sit on the brand-coloured header.
      '<button class="pop-close" type="button" aria-label="Close">&times;</button>' +
      '</div>';

    var brandChip = nameContainsBrand(station)
      ? ''
      : '<span class="pop-brand-chip" style="background:' + escapeHtml(brand.colorPrimary) +
        ';border-color:' + escapeHtml(brand.colorSecondary || 'rgba(0,0,0,.15)') + '">' +
        escapeHtml(brand.name) + '</span>';

    var rows = '';
    if (station.address) {
      // Escaped like every other admin-editable field here. The address is the
      // one field that was passed through raw, and it lands in innerHTML below,
      // so a station saved with markup in its address ran it for every public
      // visitor who opened the pin.
      rows += row('pin', escapeHtml(station.address));
    }
    if (station.barangay) {
      rows += row('info', 'Barangay: ' + escapeHtml(station.barangay));
    }
    if (station.operatingHours) {
      rows += row('clock', escapeHtml(station.operatingHours));
    }
    // The phone number is deliberately absent from the rows above: it is now the
    // Call button in the action bar, and a visitor who tapped it was left with
    // two controls for one job.

    /*
     * Prices lead. They used to sit at the bottom of the card in a two-column
     * table, below the address and the opening hours, which made the one number
     * people actually came for the last thing they saw. They now render as a
     * grid of chips directly under the header, and the moment the price was
     * confirmed rides beside the heading - a week-old figure reads as current
     * when its timestamp is small grey text underneath it.
     */
    var pricesHtml = '';
    if (station.prices && station.prices.length) {
      var chips = station.prices
        .map(function (p) {
          return '<div class="pop-chip">' +
            '<span class="pop-chip-type">' + escapeHtml(p.fuelType) + '</span>' +
            '<span class="pop-chip-price">' + peso(p.pricePerLiter) + '</span>' +
            '</div>';
        })
        .join('');

      var ago = FmtTime.relative(station.lastPriceUpdate);
      var freshHtml = ago
        ? '<span class="pop-fresh is-' + freshnessTone(station.lastPriceUpdate) + '">' +
          '<span class="pop-fresh-dot" aria-hidden="true"></span>' + escapeHtml(ago) + '</span>'
        : '';

      var updated = formatTimestamp(station.lastPriceUpdate);

      pricesHtml =
        '<div class="pop-prices">' +
        '<div class="pop-prices-head"><h4>Fuel price per liter</h4>' + freshHtml + '</div>' +
        '<div class="pop-chip-grid">' + chips + '</div>' +
        (updated ? '<p class="pop-updated">Confirmed ' + updated + '</p>' : '') +
        '</div>';
    } else {
      pricesHtml =
        '<div class="pop-prices"><h4>Fuel price per liter</h4>' +
        '<p class="price-empty">No price data published yet.</p></div>';
    }

    var flag = '';
    if (station.locationConfidence === 'approximate') {
      flag =
        '<span class="pop-flag">Approximate position &mdash; not yet verified</span>';
    }
    if (station.locationConfidence === 'confirmed') {
      flag = '<span class="pop-flag" style="background:#e8f5e9;color:#2e7d32">Verified location</span>';
    }

    var note = station.notes
      ? '<div class="pop-note">' + escapeHtml(station.notes) + '</div>'
      : '';

    /*
     * The action bar. Reaching a station is the whole point of pinning it on a
     * map, and the card previously offered no way to do it at all - the address
     * was plain text. Directions is a deep link to the station's own
     * coordinates; Call only appears when a number is actually on file, so a
     * station without one does not show a button that cannot work.
     */
    var actions = '';
    if (hasUsableCoords(station)) {
      actions += '<a class="pop-act pop-act-primary" target="_blank" rel="noopener noreferrer" href="' +
        escapeHtml(directionsUrl(station)) + '">' +
        MapIcons.smallIcon('navigate') + '<span>Directions</span></a>';
    }
    if (station.contactPhone) {
      actions += '<a class="pop-act" href="tel:' +
        escapeHtml(String(station.contactPhone).replace(/\s+/g, '')) + '">' +
        MapIcons.smallIcon('phone') + '<span>Call</span></a>';
    }
    // The station_manager's own station, and only that one, gets the inline
    // price editor. Every other popup - and every popup for an admin or a
    // signed-out visitor - stays read-only. The server re-checks exactly this
    // rule on save, so hiding the button is presentation, not permission.
    if (canManagePrices(station)) {
      actions += '<button class="pop-act pop-act-edit" type="button">' +
        MapIcons.smallIcon('gauge') + '<span>Edit Prices</span></button>';
    }
    var actionsHtml = actions
      ? '<div class="pop-actions">' + actions + '</div>'
      : '';

    return '<div class="pop">' +
      // Purely a visual affordance for the bottom-sheet layout; the card closes
      // on the close button, on Escape and on a tap of the map, never on a drag.
      '<div class="pop-grip" aria-hidden="true"></div>' +
      head +
      '<div class="pop-body">' + brandChip + pricesHtml + rows + flag + actionsHtml + note + '</div>' +
      '</div>';
  }

  /** True when the station has two finite coordinates to navigate to. */
  function hasUsableCoords(station) {
    return station.latitude !== null && station.latitude !== undefined &&
      station.longitude !== null && station.longitude !== undefined &&
      isFinite(Number(station.latitude)) && isFinite(Number(station.longitude));
  }

  /**
   * How far to trust a published price: within a day, within three, or older.
   */
  function freshnessTone(value) {
    var hours = FmtTime.ageHours(value);
    if (hours === null) return 'unknown';
    if (hours < 24) return 'fresh';
    if (hours < 72) return 'recent';
    return 'stale';
  }

  /**
   * A deep link that opens turn-by-turn navigation to the station.
   *
   * Apple Maps is addressed on iOS and Google Maps everywhere else, because a
   * google.com/maps URL handed to an iPhone opens a web page instead of the
   * Maps app. These are consumer navigation links: they are unrelated to the
   * Maps JavaScript API, its key or its billing.
   */
  function directionsUrl(station) {
    var target = Number(station.latitude) + ',' + Number(station.longitude);
    var iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    var apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || iPadOs;
    return apple
      ? 'https://maps.apple.com/?daddr=' + target
      : 'https://www.google.com/maps/dir/?api=1&destination=' + target;
  }

  function row(icon, html) {
    return '<div class="pop-row">' + MapIcons.smallIcon(icon) + '<span>' + html + '</span></div>';
  }

  /** Lightens (t>0) or darkens (t<0) a #rrggbb colour. */
  function shade(hex, percent) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return hex;
    var num = parseInt(m[1] + m[2] + m[3], 16);
    var amt = Math.round(2.55 * percent);
    var r = Math.min(255, Math.max(0, (num >> 16) + amt));
    var g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
    var b = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /**
   * Shows a station's InfoWindow, anchored above its marker.
   *
   * The content is set as a DOM node rather than an HTML string so the close
   * button inside it can be wired up - Google only injects listeners into its
   * own chrome, not into string content.
   */
  function openInfoWindow(station) {
    if (state.provider === 'fallback') {
      var fentry = state.fallbackMarkers[station.id];
      if (!fentry || !fentry.marker) return;
      var fnode = document.createElement('div');
      fnode.innerHTML = buildPopup(station);
      wirePopup(station, fnode, function () {
        fentry.marker.closePopup();
      });
      if (!fentry.marker.getPopup()) {
        // closeButton:false - the popup carries its own .pop-close on the
        // brand-coloured header, so Leaflet's own would be a second X.
        //
        // autoPan is off on phones because the stylesheet turns the card into a
        // bottom sheet there: Leaflet would pan the map to fit a box that is no
        // longer anchored to anything, shoving the station under the header.
        fentry.marker.bindPopup(fnode, {
          maxWidth: 340,
          minWidth: 300,
          className: 'station-sheet',
          closeButton: false,
          autoPan: !isNarrowViewport(),
          autoPanPadding: [24, 72],
        });
      } else {
        fentry.marker.setPopupContent(fnode);
      }
      fentry.marker.openPopup();
      // Only bites on phones, where the stylesheet docks the card to the bottom
      // edge; harmless otherwise.
      document.body.classList.add('sheet-open');
      return;
    }

    var entry = state.markers[station.id];
    if (!entry) return;

    var node = document.createElement('div');
    node.innerHTML = buildPopup(station);
    wirePopup(station, node, function () {
      state.infoWindow.close();
    });

    state.infoWindow.setContent(node);
    state.infoWindow.open({ anchor: entry.marker, map: state.map });
  }

  /**
   * Wires a freshly rendered popup's own controls before it is attached.
   *
   * Both controls are ours, not the libraries': Google only injects listeners
   * into the chrome it draws itself, and Leaflet takes markup verbatim, so the
   * close button and the Edit Prices button would otherwise be inert in either
   * provider. closeFn closes whatever is displaying this node - an
   * InfoWindow.close() or a marker.closePopup() - and is also what cancels an
   * editor that is mid-edit, since cancelling simply re-renders this node.
   */
  function wirePopup(station, node, closeFn) {
    var close = node.querySelector('.pop-close');
    if (close) close.addEventListener('click', closeFn);

    var edit = node.querySelector('.pop-act-edit');
    if (edit) {
      edit.addEventListener('click', function () {
        openPriceEditor(station, node, closeFn);
      });
    }
  }

  /**
   * Swaps a popup's read-only price block for an inline editor, in place.
   *
   * Reached only from the Edit Prices button that buildPopup() draws for one
   * station and one session: a station_manager assigned to it (see
   * canManagePrices()). The PUT behind it enforces the same rule server-side,
   * so this is presentation - but pricing their station is the entire reason a
   * manager signs in, so the form lives in the popup rather than in the
   * dashboard they are deliberately kept out of.
   *
   * The endpoint replaces the whole set: rows removed here are deleted on
   * save, and an empty submission is refused rather than wiping the station.
   * On success the response is the station as the API sees it, so it is merged
   * back into the same object the marker closures hold and the popup re-renders
   * read-only - no reopen, no second fetch, no marker churn.
   */
  function openPriceEditor(station, node, closeFn) {
    var pricesBlock = node.querySelector('.pop-prices');
    if (!pricesBlock) return;

    ensureFuelTypeDatalist();

    var form = document.createElement('form');
    form.className = 'pop-edit';
    form.setAttribute('novalidate', '');
    form.innerHTML =
      '<div class="pop-edit-head">' +
      '<h4>Edit fuel prices</h4>' +
      '<span class="pop-edit-note">Prices are per liter</span>' +
      '</div>' +
      '<div class="pop-edit-rows"></div>' +
      '<p class="pop-edit-error" hidden></p>' +
      '<div class="pop-edit-actions">' +
      '<button class="pop-edit-add" type="button">+ Add fuel type</button>' +
      '<span class="pop-edit-spacer"></span>' +
      '<button class="pop-edit-cancel" type="button">Cancel</button>' +
      '<button class="pop-edit-save" type="submit">Save</button>' +
      '</div>';

    var rowsBox = form.querySelector('.pop-edit-rows');
    var errorBox = form.querySelector('.pop-edit-error');
    var saveBtn = form.querySelector('.pop-edit-save');
    var saveLabel = saveBtn.textContent;

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    function clearError() {
      errorBox.hidden = true;
    }

    function addRow(fuelType, price) {
      var row = document.createElement('div');
      row.className = 'pop-edit-row';
      row.innerHTML =
        '<input class="pop-edit-type" type="text" list="pop-fuel-types" maxlength="80"' +
        ' placeholder="Fuel type" aria-label="Fuel type">' +
        '<input class="pop-edit-price" type="number" min="0" max="10000" step="0.01"' +
        ' inputmode="decimal" placeholder="0.00" aria-label="Price per liter">' +
        '<button class="pop-edit-drop" type="button" aria-label="Remove this fuel type">&times;</button>';
      row.querySelector('.pop-edit-type').value = fuelType || '';
      if (price !== null && price !== undefined) row.querySelector('.pop-edit-price').value = price;
      row.querySelector('.pop-edit-drop').addEventListener('click', function () {
        row.remove();
        clearError();
      });
      rowsBox.appendChild(row);
      return row;
    }

    var existing = (station.prices && station.prices.length) ? station.prices : [];
    existing.forEach(function (p) {
      addRow(p.fuelType, p.pricePerLiter);
    });
    if (!rowsBox.children.length) addRow('', null);

    form.querySelector('.pop-edit-add').addEventListener('click', function () {
      var row = addRow('', null);
      row.querySelector('.pop-edit-type').focus();
    });
    form.querySelector('.pop-edit-cancel').addEventListener('click', function () {
      node.innerHTML = buildPopup(station);
      wirePopup(station, node, closeFn);
    });
    form.addEventListener('input', clearError);

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var prices = [];
      var seen = {};
      for (var i = 0; i < rowsBox.children.length; i++) {
        var row = rowsBox.children[i];
        var type = row.querySelector('.pop-edit-type').value.trim();
        var raw = row.querySelector('.pop-edit-price').value;

        // A half-filled row is a mistake, not a row to skip silently - the
        // save would drop that fuel type from the station entirely.
        if (!type && raw === '') continue;
        if (!type) {
          showError('Every price row needs a fuel type.');
          row.querySelector('.pop-edit-type').focus();
          return;
        }
        if (raw === '' || !isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 10000) {
          showError('Enter a price for "' + type + '" between 0 and 10000.');
          row.querySelector('.pop-edit-price').focus();
          return;
        }

        var key = type.toLowerCase();
        if (seen[key]) {
          showError('"' + type + '" appears twice - each fuel type needs one price.');
          return;
        }
        seen[key] = true;

        prices.push({ fuelType: type, pricePerLiter: Number(raw) });
      }

      if (!prices.length) {
        showError('Enter at least one fuel type and price before saving.');
        return;
      }

      clearError();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      // effectiveAt omitted: the endpoint stamps the save time, which is what
      // this quick editor means by "now".
      Api.savePrices(station.id, prices, null)
        .then(function (resp) {
          applyStationUpdate(station, resp && resp.data);
          node.innerHTML = buildPopup(station);
          wirePopup(station, node, closeFn);
          // Repaints the list rows beside the map, which quote the same prices.
          applyBrandFilters();
          toast('Prices saved for ' + station.name + '.');
        })
        .catch(function (err) {
          // 403 lands here if the session's assignment changed mid-edit; the
          // server's message is the one worth showing.
          showError(err.message || 'Could not save prices.');
        })
        .finally(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = saveLabel;
        });
    });

    pricesBlock.replaceWith(form);
    var firstType = form.querySelector('.pop-edit-type');
    if (firstType) firstType.focus();
  }

  /**
   * Folds a saved station back into the object the popups and markers already
   * hold. Marker closures and renderList() both capture the station object
   * itself, so mutating it in place keeps every reference - popup, list row,
   * selection ring - on the new prices without re-plotting anything.
   */
  function applyStationUpdate(station, saved) {
    if (!saved) return;
    Object.keys(saved).forEach(function (key) {
      station[key] = saved[key];
    });
  }

  /**
   * Builds the shared <datalist> behind the editor's fuel-type inputs once,
   * from the config's catalogue plus whatever this station already sells -
   * the stored set is wider than the catalogue (petrol brands name their own
   * grades), and an option the manager can pick is a typo they do not type.
   */
  function ensureFuelTypeDatalist() {
    var list = document.getElementById('pop-fuel-types');
    if (list) return list;

    var seen = {};
    var options = [];
    (state.fuelTypes || []).concat(
      state.stations.reduce(function (all, s) {
        return all.concat((s.prices || []).map(function (p) { return p.fuelType; }));
      }, []),
    ).forEach(function (type) {
      var key = String(type).toLowerCase();
      if (!type || seen[key]) return;
      seen[key] = true;
      options.push(type);
    });

    list = document.createElement('datalist');
    list.id = 'pop-fuel-types';
    list.innerHTML = options
      .map(function (type) { return '<option value="' + escapeHtml(type) + '">'; })
      .join('');
    document.body.appendChild(list);
    return list;
  }

  /* ------------------------------------------------------------------ markers */

  /** Phones get the card as a bottom sheet; wider screens keep it on the pin. */
  function isNarrowViewport() {
    return typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 640px)').matches
      : window.innerWidth <= 640;
  }

  /** Builds the Leaflet divIcon for a station: the brand logo on a white pin. */
  function fallbackIcon(station, selected) {
    var pin = MapIcons.brandPin(station.brand, {
      approximate: station.locationConfidence === 'approximate',
      selected: selected,
    });
    return L.divIcon({
      // The is-selected hook lets the stylesheet lift the clicked pin above its
      // neighbours, which the darker stroke inside the SVG alone does not do.
      className: 'station-pin' + (selected ? ' is-selected' : ''),
      html: pin.markup,
      iconSize: [pin.width, pin.height],
      iconAnchor: pin.anchor,
      popupAnchor: [0, -pin.height],
    });
  }

  /**
   * Plots every station that has coordinates, each on its brand's logo pin.
   *
   * The two providers need different plumbing for the same artwork: Leaflet
   * takes a divIcon straight away, whereas a Google marker is a URL, so the pin
   * has to be rasterised from the brand logo first. Markers on Google are
   * therefore created detached and only attached once their icon is ready, so
   * the map never flashes a half-built pin underneath the loader on the way in.
   *
   * @returns {Promise<void>} Resolves once every pin is ready.
   */
  function renderStations() {
    if (state.provider === 'fallback') {
      state.stations.forEach(function (station) {
        if (station.latitude == null || station.longitude == null) return;
        var marker = L.marker([station.latitude, station.longitude], {
          icon: fallbackIcon(station, false),
          title: station.name,
          riseOnHover: true,
        });
        marker.on('click', function () {
          setActive(station.id);
          openInfoWindow(station);
        });
        state.fallbackMarkers[station.id] = { marker: marker, ready: true };
      });

      applyBrandFilters();
      return Promise.resolve();
    }

    var ready = state.stations.map(function (station) {
      if (station.latitude == null || station.longitude == null) return Promise.resolve();

      var marker = new state.gmaps.Marker({
        position: { lat: station.latitude, lng: station.longitude },
        title: station.name,
        zIndex: 10,
      });
      var entry = { marker: marker, ready: false };
      state.markers[station.id] = entry;

      marker.addListener('click', function () {
        setActive(station.id);
        openInfoWindow(station);
      });

      return MapIcons.stationIcon(state.gmaps, station.brand, {
        approximate: station.locationConfidence === 'approximate',
      }).then(function (icon) {
        entry.ready = true;
        marker.setIcon(icon);
      }, function () {
        // Rasterising failed: fall back to Google's own pin rather than losing
        // the station off the map entirely.
        entry.ready = true;
      });
    });

    return Promise.all(ready).then(function () { applyBrandFilters(); });
  }

  /** Shows/hides markers and list rows per the legend checkboxes. */
  function applyBrandFilters() {
    var counts = {};
    state.brands.forEach(function (b) { counts[b.slug] = 0; });

    state.stations.forEach(function (station) {
      var entry = state.markers[station.id];
      var fallbackEntry = state.fallbackMarkers[station.id];
      var visible = state.legend ? state.legend.isVisible(station.brand.slug) : true;
      if (visible) {
        counts[station.brand.slug] = (counts[station.brand.slug] || 0) + 1;
        if (state.provider === 'fallback' && fallbackEntry) {
          fallbackEntry.marker.addTo(state.fallbackMap);
        } else if (entry) {
          entry.marker.setMap(entry.ready ? state.map : null);
        }
      } else {
        if (state.provider === 'fallback' && fallbackEntry) {
          state.fallbackMap.removeLayer(fallbackEntry.marker);
        } else if (entry) {
          entry.marker.setMap(null);
        }
      }
      var row = el.listBody.querySelector('[data-id="' + station.id + '"]');
      if (row) row.hidden = !visible;
    });

    if (state.legend) state.legend.setCounts(counts);
    renderList(counts);
  }

  function setActive(id) {
    var previous = state.activeId;
    state.activeId = id;
    el.listBody.querySelectorAll('.station-row').forEach(function (r) {
      r.classList.toggle('active', Number(r.dataset.id) === id);
    });
    // Ring the newly selected pin and drop the ring from the one before it.
    paintMarker(previous, false);
    paintMarker(id, true);
  }

  /** Repaints one station's pin, adding or removing the selection ring. */
  function paintMarker(id, selected) {
    if (state.provider === 'fallback') {
      var fbEntry = state.fallbackMarkers[id];
      if (!fbEntry) return;
      var fbStation = state.stations.find(function (s) { return s.id === id; });
      if (!fbStation) return;
      fbEntry.marker.setIcon(fallbackIcon(fbStation, selected));
      return;
    }

    var entry = state.markers[id];
    if (!entry || !entry.ready) return;
    var station = state.stations.find(function (s) { return s.id === id; });
    if (!station) return;

    MapIcons.stationIcon(state.gmaps, station.brand, {
      approximate: station.locationConfidence === 'approximate',
      selected: selected,
    }).then(function (icon) {
      entry.marker.setIcon(icon);
    }, function () { /* keep the previous icon */ });
  }

  /* --------------------------------------------------------------- list panel */

  function renderList(counts) {
    // The list body is rebuilt wholesale below, and replacing its contents
    // resets the scroller to the top. Every brand filter runs this, so without
    // preserving the offset the panel jumps to the top on each tick.
    var keepScroll = el.listBody.scrollTop;
    var visibleStations = state.stations.filter(function (s) {
      return !counts || (counts[s.brand.slug] || 0) > 0;
    });

    var shown = 0;
    var html = state.stations
      .map(function (s) {
        var hidden = counts && !(counts[s.brand.slug] > 0);
        if (!hidden) shown++;
        var priceText = s.prices && s.prices.length
          ? s.prices
              .map(function (p) { return escapeHtml(p.fuelType) + ' ' + peso(p.pricePerLiter); })
              .join(' · ')
          : 'No price data yet';
        return (
          '<button type="button" class="station-row' + (state.activeId === s.id ? ' active' : '') +
          '" data-id="' + s.id + '"' + (hidden ? ' hidden' : '') + '>' +
          MapIcons.brandLogo(s.brand, { lazy: true }) +
          '<span><span class="st-name">' + escapeHtml(s.name) + '</span>' +
          '<span class="st-addr">' + escapeHtml(s.address || s.barangay || 'Address not published') + '</span>' +
          (s.locationConfidence === 'approximate' ? '<span class="st-badge">Approximate</span>' : '') +
          '<span class="st-price">' + priceText + '</span></span></button>'
        );
      })
      .join('');

    /*
     * The two empty states are mutually exclusive, and only one of them may own
     * the body. This used to assign the rows, bind a click handler to every one
     * of them, and then - whenever nothing was visible - overwrite the whole body
     * again with a notice, silently discarding those listeners. On a fresh
     * install with no published stations, visibleStations is empty too, so the
     * "All brands are hidden" text replaced "No stations to show." and pointed
     * the visitor at a legend that could never produce a station.
     */
    if (visibleStations.length === 0) {
      el.listBody.innerHTML = state.stations.length === 0
        ? '<p class="empty-note">No stations to show.</p>'
        : '<p class="empty-note">All brands are hidden.<br>Use the legend to show them again.</p>';
      el.listCount.textContent = '0 / ' + state.stations.length;
    } else {
      el.listBody.innerHTML = html;
      el.listCount.textContent = shown + ' / ' + state.stations.length;

      el.listBody.querySelectorAll('.station-row').forEach(function (row) {
        row.addEventListener('click', function () {
          focusStation(Number(row.dataset.id));
        });
      });
    }

    // Clamped: a filter that shortens the list leaves less to scroll, and the
    // "all hidden" message has none at all, in which case this settles at 0.
    el.listBody.scrollTop = Math.min(
      keepScroll,
      Math.max(0, el.listBody.scrollHeight - el.listBody.clientHeight),
    );
  }

  function focusStation(id) {
    if (state.provider === 'fallback') {
      var fstation = state.stations.find(function (s) { return s.id === id; });
      var fentry = state.fallbackMarkers[id];
      if (!fstation || !fentry) return;
      if (state.legend) state.legend.showBrand(fstation.brand.slug);
      setActive(id);
      state.fallbackMap.setView([fstation.latitude, fstation.longitude], Math.max(state.fallbackMap.getZoom(), 17));
      openInfoWindow(fstation);
      var frow = el.listBody.querySelector('[data-id="' + id + '"]');
      if (frow && frow.scrollIntoView) frow.scrollIntoView({ block: 'nearest' });
      return;
    }

    var entry = state.markers[id];
    if (!entry) return;
    // A station reached from the search results may have had its brand unticked
    // since the list was drawn, in which case its marker is not on the map.
    // Revealing the brand first stops the pan landing on empty map with no
    // popup to anchor to.
    var station = state.stations.find(function (s) { return s.id === id; });
    if (station && state.legend) state.legend.showBrand(station.brand.slug);
    setActive(id);

    state.map.panTo(entry.marker.getPosition());
    state.map.setZoom(Math.max(state.map.getZoom(), 17));
    openInfoWindow(station);

    var row = el.listBody.querySelector('[data-id="' + id + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------- search */

  function initSearch() {
    function close() {
      el.searchResults.classList.remove('open');
      el.search.setAttribute('aria-expanded', 'false');
    }

    function run() {
      var q = el.search.value.trim().toLowerCase();
      el.searchWrap.classList.toggle('has-value', el.search.value.length > 0);
      if (q.length < 1) return close();

      var matches = state.stations.filter(function (s) {
        return (
          s.name.toLowerCase().indexOf(q) !== -1 ||
          s.brand.name.toLowerCase().indexOf(q) !== -1 ||
          (s.address || '').toLowerCase().indexOf(q) !== -1 ||
          (s.barangay || '').toLowerCase().indexOf(q) !== -1
        );
      });

      if (!matches.length) {
        el.searchResults.innerHTML =
          '<p class="empty-note">No station matches &ldquo;' + escapeHtml(el.search.value.trim()) + '&rdquo;.</p>';
      } else {
        el.searchResults.innerHTML = matches
          .map(function (s) {
            return (
              '<button type="button" role="option" data-id="' + s.id + '">' +
              '<span class="sr-dot" style="background:' + escapeHtml(s.brand.colorPrimary) + '"></span>' +
              '<span><span class="sr-name">' + escapeHtml(s.name) + '</span>' +
              '<span class="sr-sub">' + escapeHtml(s.brand.name) +
              (s.address ? ' · ' + escapeHtml(s.address) : '') + '</span></span></button>'
            );
          })
          .join('');
        el.searchResults.querySelectorAll('button').forEach(function (b) {
          b.addEventListener('click', function () {
            focusStation(Number(b.dataset.id));
            el.search.value = '';
            el.searchWrap.classList.remove('has-value');
            close();
          });
        });
      }
      el.searchResults.classList.add('open');
      el.search.setAttribute('aria-expanded', 'true');
    }

    el.search.addEventListener('input', run);
    el.search.addEventListener('focus', function () { if (el.search.value.trim()) run(); });
    el.searchClear.addEventListener('click', function () {
      el.search.value = '';
      el.searchWrap.classList.remove('has-value');
      close();
      el.search.focus();
    });
    document.addEventListener('click', function (e) {
      if (!el.searchWrap.contains(e.target)) close();
    });
    el.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        var first = el.searchResults.querySelector('button');
        if (first) first.click();
      }
    });
  }

  /* -------------------------------------------------------------- list panel */

  /** Slides the station list in or out and keeps the toggle in sync. */
  function setListOpen(open) {
    el.listPanel.classList.toggle('open', open);
    el.toggleList.setAttribute('aria-expanded', String(open));
  }

  /* ------------------------------------------------------------- base layers */

  /**
   * The click handlers currently bound to the base-layer pills, so a second
   * initLayerSwitch() replaces them instead of stacking another one on each.
   *
   * The Google-to-OSM switch calls this a second time, and it can do so from the
   * auth-failure observer while boot() is still awaiting renderStations() - so
   * both registrations landed on the same buttons and every pill click ran
   * setMode twice.
   */
  var layerHandlers = [];

  function initLayerSwitch() {
    layerHandlers.forEach(function (entry) {
      entry.btn.removeEventListener('click', entry.fn);
    });
    layerHandlers = [];

    function setMode(mode) {
      var picked = MAP_TYPES.filter(function (m) { return m.mode === mode; })[0] || MAP_TYPES[0];

      // A base map that only the free map carries - CyclOSM is an OSM tile
      // server, and Google has no map type for it. Rather than refuse the click
      // or silently ignore it, hand the map over to the Leaflet fallback: the
      // tiles the visitor asked for are what ends up on screen.
      if (state.provider !== 'fallback' && !picked.mapTypeId) {
        switchToFallbackMap(picked.mode);
        toast(
          picked.label + ' is an OpenStreetMap tile server, so the free map is shown instead of Google Maps.',
          9000,
        );
        return;
      }

      MAP_TYPES.forEach(function (m) {
        var btn = el.layerButtons[m.mode];
        if (btn) btn.setAttribute('aria-pressed', String(m === picked));
      });

      if (state.provider === 'fallback') {
        var base = state.fallbackBases[picked.mode] || state.fallbackBases.street;
        if (state.activeBase && state.activeBase !== base) {
          state.fallbackMap.removeLayer(state.activeBase);
        }
        if (!state.fallbackMap.hasLayer(base)) base.addTo(state.fallbackMap);
        state.activeBase = base;
      } else {
        state.map.setMapTypeId(picked.mapTypeId);
      }
      writeLayer(picked.mode);
    }

    MAP_TYPES.forEach(function (m) {
      var btn = el.layerButtons[m.mode];
      if (!btn) return;

      var fn = function () { setMode(m.mode); };
      layerHandlers.push({ btn: btn, fn: fn });
      btn.addEventListener('click', fn);
    });

    return setMode;
  }

  /**
   * Replaces the Google map with the free OpenStreetMap one, for the two things
   * that need it: Google refusing to authenticate after the map was built, and a
   * base map that only exists as an OSM tile layer.
   *
   * Only usable once boot() has built the legend, the search box and the list,
   * since all three are reused as they are. Everything Google owned is dropped
   * before Leaflet is handed the same container: its map still holds the node it
   * was constructed with, and an emptied node it keeps painting over is exactly
   * what the auth-failure detector fires on in the first place.
   *
   * One-way by design. The pills stay live and swap OSM tile layers among
   * themselves, but nothing here goes back to Google, so the two providers never
   * have to coexist over one container.
   *
   * @param {string} [mode] Base map to show, or the saved choice when omitted.
   */
  function switchToFallbackMap(mode) {
    if (state.provider === 'fallback') return;

    state.provider = 'fallback';
    state.gmaps = null;
    state.map = null;
    state.infoWindow = null;
    state.boundary = null;
    state.bounds = null;
    state.markers = {};
    state.fallbackMarkers = {};

    if (mapWatch) {
      mapWatch.disconnect();
      mapWatch = null;
    }

    el.map.innerHTML = '';

    initFallbackMap(state.cfg);
    drawBoundary(state.cfg.boundary);
    renderStations();

    initLayerSwitch()(mode || readLayer());
  }

  /* ----------------------------------------------------- locked to Bangued */

  /**
   * Keeps the view inside Bangued.
   *
   * Google Maps has no maxBounds, so the old mapOptions.restriction is no use
   * here. clampCenter() alone is enough: the centre is pulled back into the
   * boundary's bounding box whenever a drag takes it outside, so the border
   * stays a hard edge.
   *
   * This used to also clamp the zoom, raising it until the whole municipality
   * fitted on screen. That is what stopped the mouse wheel working in either
   * direction. Bangued's box is roughly 29 km north to south, so it does not fit
   * at the default zoom: the clamp ran on every bounds_changed, walked the map
   * from zoom 15 down to minZoom 13 on load, and then undid every scroll to zoom
   * in - while zooming out had nowhere left to go. clampZoom and its
   * viewportCoversBounds helper were removed so the wheel is free; the
   * minZoom/maxZoom in the map options still bound the range, and clampCenter
   * still stops the view being dragged off the municipality.
   */
  function restrictToBangued() {
    if (state.provider === 'fallback') {
      state.fallbackMap.setMaxBounds(state.fallbackBounds);
      return;
    }

    var bounds = state.bounds;

    function clampCenter() {
      var center = state.map.getCenter();
      if (!center) return;
      var sw = bounds.getSouthWest();
      var ne = bounds.getNorthEast();
      var lat = Math.min(Math.max(center.lat(), sw.lat()), ne.lat());
      var lng = Math.min(Math.max(center.lng(), sw.lng()), ne.lng());
      if (lat !== center.lat() || lng !== center.lng()) {
        state.map.setCenter({ lat: lat, lng: lng });
      }
    }

    state.map.addListener('bounds_changed', clampCenter);
  }

  /**
   * Free replacement used when the Google browser key cannot authenticate.
   * It is intentionally self-contained: OSM basemap, Bangued boundary,
   * station pins and the same list/search/legend interactions.
   */
  function initFallbackMap(cfg) {
    state.provider = 'fallback';
    state.fallbackMap = L.map(el.map, {
      center: [cfg.center[0], cfg.center[1]],
      zoom: cfg.defaultZoom,
      minZoom: cfg.minZoom,
      maxZoom: cfg.maxZoom,
      maxBoundsViscosity: 1.0,
      attributionControl: true,
    });

    /*
     * Raising the bottom control row clear of the station card is done with a
     * body class rather than per-element maths, and it has to come back off
     * however the card closes - the close button, a tap of the map, or Escape.
     * 'popupclose' is the one event that covers all three.
     */
    state.fallbackMap.on('popupclose', function () {
      document.body.classList.remove('sheet-open');
    });

    var osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: cfg.maxZoom,
      attribution: '&copy; OpenStreetMap contributors',
    });
    var satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: cfg.maxZoom,
      attribution: 'Tiles &copy; Esri',
    });
    var labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
      maxZoom: cfg.maxZoom,
      pane: 'markerPane',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    });
    /*
     * CyclOSM: OpenStreetMap's cycling-focused render, on its own tile server.
     * Only on this map - it is a raster tile service with no google.maps.MapTypeId
     * to point setMapTypeId() at, which is why choosing it switches providers.
     */
    var cyclosm = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: Math.min(cfg.maxZoom, 20),
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, CyclOSM',
    });

    state.fallbackBases = {
      street: osm,
      satellite: satellite,
      hybrid: L.layerGroup([satellite, labels]),
      cyclosm: cyclosm,
    };
    state.activeBase = osm;
    osm.addTo(state.fallbackMap);

    state.fallbackBounds = L.latLngBounds([
      [cfg.maxBounds[0][0], cfg.maxBounds[0][1]],
      [cfg.maxBounds[1][0], cfg.maxBounds[1][1]],
    ]);
    restrictToBangued();
  }

  /* --------------------------------------------------------------------- boot */

  /**
   * Shows the signed-in account and a Sign out button in the header, or keeps
   * the whole control hidden for a visitor. The map is otherwise a logged-out
   * page, so a station_manager working here needs to see which account they
   * are working as and needs a way out - /login would only bounce them
   * straight back to this page (see routes/web.php and login.js).
   */
  function renderHeaderAuth() {
    if (!el.headerAuth) return;
    if (!state.me) {
      el.headerAuth.hidden = true;
      return;
    }
    el.headerUser.textContent = state.me.username;
    el.headerAuth.hidden = false;
  }

  async function boot() {
    el = {
      map: document.getElementById('map'),
      loader: document.getElementById('loader'),
      loaderText: document.getElementById('loader-text'),
      toast: document.getElementById('toast'),
      search: document.getElementById('search'),
      searchWrap: document.getElementById('search-wrap'),
      searchClear: document.getElementById('search-clear'),
      searchResults: document.getElementById('search-results'),
      layerButtons: {
        street: document.getElementById('layer-street'),
        satellite: document.getElementById('layer-satellite'),
        hybrid: document.getElementById('layer-hybrid'),
        cyclosm: document.getElementById('layer-cyclosm'),
      },
      toggleList: document.getElementById('toggle-list'),
      listPanel: document.getElementById('list-panel'),
      listCtl: document.querySelector('.list-ctl'),
      listBody: document.getElementById('list-body'),
      listCount: document.getElementById('list-count'),
      legend: document.getElementById('legend'),
      // Signed-in chip in the header; hidden until /api/me says somebody is.
      headerAuth: document.getElementById('header-auth'),
      headerUser: document.getElementById('header-user'),
      signOut: document.getElementById('sign-out'),
    };

    let meta, brands, stations, me;
    try {
      el.loaderText.textContent = 'Loading map data…';
      var results = await Promise.all([
        Api.meta(),
        Api.brands(),
        Api.stations(),
        /*
         * Session probe alongside the public reads so the header can say who is
         * signed in before the first popup is built. It gets its own catch: a
         * visitor's 401 (or a failed probe of any kind) resolves to null, not
         * into the catch below - a signed-out reader must never be treated as
         * a broken map.
         */
        Api.whoami().catch(function () { return null; }),
      ]);
      meta = results[0];
      brands = results[1] && results[1].data;
      stations = results[2] && results[2].data;
      // Flat by design (see routes/api.php): { id, username, role, station_id }.
      me = results[3] || null;
    } catch (err) {
      failLoader('Could not load station data', 'Check that the server is running. ' + err.message);
      return;
    }

    /*
     * api.js resolves with null - it does not throw - for any 2xx whose body is
     * not JSON, which is what a proxy error page or an SPA fallback rule
     * answering index.html for /api/* looks like. Dereferencing that below threw
     * a TypeError *outside* the try above, so nothing caught it, boot()'s
     * rejection went unhandled and the loader sat over the page for good.
     */
    if (!meta || !meta.map || !Array.isArray(brands) || !Array.isArray(stations)) {
      failLoader('Could not load station data', 'The server returned an unexpected response.');
      return;
    }

    var cfg = meta.map;
    state.cfg = cfg;
    state.brands = brands;
    state.stations = stations;
    state.fuelTypes = (meta && meta.fuelTypes) || [];
    state.me = me;
    renderHeaderAuth();

    if (el.signOut) {
      el.signOut.addEventListener('click', async function () {
        try { await Api.logout(); } catch (err) { /* already gone is fine */ }
        state.me = null;
        renderHeaderAuth();
        // Any open popup may be showing the editor the session just gave up.
        if (state.provider === 'fallback') {
          if (state.fallbackMap) state.fallbackMap.closePopup();
        } else if (state.infoWindow) {
          state.infoWindow.close();
        }
        toast('Signed out.');
      });
    }

    try {
      el.loaderText.textContent = 'Loading Google Maps…';
      state.gmaps = await GMaps.load(cfg.google.apiKey, {
        language: cfg.google.language,
        onAuthFailure: function () { console.warn('Google Maps auth failed, falling back to OpenStreetMap if available.'); },
      });
    } catch (err) {
      console.error(err);
      if (window.L && state.provider !== 'fallback') {
        state.provider = 'fallback';
        state.gmaps = null;
        initFallbackMap(cfg);
        drawBoundary(cfg.boundary);
        state.legend = new Legend(el.legend, {
          onToggle: function () { applyBrandFilters(); },
        }).start(brands);
        await renderStations();
        var fallbackSetMode = initLayerSwitch();
        fallbackSetMode(readLayer());
        initSearch();
        setListOpen(false);
        el.toggleList.addEventListener('click', function () {
          setListOpen(!el.listPanel.classList.contains('open'));
        });
        document.addEventListener('click', function (e) {
          if (!el.listPanel.classList.contains('open')) return;
          if (el.listCtl.contains(e.target)) return;
          setListOpen(false);
        });
        el.listCtl.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') setListOpen(false);
        });
        hideLoader();
        toast('Google Maps is unavailable, so the free OpenStreetMap fallback is shown.', 10000);
        return;
      }

      if (err && err.authFailed) {
        hideLoader();
        if (state.provider === 'fallback') {
          toast('Google Maps rejected the key, so the free OpenStreetMap fallback is shown.', 10000);
        }
        return;
      }
      failLoader('Could not load Google Maps', err.message);
      return;
    }

    var gmaps = state.gmaps;

    // Bangued's limits, as the two diagonal corners the API hands back.
    var corners = cfg.maxBounds;
    state.bounds = new gmaps.LatLngBounds(
      new gmaps.LatLng(corners[0][0], corners[0][1]),
      new gmaps.LatLng(corners[1][0], corners[1][1]),
    );

    state.map = new gmaps.Map(el.map, {
      center: { lat: cfg.center[0], lng: cfg.center[1] },
      zoom: cfg.defaultZoom,
      minZoom: cfg.minZoom,
      maxZoom: cfg.maxZoom,
      zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
      // The pill at the bottom left replaces Google's own map-type control.
      mapTypeControl: false,
      fullscreenControl: false,
      // Street View pegman stays: it is how you check a roadside position.
      streetViewControl: true,
      clickableIcons: false,
      // Wheel zooms, drag pans, no modifier needed - the map is the page, so
      // there is nothing outside it for a cooperative gesture to protect.
      // 'cooperative' would demand Ctrl + scroll and show Google's prompt.
      gestureHandling: 'greedy',
      backgroundColor: '#dfe5ec',
    });

    state.infoWindow = new gmaps.InfoWindow({
      maxWidth: 300,
      pixelOffset: new gmaps.Size(0, -2),
      // Closes on Escape and on a click elsewhere, as Google intends.
      disableAutoPan: false,
    });

    // Armed before anything else touches the map, so the failure is caught
    // however early Google decides to render its overlay.
    watchForMapAuthFailure();

    restrictToBangued();
    drawBoundary(cfg.boundary);

    state.legend = new Legend(el.legend, {
      onToggle: function () { applyBrandFilters(); },
    }).start(brands);

    await renderStations();

    var setMode = initLayerSwitch();
    // Always run setMode, not just for satellite: it is what puts the saved
    // choice on the map and keeps the pill's pressed state honest.
    setMode(readLayer());

    initSearch();

    // The list panel starts closed so the map is fully visible on arrival;
    // the floating toggle slides it in and out. State lives in the "open"
    // class because the hidden attribute (display:none) cannot be transitioned.
    setListOpen(false);
    el.toggleList.addEventListener('click', function () {
      setListOpen(!el.listPanel.classList.contains('open'));
    });
    // Standard dropdown dismissal: a click anywhere outside the wrapper closes
    // the panel. Checked on the wrapper (not the panel) so the toggle click
    // still reaches its own handler and flips the state as intended.
    document.addEventListener('click', function (e) {
      if (!el.listPanel.classList.contains('open')) return;
      if (el.listCtl.contains(e.target)) return;
      setListOpen(false);
    });
    el.listCtl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setListOpen(false);
    });

    hideLoader();
  }

  /** Official Bangued municipal boundary, dashed so it is never mistaken for
      a route or a legal parcel line rather than a limit of the view. */
  function drawBoundary(boundary) {
    var ring = boundary && boundary.geometry && boundary.geometry.coordinates[0];
    if (!ring || !ring.length) return;

    if (state.provider === 'fallback') {
      state.fallbackBoundary = L.polygon(
        ring.map(function (p) { return [p[1], p[0]]; }),
        {
          color: '#5b7c99',
          weight: 1.5,
          opacity: 1,
          fillColor: '#5b7c99',
          fillOpacity: 0.03,
        },
      ).addTo(state.fallbackMap);
      return;
    }

    state.boundary = new state.gmaps.Polygon({
      // GeoJSON stores [lng, lat]; Google wants {lat, lng}.
      paths: ring.map(function (p) { return { lat: p[1], lng: p[0] }; }),
      strokeColor: '#5b7c99',
      strokeOpacity: 1,
      strokeWeight: 1.5,
      fillColor: '#5b7c99',
      fillOpacity: 0.03,
      // Not clickable: Google has no hover tooltip for a polygon, so the
      // boundary is described in the legend note instead of on the shape.
      clickable: false,
      zIndex: 1,
      map: state.map,
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
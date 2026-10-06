/* Refuelio Admin dashboard for Bangued's Gas Station Hub, with dynamic brand
   logo markers. */
/* global MapIcons, L */

(function (global) {
  'use strict';

  var state = {
    stations: [],
    brands: [],
    cfg: null,
    editingId: null,
    picker: null,
    pickerMarker: null,
    initAttempted: false,
    dashboardStarted: false,
    pickerPromise: null,
    pickerTarget: null,
    isAuthenticated: false,
    // True only for an admin. A station manager reaches the dashboard too - they
    // maintain fuel prices - but the station CRUD half of the API is admin-only,
    // so the controls that call it are removed rather than left to fail with a
    // 403. Mirrors what RequireStaff/RequireAdmin allow server-side.
    isAdmin: false,
    authError: null,
    // Stations table view state. Kept in `state` rather than read back from the
    // controls at render time so a re-render triggered by a data change (an edit
    // or a delete) cannot silently drop a filter the user had set.
    tableQuery: '',
    tableStatus: '',
  };

  /**
   * Initialize the admin dashboard.
   */
  function init() {
    // Prevent multiple initialization attempts
    if (state.initAttempted) return;
    state.initAttempted = true;

    // Session is checked up front. Every /api/admin endpoint answers 401
    // without one, so probing first turns a dead dashboard into a bounce to
    // the sign-in page instead of an empty table plus a toast. It also yields
    // the display name for the header.
    Api.me()
      .then(function (resp) {
        var user = resp && resp.data;
        if (!user || !isStaffRole(user.role)) {
          redirectToLogin();
          return null;
        }
        state.isAuthenticated = true;
        state.isAdmin = user.role === 'admin';
        renderSignedInAs(user);
        applyRoleGates();
        return bootWithConfig();
      })
      .catch(function (err) {
        if (err && err.status === 401) {
          redirectToLogin();
          return;
        }
        console.error('Session check failed:', err);
        showToast('Could not verify your session. Please try again.', true);
      });
  }

  /** The two roles RequireStaff lets in. Mirrors User::ROLES on the server. */
  function isStaffRole(role) {
    return role === 'admin' || role === 'station_manager';
  }

  /**
   * Hand control back to the sign-in page. `replace` so the dashboard does not
   * sit in the back-button history of a page the visitor cannot use.
   */
  function redirectToLogin() {
    global.location.replace('/login');
  }

  /** Fills the "Signed in as" slot in the header. */
  function renderSignedInAs(user) {
    var el = document.getElementById('who-name');
    if (el) {
      el.textContent = user.displayName || user.username || '—';
    }
    var roleEl = document.getElementById('who-role');
    if (roleEl) {
      roleEl.textContent = user.role === 'admin' ? 'Admin' : 'Station manager';
    }
  }

  /**
   * Removes the station CRUD controls for a station manager, who may maintain
   * prices but not create, rename, move or delete stations.
   *
   * The server already refuses those calls with a 403; hiding them means the
   * dashboard never shows a button that is guaranteed to fail. Runs before
   * bootWithConfig() so the markup is already in place. `hidden` rather than
   * display:none alone, so a later render pass cannot reveal them again, and
   * `aria-hidden` to match for assistive tech.
   */
  function applyRoleGates() {
    if (state.isAdmin) return;

    var gated = document.querySelectorAll('[data-requires-admin]');
    for (var i = 0; i < gated.length; i++) {
      gated[i].hidden = true;
      gated[i].setAttribute('aria-hidden', 'true');
    }
  }

  /**
* Loads the dashboard config. Deliberately does NOT load a map library.
    *
    * The coordinate picker is OpenStreetMap via Leaflet, which ships with the
    * page and needs no API key. It is still built on demand rather than with the
    * page: Leaflet fetches map tiles the moment it is created, and most visits
    * to /admin only read the table and never open a station form. The picker is
    * built by ensurePicker() when a form is actually opened.
    *
    * @returns {Promise<void>}
    */
  function bootWithConfig() {
    // Api.adminConfig, not Api.config: api.js only ever exposed the admin
    // variant, so the old call threw "Api.config is not a function" before any
    // data was loaded and the picker was never built.
    return Api.adminConfig()
      .then(function (configResp) {
        state.cfg = extractApiData(configResp) || {};
      })
      .catch(function (err) {
        console.error('Failed to load dashboard config:', err);
        showToast('Could not load dashboard settings. Some options may be missing.', true);
      })
      .then(function () {
        startDashboard();
      });
  }

  /**
   * Builds the OpenStreetMap coordinate picker, once.
   *
   * Called when a station form opens. Safe to call repeatedly: the promise is
   * cached, so opening ten station forms still builds one map.
   *
   * @returns {Promise<void>}
   */
  function ensurePicker() {
    if (state.pickerPromise) return state.pickerPromise;

    state.pickerPromise = new Promise(function (resolve) {
      // Only reachable if leaflet.js failed to load. The lat/lng fields are
      // independent of the map, so the station is still editable.
      if (!global.L) {
        showPickerUnavailable();
        showToast('Could not load the map - type coordinates by hand instead.', true);
        resolve();
        return;
      }

      initOsmPicker();
      resolve();
    });

    return state.pickerPromise;
  }

  /**
   * Fetches the first payload and wires the UI. Guarded, because the config
   * promise chain above has two completion paths (maps loaded / maps failed)
   * and running it twice would bind every click handler a second time -
   * saving a station would then fire two requests.
   */
  function startDashboard() {
    if (state.dashboardStarted) return;
    state.dashboardStarted = true;
    loadData();
    bindEvents();
  }

  /**
   * Check if an API response indicates an error.
   * @param {Object} response - The API response object
   * @returns {boolean} True if it's an error response
   */
  function isApiErrorResponse(response) {
    return response &&
           typeof response === 'object' &&
           response.error !== undefined &&
           response.error !== null &&
           (typeof response.error === 'string' ||
            (typeof response.error === 'object' && response.error.message !== undefined));
  }

  /**
   * Replaces the coordinate picker with a notice, for when Leaflet itself could
   * not be loaded. The station form still works - coordinates are typed into the
   * latitude/longitude fields by hand.
   */
  function showPickerUnavailable() {
    var pickerContainer = document.getElementById('picker');
    if (pickerContainer) {
      // The two classes are the ones admin.css already styles for this state
      // (.picker-map.picker-error). The bare "map-placeholder" it used before is
      // not defined in admin.css, so the notice rendered as unstyled text
      // jammed into the corner of the grey box.
      pickerContainer.innerHTML =
        '<div class="picker-map picker-error">Map unavailable - the map library did not load. '
        + 'Type the coordinates below instead.</div>';
    }
  }

  /**
   * Loads brands and the full station list (pending and inactive included).
   *
   * Called on boot and by the Refresh button, so it must be safe to run more
   * than once: the config is only fetched once by bootWithConfig, because
   * nothing here changes it.
   */
  function loadData() {
    // Show loading state immediately
    var rowsEl = document.getElementById('rows');
    if (rowsEl) {
      rowsEl.innerHTML = '<tr><td colspan="5" class="loading-row">Loading stations…</td></tr>';
    }

    Promise.all([
      safeApiCall(Api.brands(), 'brands'),
      safeApiCall(Api.adminStations(), 'stations'),
    ]).then(function ([brandsResp, stationsResp]) {
      // A 401 here means the session expired between the boot check and this
      // request, so there is nothing left to show - go back to sign-in.
      var authFailure = firstAuthFailure(brandsResp, stationsResp);
      if (authFailure) {
        state.authError = authFailure;
        redirectToLogin();
        return;
      }

      /*
       * safeApiCall() turns every failure into a resolved { error } object, so
       * Promise.all never rejects and the .catch below is unreachable for API
       * failures. That left a 500, a dropped connection or an HTML body being
       * read as "zero stations": the table rendered "No stations found." with
       * all counters at 0 and the brand select collapsed to a bare placeholder,
       * which an admin can reasonably read as an emptied database. Rethrowing
       * here is what hands the failure to that handler.
       */
      var failure = firstFailure(brandsResp, stationsResp);
      if (failure) {
        throw new Error(failure.message || 'Request failed');
      }

      state.brands = extractApiData(brandsResp) || [];
      state.stations = extractApiData(stationsResp) || [];

      // Populate brand dropdown
      populateBrandDropdown();

      // Render stations table
      renderStations();

      // Update stats
      updateStats();

      // Populate fuel type datalist from config
      populateFuelTypeDatalist();
    }).catch(function (err) {
      console.error('Failed to load data:', err);
      showToast('Failed to load dashboard data. Please try refreshing the page.', true);

      // Show error state in table
      var rowsEl = document.getElementById('rows');
      if (rowsEl) {
        rowsEl.innerHTML = '<tr><td colspan="5" class="error-row">Error loading data. Please refresh the page.</td></tr>';
      }
    });
  }

  /**
   * The first 401 among the responses, or null. safeApiCall() converts rejects
   * into a plain { error } object, so the status has to be carried along or a
   * lost session is indistinguishable from any other failure.
   *
   * @param {...Object} responses
   * @returns {Object|null}
   */
  function firstAuthFailure() {
    for (var i = 0; i < arguments.length; i++) {
      var error = arguments[i] && arguments[i].error;
      if (error && error.status === 401) {
        return error;
      }
    }

    return null;
  }

  /**
   * The first failure of any status among the responses, or null.
   *
   * firstAuthFailure() narrows the same question to 401s. This one is what
   * loadData() uses to notice a 500, a network blip or a body that was not the
   * JSON it expected.
   *
   * @param {...Object} responses
   * @returns {Object|null}
   */
  function firstFailure() {
    for (var i = 0; i < arguments.length; i++) {
      var error = arguments[i] && arguments[i].error;
      if (error) {
        return typeof error === 'string' ? { message: error } : error;
      }
    }

    return null;
  }

  /**
   * Wrap an API call to ensure it always settles (resolves or rejects).
   * @param {Promise} promise - The API call promise
   * @param {string} type - Type of request for error messaging
   * @returns {Promise} A promise that always settles
   */
  function safeApiCall(promise, type) {
    return promise.then(function (response) {
      // Check if this is an error response
      if (isApiErrorResponse(response)) {
        console.warn('API error (' + type + '):', response.error);
        // Return a structure that indicates error but lets us continue
        return { error: response.error, data: null };
      }
      return response;
    }).catch(function (error) {
      console.error('API call failed (' + type + '):', error);
      // status is copied over so firstAuthFailure() can still tell a lost
      // session (401) apart from a network blip or a 500.
      return { error: { message: error.message || 'Request failed', status: error.status }, data: null };
    });
  }

  /**
   * Extract data from an API response, handling both success and error cases.
   * @param {Object} response - The API response
   * @returns {*} The data portion or null if error
   */
  function extractApiData(response) {
    if (!response) return null;

    if (isApiErrorResponse(response)) {
      return null; // Indicate error
    }

    // Handle different response formats
    if (response.data !== undefined) {
      return response.data;
    }

    // If no explicit data field, assume the whole response is the data
    return response;
  }

  /**
   * Populate brand dropdown in the station form.
   */
  function populateBrandDropdown() {
    var brandSelect = document.getElementById('f-brand');
    if (!brandSelect) return;

    try {
      brandSelect.innerHTML = '<option value="">Select brand</option>';

      // Sort brands by sort_order then name
      var sortedBrands = state.brands.slice().sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0) ||
               String(a.name || '').localeCompare(String(b.name || ''));
      });

      sortedBrands.forEach(function (brand) {
        if (!brand || !brand.slug) return;
        var option = document.createElement('option');
        option.value = brand.slug;
        option.textContent = brand.name || brand.slug;
        brandSelect.appendChild(option);
      });
    } catch (e) {
      console.error('Error populating brand dropdown:', e);
      brandSelect.innerHTML = '<option value="">Error loading brands</option>';
    }
  }

  /**
   * Populate fuel type datalist from config.
   */
  function populateFuelTypeDatalist() {
    // fuelTypes, not fuel_types: /api/admin/config answers camelCase, like the
    // rest of the API. Reading the snake_case name left the datalist empty, so
    // every fuel-type input had no autocomplete at all.
    var fuelTypesEl = document.getElementById('fuel-types');
    if (!fuelTypesEl || !state.cfg || !state.cfg.fuelTypes) return;

    try {
      fuelTypesEl.innerHTML = '';
      state.cfg.fuelTypes.forEach(function (type) {
        if (!type) return;
        var option = document.createElement('option');
        option.value = type;
        fuelTypesEl.appendChild(option);
      });
    } catch (e) {
      console.error('Error populating fuel type datalist:', e);
    }
  }

  /**
   * The red station pin as a Leaflet divIcon, for the OpenStreetMap picker.
   */
  function pickerPinIcon() {
    var pin = MapIcons.redPin({});
    return L.divIcon({
      className: 'station-pin',
      html: pin.markup,
      iconSize: [pin.width, pin.height],
      iconAnchor: pin.anchor,
    });
  }

  /**
   * Writes a picked point into the form's latitude/longitude fields. An empty
   * value blanks the field rather than becoming 0.000000, which is what
   * Number('') would have produced.
   */
  function writeCoords(lat, lng) {
    var latInput = document.getElementById('f-lat');
    var lngInput = document.getElementById('f-lng');
    if (latInput) latInput.value = coordinateText(lat);
    if (lngInput) lngInput.value = coordinateText(lng);
  }

  function coordinateText(value) {
    if (value === '' || value === null || value === undefined) return '';
    var n = Number(value);
    return isNaN(n) ? '' : n.toFixed(6);
  }

  /**
   * Tells the picker to re-measure its container.
   *
   * The station modal is hidden until a form opens, so a picker built while it
   * was hidden saw a zero-sized box and drew nothing. openModal() unhides the
   * container, and the map only repaints at the right size once it is told.
   */
  function refreshPickerSize() {
    if (!state.picker) return;
    if (state.picker.invalidateSize) state.picker.invalidateSize();
  }

  /**
   * Moves the picker pin to whatever is in the coordinate fields, and vice
   * versa: typing coordinates by hand and picking them on the map are two ways
   * of doing the same thing, so each one has to update the other. Ignores
   * half-filled or out-of-range input rather than jumping the pin into the sea.
   */
  function syncPickerFromInputs() {
    if (!state.pickerMarker) return;

    var latInput = document.getElementById('f-lat');
    var lngInput = document.getElementById('f-lng');
    if (!latInput || !lngInput) return;

    var lat = parseFloat(latInput.value);
    var lng = parseFloat(lngInput.value);
    if (isNaN(lat) || isNaN(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    state.pickerMarker.setLatLng([lat, lng]);
  }

  /**
   * Coordinate picker backed by OpenStreetMap via Leaflet.
   *
   * No API key, no billing account and no quota, which is the whole reason the
   * picker runs on Leaflet rather than Google Maps.
   */
  function initOsmPicker() {
    var mapDiv = document.getElementById('picker');
    if (!mapDiv || state.picker) return;

    try {
      state.picker = L.map(mapDiv, {
        center: [17.5965, 120.6167],
        zoom: 14,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 21,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(state.picker);

      // The draggable pin carries the icon explicitly. Left to itself Leaflet
      // uses its bundled blue teardrop, which is drawn from an image under
      // public/vendor/leaflet/images/ and renders as a broken image when the
      // admin page is served from a different path.
      state.pickerMarker = L.marker([17.5965, 120.6167], {
        draggable: true,
        icon: pickerPinIcon(),
        keyboard: false,
      }).addTo(state.picker);

      state.pickerMarker.on('dragend', function () {
        var pos = state.pickerMarker.getLatLng();
        writeCoords(pos.lat, pos.lng);
      });

      state.picker.on('click', function (e) {
        writeCoords(e.latlng.lat, e.latlng.lng);
        state.pickerMarker.setLatLng(e.latlng);
      });
    } catch (e) {
      console.error('Error initializing Leaflet picker:', e);
      showPickerUnavailable();
    }
  }

  /**
   * Bind event listeners.
   */
  function bindEvents() {
    try {
      // Add station button. Skipped for a station manager, whose create call is
      // admin-only; the button itself is already hidden by applyRoleGates().
      if (state.isAdmin) {
        var addBtn = document.getElementById('btn-add');
        if (addBtn) {
          addBtn.addEventListener('click', openAddStationModal);
        }
      }

      // Refresh button
      var refreshBtn = document.getElementById('btn-refresh');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', loadData);
      }

      // Stations table search and status filter. Both re-render the existing
      // rows only - no request, so typing stays instant and the data is not
      // refetched on every keystroke.
      var searchInput = document.getElementById('table-search');
      if (searchInput) {
        searchInput.addEventListener('input', function () {
          state.tableQuery = this.value.trim().toLowerCase();
          renderStations();
        });
      }

      var statusFilter = document.getElementById('table-status');
      if (statusFilter) {
        statusFilter.addEventListener('change', function () {
          state.tableStatus = this.value;
          renderStations();
        });
      }

      // Station form submission
      var stationForm = document.getElementById('station-form');
      if (stationForm) {
        stationForm.addEventListener('submit', function (e) {
          e.preventDefault();
          saveStation();
        });
      }

      // Station form real-time validation. validateCoords() reports on bad
      // input; syncPickerFromInputs() moves the pin to whatever was typed, so
      // the map and the two fields cannot end up describing different points.
      var latInput = document.getElementById('f-lat');
      var lngInput = document.getElementById('f-lng');
      if (latInput) latInput.addEventListener('change', function () {
        validateCoords();
        syncPickerFromInputs();
      });
      if (lngInput) lngInput.addEventListener('change', function () {
        validateCoords();
        syncPickerFromInputs();
      });

      // Price modal
      var priceAddBtn = document.getElementById('price-add');
      if (priceAddBtn) {
        // Wrapped, not passed by reference: addPriceRow(fuelType, pricePerLiter)
        // takes pre-fill values, so handing it the click event directly put
        // "[object PointerEvent]" into the new row's fuel-type field.
        priceAddBtn.addEventListener('click', function () {
          addPriceRow();
        });
      }

      var priceForm = document.getElementById('price-form');
      if (priceForm) {
        priceForm.addEventListener('submit', function (e) {
          e.preventDefault();
          savePrices();
        });
      }

      // Password modal
      var passwordForm = document.getElementById('password-form');
      if (passwordForm) {
        passwordForm.addEventListener('submit', function (e) {
          e.preventDefault();
          changePassword();
        });
      }

      // Logout button
      var logoutBtn = document.getElementById('btn-logout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', function () {
          Api.logout().then(function () {
            global.location.replace('/login');
          }).catch(function (err) {
            showToast('Logout failed', true);
            console.error('Logout error:', err);
          });
        });
      }

      // Password change button
      var passwordBtn = document.getElementById('btn-password');
      if (passwordBtn) {
        passwordBtn.addEventListener('click', openPasswordModal);
      }

      // Handle modal close buttons
      document.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', closeModals);
      });

      // Close modals when clicking backdrop
      document.querySelectorAll('.modal-backdrop').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target === el) closeModals();
        });
      });

      // Escape key closes modals
      global.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeModals();
      });
    } catch (e) {
      console.error('Error binding event listeners:', e);
      showToast('Some UI features may not work correctly due to initialization error.', false);
    }
  }

  /**
   * Open add station modal.
   */
  function openAddStationModal() {
    clearErrors();

    // The picker is loaded on demand, so the form has to ask for it. Without
    // this the modal opens over an empty #picker because nothing has built the
    // map yet. Clearing pickerTarget first centres it on Bangued rather than on
    // whatever station happened to be open a moment ago.
    state.pickerTarget = null;
    ensurePicker().then(syncPickerToTarget);

    state.editingId = null;
    document.getElementById('station-modal-title').textContent = 'Add station';
    var form = document.getElementById('station-form');
    if (form) {
      form.reset();
      var brandSelect = form.elements['f-brand'];
      if (brandSelect) brandSelect.selectedIndex = 0; // Reset to placeholder
      var activeCheckbox = form.elements['f-active'];
      if (activeCheckbox) activeCheckbox.checked = true;
      // A new station has no location yet: form.reset() has just emptied the
      // coordinate fields, so the pin has to go back to Bangued town too or it
      // would still point at the station that was open a moment ago.
      writeCoords('', '');
    }

    // Center map on Bangued if the picker is already built. It may not be: the
    // picker is built on demand, and openAddStationModal() asks for it below.
    if (state.picker) {
      state.picker.setView([17.5965, 120.6167], 14);
    }

    openModal('station-modal');
    refreshPickerSize();
  }

  /**
   * Open the price editor modal for a station.
   *
   * PUT .../prices replaces the whole set, so the form has to open holding the
   * station's current prices - an empty form that the admin fills in one row at
   * a time deletes every fuel type they did not re-type.
   *
   * @param {Object} station The station to edit prices for
   */
  function openPriceModal(station) {
    if (!station) return;

    clearErrors();

    state.editingId = station.id;
    document.getElementById('price-modal-title').textContent = 'Fuel prices — ' + station.name;
    document.getElementById('price-sub').textContent =
      'Editing prices for ' + station.name + '. Leave effective date blank for current time.';

    var priceRows = document.getElementById('price-rows');
    if (priceRows) {
      priceRows.innerHTML = '';
    }

    var effectiveInput = document.getElementById('p-effective');
    if (effectiveInput) {
      effectiveInput.value = '';
    }

    var existing = Array.isArray(station.prices) ? station.prices : [];
    if (existing.length === 0) {
      addPriceRow();
    } else {
      existing.forEach(function (line) {
        if (!line) return;
        addPriceRow(line.fuelType || '', line.pricePerLiter);
      });
    }

    loadPriceHistory(station.id);
    openModal('price-modal');
  }

  /**
   * Bumped per request so a slow response cannot paint one station's history
   * into another station's modal. #price-history is a single element reused by
   * every open, so without this an admin who opened station A, closed it, and
   * opened B before A's request returned would read A's price changes under
   * B's heading.
   */
  var priceHistoryToken = 0;

  /**
   * Load and render price change history for a station.
   * @param {number} stationId
   */
  function loadPriceHistory(stationId) {
    var historyEl = document.getElementById('price-history');
    if (!historyEl) return;

    var token = ++priceHistoryToken;
    historyEl.innerHTML = '<p class="empty-note">Loading history…</p>';

    Api.priceHistory(stationId)
      .then(function (response) {
        if (token !== priceHistoryToken) return;

        var rows = response && response.data ? response.data : [];
        if (rows.length === 0) {
          historyEl.innerHTML = '<p class="empty-note">No price changes recorded yet.</p>';
          return;
        }

        var html = '<table class="data"><thead><tr>' +
          '<th>Fuel type</th><th>Previous</th><th>New</th><th>Changed at</th><th>By</th>' +
          '</tr></thead><tbody>';
        rows.forEach(function (row) {
          html += '<tr>' +
            '<td>' + escapeHtml(row.fuel_type) + '</td>' +
            '<td>' + (row.previous_price != null ? '₱' + Number(row.previous_price).toFixed(2) : '—') + '</td>' +
            '<td>₱' + Number(row.new_price).toFixed(2) + '</td>' +
            // changed_at is UTC with no zone marker, so printed raw it read
            // eight hours early for an admin in the Philippines. FmtTime.format
            // applies the UTC-by-convention rule, as the public map already does.
            '<td>' + (FmtTime.format(row.changed_at) || '—') + '</td>' +
            '<td>' + escapeHtml(row.changed_by || '') + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
        historyEl.innerHTML = html;
      })
      .catch(function (err) {
        if (token !== priceHistoryToken) return;

        historyEl.innerHTML = '<p class="empty-note">Failed to load price history.</p>';
        console.error('Failed to load price history:', err);
      });
  }

/**
   * Open edit station modal.
   * @param {Object} station The station to edit, in the API's camelCase shape
   */
  function openEditStationModal(station) {
    if (!station) return;

    clearErrors();

    state.editingId = station.id;
    document.getElementById('station-modal-title').textContent = 'Edit station';
    var form = document.getElementById('station-form');
    if (!form) return;

    // Every field name here matches Station::toApiArray(). The previous
    // snake_case names (location_confidence, is_active, contact_phone, ...)
    // do not exist in the response, so the form opened blank every time and
    // the next save wiped the station.
    form.elements['f-brand'].value = (station.brand && station.brand.slug) || '';
    form.elements['f-name'].value = station.name || '';
    form.elements['f-address'].value = station.address || '';
    form.elements['f-barangay'].value = station.barangay || '';
    form.elements['f-lat'].value = station.latitude !== null && station.latitude !== undefined ? parseFloat(station.latitude).toFixed(6) : '';
    form.elements['f-lng'].value = station.longitude !== null && station.longitude !== undefined ? parseFloat(station.longitude).toFixed(6) : '';
    form.elements['f-conf'].value = station.locationConfidence || 'approximate';
    form.elements['f-active'].checked = station.isActive !== false;
    form.elements['f-phone'].value = station.contactPhone || '';
    form.elements['f-email'].value = station.contactEmail || '';
    form.elements['f-hours'].value = station.operatingHours || '';
    form.elements['f-notes'].value = station.notes || '';
    form.elements['f-osm'].value = station.osmRef || '';

    // Centre the picker on the station. The picker is loaded on demand, so it
    // may not exist yet - ensurePicker() re-runs this once the map arrives,
    // otherwise opening a station would always show Bangued's centre instead of
    // the coordinates being edited.
    state.pickerTarget = station;
    syncPickerToTarget();
    ensurePicker().then(syncPickerToTarget);

    openModal('station-modal');
    refreshPickerSize();
  }

  /**
   * Points the picker at state.pickerTarget - the station whose form is open -
   * or at Bangued town proper when there is nothing to show. A no-op until the
   * picker exists, which is why ensurePicker() calls this again once it loads.
   */
  function syncPickerToTarget() {
    if (!state.picker) return;

    var station = state.pickerTarget;
    var hasCoords = station &&
      station.latitude !== null && station.latitude !== undefined &&
      station.longitude !== null && station.longitude !== undefined;

    var lat = hasCoords ? parseFloat(station.latitude) : 17.5965;
    var lng = hasCoords ? parseFloat(station.longitude) : 120.6167;

    state.picker.setView([lat, lng], hasCoords ? 16 : 14);
    if (state.pickerMarker) {
      state.pickerMarker.setLatLng([lat, lng]);
    }
  }

  /**
   * Save station (add or update).
   */
  function saveStation() {
    var form = document.getElementById('station-form');
    if (!form) return;

    var brandSlug = form.elements['f-brand'].value;
    var stationName = form.elements['f-name'].value.trim();

    // Validate
    if (!brandSlug) {
      showStationError('Please select a brand');
      return;
    }
    if (!stationName) {
      showStationError('Please enter a station name');
      return;
    }

    var lat = form.elements['f-lat'].value.trim();
    var lng = form.elements['f-lng'].value.trim();
    var hasCoords = lat !== '' && lng !== '';

    /*
     * The form is novalidate, so the browser's own type="email" check never runs,
     * and the server only trims and length-limits contactEmail. Left unchecked
     * here, "not-an-email" saved as happily as a real address.
     */
    var email = form.elements['f-email'].value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showStationError('Please enter a valid contact email, or leave it blank');
      return;
    }

    // Validate coordinates if provided
    if (hasCoords) {
      if (!validateCoords()) {
        return;
      }
    }

    /*
     * The body keys are exactly the ones AdminApiController reads. They are
     * camelCase, and the previous snake_case names (brand_id, contact_phone,
     * is_active, ...) were silently dropped by the controller - which meant
     * brandId was always missing and every save came back 400 "Brand is
     * required."
     */
    var data = {
      name: stationName,
      address: form.elements['f-address'].value.trim() || null,
      barangay: form.elements['f-barangay'].value.trim() || null,
      latitude: hasCoords ? parseFloat(lat) : null,
      longitude: hasCoords ? parseFloat(lng) : null,
      contactPhone: form.elements['f-phone'].value.trim() || null,
      contactEmail: email || null,
      operatingHours: form.elements['f-hours'].value.trim() || null,
      notes: form.elements['f-notes'].value.trim() || null,
      isActive: form.elements['f-active'].checked,
      osmRef: form.elements['f-osm'].value.trim() || null,
    };

    // The dropdown carries the brand slug, but the API keys brands by id.
    var brand = state.brands.find(function (b) {
      return b && b.slug === brandSlug;
    });
    if (!brand) {
      showStationError('Please select a brand');
      return;
    }
    data.brandId = brand.id;

    /*
     * locationConfidence is only meaningful alongside coordinates: a station
     * with none is stored as pending regardless of what the select says, so it
     * is left out unless there is a position to describe.
     */
    if (hasCoords) {
      data.locationConfidence = form.elements['f-conf'].value;
    }

    var savePromise;
    if (state.editingId) {
      // Update existing
      savePromise = Api.updateStation(state.editingId, data);
    } else {
      // Create new
      savePromise = Api.createStation(data);
    }

    // Disable form during save to prevent duplicate submissions
    var saveBtn = document.getElementById('station-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    savePromise
      .then(function () {
        closeModals();
        loadData(); // Refresh stations list
        showToast('Station saved successfully');
      })
      .catch(function (err) {
        showStationError(err.message || 'Failed to save station');
        console.error(err);
      })
      .finally(function () {
        // Re-enable form
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save station';
        }
      });
  }

  /**
   * Validate latitude and longitude inputs.
   * @returns {boolean} True if valid
   */
  function validateCoords() {
    var latInput = document.getElementById('f-lat');
    var lngInput = document.getElementById('f-lng');
    var errorEl = document.getElementById('station-error');

    if (!latInput || !lngInput || !errorEl) return false;

    var lat = parseFloat(latInput.value);
    var lng = parseFloat(lngInput.value);

    // Clear previous error
    errorEl.hidden = true;

    // Check if empty (allowed - placeholder station)
    if (latInput.value === '' && lngInput.value === '') {
      return true;
    }

    // Validate latitude
    if (isNaN(lat) || lat < -90 || lat > 90) {
      showStationError('Latitude must be between -90 and 90');
      latInput.focus();
      return false;
    }

    // Validate longitude
    if (isNaN(lng) || lng < -180 || lng > 180) {
      showStationError('Longitude must be between -180 and 180');
      lngInput.focus();
      return false;
    }

    // Check Bangued bounds if coordinates provided
    if (state.cfg && state.cfg.stationBounds) {
      var bounds = state.cfg.stationBounds;
      if (
        lat < bounds.minLat ||
        lat > bounds.maxLat ||
        lng < bounds.minLon ||
        lng > bounds.maxLon
      ) {
        showStationError('Coordinates must be within Bangued, Abra');
        return false;
      }
    }

    return true;
  }

  /**
   * Show error in station form.
   * @param {string} message
   */
  function showStationError(message) {
    var errorEl = document.getElementById('station-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  }

  /**
   * The "Station" cell: brand logo beside the name.
   *
   * The logo is emitted through MapIcons.brandLogo into the .cell-name wrapper,
   * which admin.css already sizes to a fixed 26px square with object-fit:
   * contain. The markup this replaces used a `brand-logo-sm` class that was
   * never defined in admin.css, so each logo rendered at its own intrinsic
   * size - the source files range from caltex.png at 300x300 to shell.png at
   * 5000x4632 - which is what made the column ragged and oversized.
   *
   * Going through brandLogo() also picks up the shared logo-path fallback
   * (/images/brands/<slug>.png) and the capture-phase error handler that swaps
   * a missing file for the brand's coloured chip, so a brand without a logoPath
   * still renders at the same size as the rest.
   *
   * @param {Object} station
   * @returns {string} HTML
   */
  function stationCell(station) {
    var brand = station.brand;
    var logo = brand && brand.slug ? MapIcons.brandLogo(brand) : '';

    // The brand and street address carry the detail that used to be missing here,
    // which left the name alone in a wide column. The address is escaped like the
    // name because it is free text from the API.
    var sub = '';
    if (brand && brand.name) {
      sub += escapeHtml(brand.name);
    }
    var address = (station.address || '').trim();
    if (address) {
      sub += (sub ? '<span class="sep">&middot;</span>' : '') + escapeHtml(address);
    }

    return (
      '<div class="cell-name">' +
      logo +
      '<span class="body">' +
      '<strong>' + escapeHtml(station.name || '') + '</strong>' +
      (sub ? '<span class="sub">' + sub + '</span>' : '') +
      '</span>' +
      '</div>'
    );
  }

  /**
   * Renders the fuel price list, one line per fuel type with the amount aligned
   * to the right so the figures share a decimal point down the column.
   *
   * @param {Array} prices
   * @returns {string} HTML
   */
  function priceCell(prices) {
    if (!Array.isArray(prices) || prices.length === 0) {
      return '<span class="price-empty">&mdash;</span>';
    }

    var lines = prices
      .filter(function (line) { return line && line.fuelType; })
      .map(function (line) {
        return (
          '<span class="line">' +
          '<span class="fuel">' + escapeHtml(line.fuelType) + '</span>' +
          '<span class="amount">&nbsp;' + Number(line.pricePerLiter || 0).toFixed(2) + '</span>' +
          '</span>'
        );
      });

    if (lines.length === 0) return '<span class="price-empty">&mdash;</span>';

    return '<span class="price-list">' + lines.join('') + '</span>';
  }

  /**
   * The status pill's own state, kept in one place because both the row markup
   * and the status filter need to agree on it.
   *
   * Inactive is neutral rather than red: a station that is off the map is a
   * deliberate state, not a fault, and colouring it as an error made a
   * perfectly healthy list look broken.
   *
   * @param {Object} station
   * @returns {{key: string, label: string, className: string, rowClass: string}}
   */
  function stationStatus(station) {
    if (station.isPending === true) {
      return { key: 'pending', label: 'Pending', className: 'status-warning', rowClass: 'row-pending' };
    }
    if (station.isActive === true) {
      return { key: 'active', label: 'Active', className: 'status-success', rowClass: 'row-active' };
    }
    return { key: 'inactive', label: 'Inactive', className: 'status-neutral', rowClass: 'row-inactive' };
  }

  /**
   * Applies the table's search box and status filter.
   *
   * The search covers the name, the brand and the address, because those are the
   * three things someone looking for a station would try. Matching is done on a
   * lowercased haystack built once per station per render.
   *
   * @param {Array} stations
   * @returns {Array} the stations to display
   */
  function filterStations(stations) {
    var query = state.tableQuery;
    var status = state.tableStatus;

    return stations.filter(function (station) {
      if (!station) return false;
      if (status && stationStatus(station).key !== status) return false;
      if (!query) return true;

      var haystack = [station.name, station.address, station.barangay];
      if (station.brand) haystack.push(station.brand.name);
      return haystack.some(function (value) {
        return value != null && String(value).toLowerCase().indexOf(query) !== -1;
      });
    });
  }

  /**
   * Writes the "showing N of M" count beside the filters.
   *
   * @param {number} shown
   * @param {number} total
   */
  function updateResultCount(shown, total) {
    var el = document.getElementById('table-count');
    if (!el) return;
    el.textContent = shown === total ? total + ' total' : shown + ' of ' + total;
  }

  /**
   * Render stations table.
   */
  function renderStations() {
    var tbody = document.getElementById('rows');
    if (!tbody) return;

    if (!state.stations) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading-row">Loading stations…</td></tr>';
      updateResultCount(0, 0);
      return;
    }

    if (state.stations.length === 0) {
      // Only an admin can add one, so the manager variant of this empty state
      // must not offer a button that would 403.
      var emptyAdd = state.isAdmin
        ? '<button class="btn btn-primary" type="button" id="btn-add-empty">Add station</button>'
        : '';

      tbody.innerHTML =
        '<tr><td colspan="5">' +
        '<div class="empty-state">' +
        '<h3>No stations yet</h3>' +
        '<p>Add your first gas station to start publishing it on the public map.</p>' +
        emptyAdd +
        '</div></td></tr>';
      updateResultCount(0, 0);

      var addEmpty = document.getElementById('btn-add-empty');
      if (addEmpty) addEmpty.addEventListener('click', openAddStationModal);
      return;
    }

    try {
      var visible = filterStations(state.stations);
      updateResultCount(visible.length, state.stations.length);

      // Distinguished from "no stations at all": the data is there, the current
      // filter just does not match any of it, so the fix is to clear the filter
      // rather than to create a record.
      if (visible.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="5">' +
          '<div class="empty-state">' +
          '<h3>No matching stations</h3>' +
          '<p>No station matches the current search and status filter.</p>' +
          '<button class="btn" type="button" id="btn-clear-filters">Clear filters</button>' +
          '</div></td></tr>';

        var clearBtn = document.getElementById('btn-clear-filters');
        if (clearBtn) {
          clearBtn.addEventListener('click', function () {
            state.tableQuery = '';
            state.tableStatus = '';
            var box = document.getElementById('table-search');
            var dropdown = document.getElementById('table-status');
            if (box) box.value = '';
            if (dropdown) dropdown.value = '';
            renderStations();
          });
        }
        return;
      }

var rows = visible.map(function (station) {
        var status = stationStatus(station);

        // A station manager gets the prices button and nothing else: the edit
        // and delete calls are admin-only in the API. Suppressing them here
        // keeps the row readable instead of mostly empty action gaps.
        var stationActions = state.isAdmin
          ? '<button class="btn btn-sm btn-icon btn-edit" type="button" data-id="' + (station.id || '') + '"' +
            ' title="Edit station" aria-label="Edit ' + escapeHtml(station.name || 'station') + '">' +
            '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2 2v-7"/>' +
            '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4-1 1-4 9.5-9.5z"/>' +
            '</svg>' +
            '</button>'
          : '';
        var deleteAction = state.isAdmin
          ? '<button class="btn btn-sm btn-icon btn-danger" type="button" data-id="' + (station.id || '') + '"' +
            ' title="Delete station" aria-label="Delete ' + escapeHtml(station.name || 'station') + '">' +
            '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="18" y1="6" x2="6" y2="18"/>' +
            '<line x1="6" y1="6" x2="18" y2="18"/>' +
            '</svg>' +
            '</button>'
          : '';

        return (
          '<tr class="' + status.rowClass + '">' +
          '<td>' + stationCell(station) + '</td>' +
          '<td class="hide-sm">' + escapeHtml(station.barangay || '—') + '</td>' +
          '<td><span class="status ' + status.className + '">' + status.label + '</span></td>' +
          '<td class="hide-sm">' + priceCell(station.prices) + '</td>' +
          '<td>' +
          '<div class="actions">' +
          // Icon-only buttons carry no visible text, so each one needs an
          // accessible name and a tooltip for sighted mouse users.
          stationActions +
          '<button class="btn btn-sm btn-price" type="button" data-id="' + (station.id || '') + '"' +
          ' title="Edit fuel prices">Prices</button>' +
          deleteAction +
          '</div>' +
          '</td>' +
          '</tr>'
        );
      });

      tbody.innerHTML = rows.join('');

      // Add event listeners to edit/delete buttons
      tbody.querySelectorAll('.btn-edit').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = parseInt(this.dataset.id, 10);
          if (isNaN(id)) return;
          var station = state.stations.find(function (s) {
            return s && s.id === id;
          });
          if (station) {
            openEditStationModal(station);
          }
        });
      });

      tbody.querySelectorAll('.btn-price').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = parseInt(this.dataset.id, 10);
          if (isNaN(id)) return;
          var station = state.stations.find(function (s) {
            return s && s.id === id;
          });
          if (station) {
            openPriceModal(station);
          }
        });
      });

      tbody.querySelectorAll('.btn-danger').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = parseInt(this.dataset.id, 10);
          if (isNaN(id)) return;
          if (confirm('Delete this station? This cannot be undone.')) {
            Api.deleteStation(id)
              .then(function () {
                loadData();
                showToast('Station deleted');
              })
              .catch(function (err) {
                showToast('Failed to delete station: ' + err.message, true);
                console.error(err);
              });
          }
        });
      });
    } catch (e) {
      console.error('Error rendering stations table:', e);
      tbody.innerHTML = '<tr><td colspan="5" class="error-row">Error rendering station list</td></tr>';
    }
  }

  /**
   * Update statistics panel.
   */
  function updateStats() {
    var statsEl = document.getElementById('stats');
    if (!statsEl || !state.stations) {
      if (statsEl) statsEl.innerHTML = '';
      return;
    }

    try {
      var total = state.stations.length;
      var active = state.stations.filter(function (s) {
        return s && s.isActive === true && s.isPending !== true;
      }).length;
      var pending = state.stations.filter(function (s) {
        return s && s.isPending === true;
      }).length;
      var inactive = state.stations.filter(function (s) {
        return s && s.isActive !== true && s.isPending !== true;
      }).length;

      statsEl.innerHTML =
        '<div class="stat"><h3>' + total + '</h3><p>Total</p></div>' +
        '<div class="stat"><h3>' + active + '</h3><p>Active</p></div>' +
        '<div class="stat"><h3>' + inactive + '</h3><p>Inactive</p></div>' +
        '<div class="stat"><h3>' + pending + '</h3><p>Pending</p></div>';
    } catch (e) {
      console.error('Error updating stats:', e);
      if (statsEl) statsEl.innerHTML = '<div class="stat"><h3>Error</h3><p>Stats unavailable</p></div>';
    }
  }

  /**
   * Add a row to the price form, optionally pre-filled.
   * @param {string} [fuelType]
   * @param {number} [pricePerLiter]
   */
  function addPriceRow(fuelType, pricePerLiter) {
    var priceRows = document.getElementById('price-rows');
    if (!priceRows) return;

    try {
      var row = document.createElement('div');
      row.className = 'price-row grid-2';
      row.innerHTML =
        '<div class="field">' +
        '<label>Fuel type <span class="req">*</span></label>' +
        '<input type="text" list="fuel-types" maxlength="60" required>' +
        '</div>' +
        '<div class="field">' +
        '<label>Price per liter <span class="req">*</span></label>' +
        '<input type="number" step="0.01" min="0" maxlength="10" required>' +
        '</div>' +
        '<button type="button" class="btn btn-sm btn-danger remove-price-row">–</button>';

      priceRows.appendChild(row);

      // Assigned as properties rather than baked into innerHTML so a stored
      // fuel type can never be injected as markup.
      var fuelInput = row.querySelector('input[list="fuel-types"]');
      var priceInput = row.querySelector('input[type="number"]');
      if (fuelInput && fuelType != null) fuelInput.value = fuelType;
      if (priceInput && pricePerLiter != null) priceInput.value = pricePerLiter;

      // Add remove button handler
      var removeBtn = row.querySelector('.remove-price-row');
      if (removeBtn) {
        removeBtn.addEventListener('click', function () {
          priceRows.removeChild(row);
        });
      }
    } catch (e) {
      console.error('Error adding price row:', e);
    }
  }

  /**
   * Save fuel prices for a station.
   */
  function savePrices() {
    var priceRows = document.getElementById('price-rows');
    if (!priceRows) return;

    var stationId = state.editingId;
    if (!stationId) {
      showPriceError('No station selected for price update');
      return;
    }

    var prices = [];
    var rows = priceRows.querySelectorAll('.price-row');
    rows.forEach(function (row) {
      var fuelType = row.querySelector('input[list="fuel-types"]');
      var priceInput = row.querySelector('input[type="number"]');
      if (fuelType && priceInput && fuelType.value.trim() && priceInput.value.trim()) {
        prices.push({
          fuelType: fuelType.value.trim(),
          pricePerLiter: parseFloat(priceInput.value),
        });
      }
    });

    // PUT /prices replaces the whole set, so an empty submission is refused
    // outright rather than being allowed to wipe every stored price.
    if (prices.length === 0) {
      showPriceError('Enter at least one fuel type and price before saving.');
      return;
    }

    var effectiveAtInput = document.getElementById('p-effective');
    var effectiveAt = effectiveAtInput && effectiveAtInput.value
      ? FmtTime.toDbString(FmtTime.fromLocalInput(effectiveAtInput.value))
      : null;

    var saveBtn = document.getElementById('price-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    Api.savePrices(stationId, prices, effectiveAt)
      .then(function () {
        closeModals();
        loadData();
        showToast('Prices saved successfully');
      })
      .catch(function (err) {
        showPriceError(err.message || 'Failed to save prices');
        console.error(err);
      })
      .finally(function () {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save prices';
        }
      });
  }

  /**
 * Open the change-password modal.
 *
 * bindEvents() referenced this before it existed, and because the reference is
 * evaluated while binding, the ReferenceError aborted bindEvents() partway
 * through: the Password button, every [data-close] button, backdrop-click and
 * the Escape key all ended up with no listener at all.
 */
function openPasswordModal() {
  var form = document.getElementById('password-form');
  if (form) {
    form.reset();
  }

  // Clears the stale error boxes left by a previous attempt.
  closeModals();
  openModal('password-modal');

  var current = document.getElementById('pw-current');
  if (current) {
    current.focus();
  }
}

/**
   * Change password.
   */
  function changePassword() {
    var form = document.getElementById('password-form');
    if (!form) return;

    var current = form.elements['pw-current'].value;
    var newPass = form.elements['pw-new'].value;
    var confirm = form.elements['pw-confirm'].value;

    if (!current || !newPass || !confirm) {
      showPasswordError('Please fill in all fields');
      return;
    }

    if (newPass !== confirm) {
      showPasswordError('New passwords do not match');
      return;
    }

    if (newPass.length < 8) {
      showPasswordError('Password must be at least 8 characters');
      return;
    }

    // Disable button during request
    var saveBtn = document.getElementById('password-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    // api.js takes two positional arguments; passing an object sent
    // currentPassword: { currentPassword, newPassword } and dropped newPassword
    // entirely, which the server rejected as "Value must be text."
    Api.changePassword(current, newPass)
      .then(function () {
        closeModals();
        form.reset();
        showToast('Password changed successfully');
      })
      .catch(function (err) {
        showPasswordError(err.message || 'Failed to change password');
        console.error(err);
      })
      .finally(function () {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Update password';
        }
      });
  }

  /**
   * Show error in the price form.
   *
   * The price modal has its own #price-error alert, so a failure stays on
   * screen next to the rows it belongs to instead of vanishing into a toast
   * that is gone after three seconds.
   * @param {string} message
   */
  function showPriceError(message) {
    var errorEl = document.getElementById('price-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  }

  /**
   * Show error in password form.
   * @param {string} message
   */
  function showPasswordError(message) {
    var errorEl = document.getElementById('password-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  }

  /**
   * Open a modal.
   * @param {string} modalId
   */
  function openModal(modalId) {
    var modal = document.getElementById(modalId);
    if (modal) {
      modal.hidden = false;
    }
  }

  /**
   * Hide the red alert in every modal.
   *
   * The modals are reused for each station, but only closeModals() used to clear
   * these. Reaching a modal from a table button instead left the previous
   * station's failure on screen - "Brand is required." shown above a different
   * station's form, inviting the admin to act on a message that no longer
   * applies.
   */
  function clearErrors() {
    ['station-error', 'price-error', 'password-error'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  /**
   * Close all modals.
   */
  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(function (el) {
      if (el) el.hidden = true;
    });
    clearErrors();
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {boolean} isError
   */
  function showToast(message, isError) {
    var toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = 'toast' + (isError ? ' toast-error' : '');
    toast.hidden = false;

    // One timer for the one toast element. Without clearing the previous one,
    // two messages in quick succession - loadData() followed by a failed save,
    // say - meant the first timer hid the second message three seconds after the
    // first appeared, truncating it mid-sentence.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toast) toast.hidden = true;
    }, 3000);
  }

  // The single live timer for the one #toast element, so a newer message
  // cannot be dismissed early by an older message's timer.
  var toastTimer;

  /**
   * Escape HTML special characters.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose API for debugging
  global.AdminDashboard = {
    state: state,
    initOsmPicker: initOsmPicker,
    loadData: loadData,
    syncPickerFromInputs: syncPickerFromInputs,
    isApiErrorResponse: isApiErrorResponse,
    extractApiData: extractApiData,
    // The stations table's view logic is pure over `state.stations` and the two
    // filter fields, which is what makes it worth asserting on directly.
    renderStations: renderStations,
    filterStations: filterStations,
    stationStatus: stationStatus,
  };
})(window);

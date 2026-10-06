/* Thin fetch wrapper. All reads are public; writes go to /api/admin and are
   rejected by the server unless a signed-in dashboard session authorises them
   - admins for anything, a station_manager only for their own station's
   prices. */
(function (global) {
  'use strict';

  async function request(path, options) {
    var opts = options || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });

    var payload = null;
    var text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = null;
      }
    }

    if (!res.ok) {
      var err = new Error(
        (payload && payload.error && payload.error.message) || 'Request failed (' + res.status + ')',
      );
      err.status = res.status;
      err.details = payload && payload.error && payload.error.details;
      throw err;
    }
    return payload;
  }

  global.Api = {
    meta: function () { return request('/api/meta'); },
    brands: function () { return request('/api/brands'); },
    stations: function () { return request('/api/stations'); },
    station: function (id) { return request('/api/stations/' + encodeURIComponent(id)); },
    me: function () { return request('/api/auth/me'); },
    // Flat session probe for the public map: { id, username, role, station_id }.
    // Throws with err.status 401 when nobody is signed in.
    whoami: function () { return request('/api/me'); },
    login: function (username, password) {
      return request('/api/auth/login', { method: 'POST', body: { username: username, password: password } });
    },
    logout: function () { return request('/api/auth/logout', { method: 'POST' }); },
    adminStations: function () { return request('/api/admin/stations'); },
    adminConfig: function () { return request('/api/admin/config'); },
    createStation: function (data) {
      return request('/api/admin/stations', { method: 'POST', body: data });
    },
    updateStation: function (id, data) {
      return request('/api/admin/stations/' + encodeURIComponent(id), { method: 'PATCH', body: data });
    },
    deleteStation: function (id) {
      return request('/api/admin/stations/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    savePrices: function (id, prices, effectiveAt) {
      return request('/api/admin/stations/' + encodeURIComponent(id) + '/prices', {
        method: 'PUT',
        body: { prices: prices, effectiveAt: effectiveAt },
      });
    },
    priceHistory: function (id) {
      return request('/api/admin/stations/' + encodeURIComponent(id) + '/price-history');
    },
    changePassword: function (currentPassword, newPassword) {
      return request('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: currentPassword, newPassword: newPassword },
      });
    },
  };
})(window);

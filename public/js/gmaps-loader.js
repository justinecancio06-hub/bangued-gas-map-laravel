/* Loader for the Maps JavaScript API.
 *
 * The key is not baked into the HTML: both the public map and the admin picker
 * are static files served straight out of public/, so they cannot template it.
 * They read it from /api/meta (or /api/admin/config) and hand it here, which
 * keeps the key in one place - .env - instead of copied into three documents.
 *
 * The API is injected rather than added as a plain <script src> in the markup
 * for the same reason: a static tag would need the key in the HTML, and it
 * would be fetched whether or not the visitor ever reaches the map.
 */
(function (global) {
  'use strict';

  var SRC = 'https://maps.googleapis.com/maps/api/js';

  /* In-flight load, shared so concurrent callers await one request. Cleared on
     failure so a later attempt can retry rather than replaying a dead promise. */
  var pending = null;

  /**
   * @param {string} apiKey    Browser key from config('bangued.google_maps').
    * @param {{language?:string, onAuthFailure?:function}} [options]
   * @returns {Promise<object>} The `google.maps` namespace.
   */
  function load(apiKey, options) {
    var opts = options || {};

    if (!apiKey) {
      return Promise.reject(new Error(
        'No Google Maps API key is configured. Set GOOGLE_MAPS_API_KEY in .env, '
        + 'then run `php artisan config:clear`.',
      ));
    }
    if (global.google && global.google.maps) {
      return Promise.resolve(global.google.maps);
    }
    if (pending) return pending;

    var params = ['key=' + encodeURIComponent(apiKey), 'v=weekly'];
    if (opts.language) params.push('language=' + encodeURIComponent(opts.language));
    // No map id is sent on the URL. The Maps JavaScript API has no "map_id"
    // bootstrap parameter (it has "map_ids", plural, and that only preloads
    // cloud styles), and a map is actually styled by the mapId option on its
    // own constructor. Passing it here did nothing at all, so GOOGLE_MAPS_MAP_ID
    // had no effect anywhere - see config/bangued.php.

    pending = new Promise(function (resolve, reject) {
      // Google calls this when the script was served but the key cannot
      // authenticate the current page. Without it the app only notices the
      // grey error overlay after Google paints it, which is too late for a
      // usable message.
      global.gm_authFailure = function () {
        pending = null;
        if (typeof opts.onAuthFailure === 'function') {
          try { opts.onAuthFailure(); } catch (e) { console.error(e); }
        }
        var authError = new Error(
          'Google Maps rejected this API key or referrer. Check GOOGLE_MAPS_API_KEY, '
          + 'billing, and the allowed HTTP referrers.',
        );
        authError.authFailed = true;
        reject(authError);
      };

      var script = document.createElement('script');
      script.src = SRC + '?' + params.join('&');
      script.async = true;
      script.defer = true;
      script.onload = function () {
        if (global.google && global.google.maps) {
          resolve(global.google.maps);
        } else {
          // The script served fine but the namespace is missing, which is what
          // an invalid or unauthorised key looks like.
          pending = null;
          reject(new Error('Google Maps loaded but the google.maps namespace is missing.'));
        }
      };
      script.onerror = function () {
        pending = null;
        reject(new Error(
          'Could not reach the Google Maps API. Check the key, your connection, '
          + 'and any content-security policy that blocks maps.googleapis.com.',
        ));
      };
      document.head.appendChild(script);
    });

    return pending;
  }

  global.GMaps = { load: load };
})(window);
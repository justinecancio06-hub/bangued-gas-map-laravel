/* Brand marker + inline icon factory. Plain script (no modules) so it can be
   dropped straight into the page. */
(function (global) {
  'use strict';

  var PUMP_BODY =
    'M6 2h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-.6v1.8a1 1 0 0 1-1 1H7.6a1 1 0 0 1-1-1V17H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z';
  var PUMP_WINDOW = 'M7 5h3v4H7z';
  var PUMP_HOSE = 'M12 5.4h2.2a2.2 2.2 0 0 1 2.2 2.2v3.2';
  var PUMP_NOZZLE = 'M16.4 9.6 18.4 11.6';

  /* The uniform red pin, still used by the admin dashboard's coordinate picker:
     a station being dragged around a map has to read as "this one point", not
     as a brand. The public map draws stationIcon()/brandPin() instead. */
  var RED_PIN_FILL = '#e53935';
  var SELECTED = '#0f766e';

  /* The teardrop, as an SVG path. 30x40 with the tip at y = 38.8. */
  var PIN_PATH =
    'M15 1.2C7.5 1.2 1.4 7.3 1.4 14.8c0 9.9 13.6 24 13.6 24s13.6-14.1 13.6-24C28.6 7.3 22.5 1.2 15 1.2z';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Brand-coloured fuel-pump map pin.
   * @param {{colorPrimary:string,colorSecondary:string}} brand
   */
  function pinSvg(brand, size) {
    var primary = brand.colorPrimary || '#0f766e';
    var secondary = brand.colorSecondary || '#ffffff';
    var w = size || 30;
    var h = Math.round((w * 40) / 30);
    return (
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 30 40" aria-hidden="true">' +
      '<path d="' + PIN_PATH + '" ' +
      'fill="' + esc(primary) + '" stroke="' + esc(secondary) + '" stroke-width="1.7"/>' +
      '<g transform="translate(15 14.2) scale(0.54) translate(-9.5 -11.5)">' +
      '<path d="' + PUMP_BODY + '" fill="#fff"/>' +
      '<path d="' + PUMP_WINDOW + '" fill="' + esc(primary) + '"/>' +
      '<path d="' + PUMP_HOSE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="' + PUMP_NOZZLE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '</g></svg>'
    );
  }

  /**
   * Google Maps marker icon for a station: the brand's own logo on a white
   * teardrop pin, so the marker still reads as a pin pointing at the exact
   * coordinate.
   *
   * A google.maps.Icon is an image URL, not markup, so the pin has to be
   * rasterised. The logo files vary wildly in aspect ratio (shell is
   * 5000x4632, petron 1192x1454, caltex 300x300), which is why they are drawn
   * into a canvas with contain-fit sizing rather than handed over whole.
   *
   * `options.approximate` adds a small amber flag so unverified positions are
   * visible on the map, not hidden. `options.selected` rings the pin.
   *
   * Asynchronous because the logo has to decode first; results are cached per
   * brand and variant because toDataURL is not cheap and the same handful of
   * brands is redrawn on every map load.
   *
   * @param {object} gmaps The `google.maps` namespace.
   * @param {{slug:string,name:string,colorPrimary:string,colorSecondary:string,logoPath?:string}} brand
   * @param {{approximate?:boolean, selected?:boolean}} [options]
   * @returns {Promise<object>} A google.maps.Icon.
   */
  function stationIcon(gmaps, brand, options) {
    var opts = options || {};
    var key = (brand && brand.slug) + '|' + (opts.approximate ? 1 : 0) + '|' + (opts.selected ? 1 : 0);
    if (iconCache[key]) return iconCache[key];

    iconCache[key] = loadLogo(brand).then(function (img) {
      return new gmaps.Icon({
        url: drawPin(img, brand, opts),
        scaledSize: new gmaps.Size(PIN.width, PIN.height),
        // Anchored at the tail tip, not the bottom of the canvas - the canvas
        // carries empty margin for the shadow, so anchoring on it would float
        // the pin off the coordinate by that margin.
        anchor: new gmaps.Point(PIN.width / 2, PIN.tipY),
      });
    });

    return iconCache[key];
  }

  /* Pin geometry, in CSS pixels. Every brand uses the same numbers, so the map
     never looks like a mix of unrelated pins.

     The pads are the empty margin a canvas needs but a CSS pin did not: unlike
     a positioned div, canvas content is clipped to the canvas, so the drop
     shadow below the tail and the amber flag on the disc's top-right corner
     each need room or they get cut off at the edge. padTop and padX cover the
     flag, padBottom the shadow. */
  var PIN = { badge: 34, tail: 11, flag: 8, padTop: 9, padX: 9, padBottom: 6 };
  PIN.width = PIN.badge + PIN.padX * 2;
  PIN.height = PIN.badge + PIN.tail + PIN.padTop + PIN.padBottom;
  PIN.tipY = PIN.padTop + PIN.badge + PIN.tail;

  var iconCache = {};

  /* Where the tangent lines from the tail tip meet the disc. Solving for the
     tangent point keeps the tail flush with the circle: the join point sits at
     y = cy + r^2/d from the centre, offset sideways by r*sqrt(1 - r^2/d^2).
     Sweeping the arc the long way from one tangent point to the other leaves
     only the wedge between them missing, which is what a teardrop looks like. */
  function pinPath(ctx) {
    var cx = PIN.width / 2;
    var r = PIN.badge / 2;
    var cy = PIN.padTop + r;
    var d = PIN.tipY - cy;
    var ty = cy + (r * r) / d;
    var tx = r * Math.sqrt(1 - (r * r) / (d * d));
    var from = Math.atan2(ty - cy, -tx);
    var to = Math.atan2(ty - cy, tx);
    if (to < from) to += Math.PI * 2;

    ctx.beginPath();
    ctx.moveTo(cx, PIN.tipY);
    ctx.lineTo(cx - tx, ty);
    ctx.arc(cx, cy, r, from, to, false);
    ctx.lineTo(cx, PIN.tipY);
    ctx.closePath();
  }

  function drawPin(img, brand, opts) {
    var canvas = document.createElement('canvas');
    canvas.width = PIN.width;
    canvas.height = PIN.height;
    var ctx = canvas.getContext('2d');
    var cx = PIN.width / 2;
    var r = PIN.badge / 2;
    var cy = PIN.padTop + r;

    // The disc and the tail are one path, so they cast a single shadow instead
    // of the tail's reading darker where it overlaps the disc.
    ctx.save();
    ctx.shadowColor = opts.selected ? 'rgba(15,118,110,.95)' : 'rgba(0,0,0,.35)';
    ctx.shadowBlur = opts.selected ? 6 : 3;
    ctx.shadowOffsetY = 2;
    pinPath(ctx);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();

    if (opts.selected) {
      pinPath(ctx);
      ctx.strokeStyle = '#0f766e';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    pinPath(ctx);
    ctx.strokeStyle = '#dde4ec';
    ctx.lineWidth = 1;
    ctx.stroke();

    drawPinFace(ctx, img, brand, cx, cy, r);

    if (opts.approximate) {
      drawFlag(ctx, cx + r - 1, cy - r + 1);
    }

    return canvas.toDataURL('image/png');
  }

  /** The artwork inside the disc: the brand logo when there is one, otherwise
      the coloured pump chip the legend uses. */
  function drawPinFace(ctx, img, brand, cx, cy, r) {
    var box = (PIN.badge - 8);   // 4px of breathing room inside the disc
    if (img) {
      // contain-fit: the logo files are square, letterboxed and landscape in
      // wildly different proportions.
      var scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
      var w = img.naturalWidth * scale;
      var h = img.naturalHeight * scale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      return;
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.fillStyle = brand.colorPrimary || '#0f766e';
    ctx.fill();
    ctx.strokeStyle = brand.colorSecondary || 'rgba(0,0,0,.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    drawGlyphFace(ctx, cx, cy, '#fff', brand.colorPrimary || '#0f766e');
  }

  function drawFlag(ctx, x, y) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, PIN.flag, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#f0a500';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#a86a00';
    ctx.font = 'bold 11px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y + 0.5);
    ctx.restore();
  }

  /* ---------------------------------------------------- uniform red pin */

  /* The red pin as inline SVG, for the Leaflet maps: a divIcon takes
     markup directly, so nothing has to be rasterised there.

     @returns {{markup:string, width:number, height:number, anchor:number[]}} */
  function redPin(options) {
    var o = options || {};
    var key = (o.approximate ? 1 : 0) + '|' + (o.selected ? 1 : 0);
    if (redPinCache[key]) return redPinCache[key];

    redPinCache[key] = pinShell(glyphFace('#fff', RED_PIN_FILL), o, {
      fill: RED_PIN_FILL,
      ring: '#ffffff',
    });

    return redPinCache[key];
  }

  var redPinCache = {};

  /* ------------------------------------------------- brand-logo station pin */

  /**
   * Brand-logo station pin as inline SVG, for the Leaflet fallback map: the
   * same white teardrop stationIcon() rasterises for Google Maps, so a station
   * is recognisable by its brand on either provider.
   *
   * A divIcon takes markup rather than a URL, so the logo is embedded as an
   * SVG <image> the browser fetches and places itself - no canvas round trip
   * and no waiting for the pin before the marker can be drawn.
   *
   * A brand with no logo file falls back to the coloured pump chip, which is
   * what the canvas path above does when the image fails to decode. A file
   * that exists but fails to load leaves a blank white disc: an SVG <image>
   * cannot report the failure, and painting the chip underneath every logo
   * would put a saturated colour behind brand artwork drawn for white, which
   * reads badly on the logos that are a single flat colour themselves.
   *
   * @param {{slug:string,colorPrimary:string,colorSecondary:string,logoPath?:string}} brand
   * @param {{approximate?:boolean, selected?:boolean}} [options]
   * @returns {{markup:string, width:number, height:number, anchor:number[]}}
   */
  function brandPin(brand, options) {
    var o = options || {};
    var key = (brand && brand.slug) + '|' + (o.approximate ? 1 : 0) + '|' + (o.selected ? 1 : 0);
    if (brandPinCache[key]) return brandPinCache[key];

    brandPinCache[key] = pinShell(brandLogoFace(brand), o, {
      fill: '#fff',
      // The same hairline the canvas brand pin draws: a light grey ring reads
      // as a pin edge on a white disc, a white one would vanish into it.
      ring: '#dde4ec',
    });

    return brandPinCache[key];
  }

  var brandPinCache = {};

  /**
   * The brand logo as an SVG <image> centred in the pin's disc, contain-fitted
   * because the files run from 300x300 to 5000x4632. The box is sized so its
   * corners stay inside the disc, which is why no clip-path is needed.
   */
  function brandLogoFace(brand) {
    var src = logoUrl(brand);
    if (!src) return pumpFace(brand && brand.colorPrimary);

    var box = 19;
    var x = PIN_CENTRE - box / 2;

    return (
      '<image href="' + esc(src) + '" x="' + x + '" y="' + x + '" width="' + box + '" height="' + box +
      '" preserveAspectRatio="xMidYMid meet"/>'
    );
  }

  /**
   * The coloured pump chip: a brand-coloured disc carrying the white glyph,
   * matching the legend mark and the canvas fallback face.
   */
  function pumpFace(primary) {
    var color = primary || '#0f766e';
    return (
      '<circle cx="' + PIN_CENTRE + '" cy="' + PIN_CENTRE + '" r="12.6" fill="' +
      esc(color) + '" stroke="rgba(0,0,0,.2)" stroke-width="1.5"/>' +
      glyphFace('#fff', color)
    );
  }

  /** The white pump glyph, in pin coordinates. */
  function glyphFace(fill, accent) {
    return (
      '<g transform="translate(15 14.2) scale(0.54) translate(-9.5 -11.5)">' +
      '<path d="' + PUMP_BODY + '" fill="' + esc(fill) + '"/>' +
      '<path d="' + PUMP_WINDOW + '" fill="' + esc(accent) + '"/>' +
      '<path d="' + PUMP_HOSE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="' + PUMP_NOZZLE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '</g>'
    );
  }

  /* Centre of the pin's disc, in PIN_PATH's own 30x40 coordinates: the circle is
     27.2 across (x 1.4 to 28.6) and starts at y = 1.2, so (15, 14.8) rounded. */
  var PIN_CENTRE = 15;

  /**
   * The teardrop shell every station pin shares, with the artwork inside the
   * disc supplied by the caller.
   *
   * The viewBox is wider than the pin on purpose - it leaves the top-right
   * corner free for the amber "?" flag without the flag being clipped, which is
   * why the pin is offset by (10, 2) rather than sitting at the origin.
   *
   * @param {string} face Markup drawn inside the disc, in pin coordinates.
   * @param {{approximate?:boolean, selected?:boolean}} options
   * @param {{fill:string, ring:string}} palette
   * @returns {{markup:string, width:number, height:number, anchor:number[]}}
   */
  function pinShell(face, options, palette) {
    var o = options || {};
    var stroke = o.selected ? SELECTED : palette.ring;
    var strokeWidth = o.selected ? 3 : 1.7;

    var flag = o.approximate
      ? '<g transform="translate(43 7)">' +
        '<circle r="5.5" fill="#fff" stroke="#f0a500" stroke-width="2"/>' +
        '<text y="0.5" text-anchor="middle" dominant-baseline="central" fill="#a86a00" ' +
        'font-family="Arial, Helvetica, sans-serif" font-size="8" font-weight="bold">?</text>' +
        '</g>'
      : '';

    return {
      markup:
        '<svg width="' + RED_PIN.width + '" height="' + RED_PIN.height + '" viewBox="0 0 50 44" aria-hidden="true">' +
        '<g transform="translate(10 2)">' +
        '<path d="' + PIN_PATH + '" fill="' + palette.fill + '" stroke="' + stroke +
        '" stroke-width="' + strokeWidth + '"/>' +
        face + '</g>' + flag + '</svg>',
      width: RED_PIN.width,
      height: RED_PIN.height,
      // Tail tip, so the pin points at the coordinate rather than beside it.
      anchor: [25 * RED_PIN.scale, 40.8 * RED_PIN.scale],
    };
  }

  var RED_PIN = { width: 40, viewBoxWidth: 50, viewBoxHeight: 44 };
  RED_PIN.scale = RED_PIN.width / RED_PIN.viewBoxWidth;
  RED_PIN.height = Math.round(RED_PIN.viewBoxHeight * RED_PIN.scale * 100) / 100;

  /** The white pump glyph, drawn into a box centred on (cx, cy). */
  function drawGlyphFace(ctx, cx, cy, color, accent) {
    var box = PIN.badge - 8;   // 4px of breathing room inside the disc
    ctx.save();
    var s = box / 24;
    ctx.translate(cx - box / 2, cy - box / 2);
    ctx.scale(s, s);
    ctx.fillStyle = color;
    ctx.fill(new Path2D(PUMP_BODY));
    ctx.fillStyle = accent;
    ctx.fill(new Path2D(PUMP_WINDOW));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.stroke(new Path2D(PUMP_HOSE));
    ctx.stroke(new Path2D(PUMP_NOZZLE));
    ctx.restore();
  }

  /**
   * Loads a brand logo, resolving with null when there is no file or it fails
   * to decode, so the caller can fall back to the coloured chip rather than
   * dropping the station off the map.
   * @param {{slug:string,logoPath?:string}} brand
   */
  function loadLogo(brand) {
    var src = logoUrl(brand);
    if (!src) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /* ------------------------------------------------------------------- logos */

  /* Brand logo files are served from the site root out of public/images/brands. */
  var LOGO_DIR = '/images/brands/';

  /**
   * Resolves a brand's logo URL. The DB supplies logo_path, but fall back to
   * the conventional filename derived from the slug so a brand still gets its
   * logo when the API predates that column.
   * @param {{slug:string,logoPath?:string}} brand
   */
  function logoUrl(brand) {
    if (!brand) return '';
    if (brand.logoPath) return brand.logoPath;
    return brand.slug ? LOGO_DIR + brand.slug + '.png' : '';
  }

  /**
   * <img> for a brand logo. `options.fallback` is the markup to restore if the
   * image is missing or fails to decode; it travels in data-fallback so the
   * single delegated error handler can restore it without a brand reference.
   * Logos are decorative: the brand name always sits beside them as text.
   */
  function brandLogo(brand, options) {
    var opts = options || {};
    var fallback = opts.fallback || legendMark(brand);
    var src = logoUrl(brand);
    if (!src) return fallback;
    return (
      '<img class="brand-logo" src="' + esc(src) + '" alt="" data-fallback="' + esc(fallback) + '"' +
      (opts.lazy ? ' loading="lazy"' : '') +
      ' decoding="async">'
    );
  }

  /* `error` does not bubble, so one capture-phase listener on the document
     covers every brand logo, including the ones InfoWindows and list rows
     inject later. */
  document.addEventListener(
    'error',
    function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.classList.contains('brand-logo')) return;
      var fallback = img.getAttribute('data-fallback');
      if (fallback === null) return;
      img.removeAttribute('data-fallback');
      img.outerHTML = fallback;
    },
    true,
  );

  /** Small circular brand chip used in the legend, list and popups. */
  function legendMark(brand) {
    return (
      '<span class="legend-mark" style="background:' + esc(brand.colorPrimary) +
      ';border:1.5px solid ' + esc(brand.colorSecondary || 'rgba(0,0,0,.2)') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + PUMP_BODY + '" fill="#fff"/>' +
      '<path d="' + PUMP_WINDOW + '" fill="' + esc(brand.colorPrimary) + '"/>' +
      '<path d="' + PUMP_HOSE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="' + PUMP_NOZZLE + '" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
      '</svg></span>'
    );
  }

  var ICON_PATHS = {
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    phone:
      '<path d="M6.6 3h3l1.5 4-2 1.4a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    fuel:
      '<path d="M5 21V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v17M4 21h9M7 7h3v4H7z"/><path d="M13 8h2.5a2 2 0 0 1 2 2v6"/><path d="M17.5 14.5 20 17"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
    navigate: '<path d="M3.6 11 20.4 4l-7.2 16-2.1-6.5L3.6 11Z"/>',
  };

  /** 16px stroked icon for popups and list rows. */
  function smallIcon(name) {
    var d = ICON_PATHS[name] || ICON_PATHS.info;
    return (
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'
    );
  }

  global.MapIcons = {
    pinSvg: pinSvg,
    stationIcon: stationIcon,
    
    redPin: redPin,
    brandPin: brandPin,
    legendMark: legendMark,
    logoUrl: logoUrl,
    brandLogo: brandLogo,
    smallIcon: smallIcon,
    escape: esc,
  };
})(window);

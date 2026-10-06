/* Timestamp helpers.
 *
 * Every timestamp in the database is stored as SQLite's datetime('now') output,
 * i.e. "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. These helpers make
 * that convention explicit so the UI never mislabels a price as hours off. */
(function (global) {
  'use strict';

  /** Parses a stored timestamp as UTC. Returns null when unparseable. */
  function parse(value) {
    if (!value) return null;
    var s = String(value).trim();

    // Already carries an explicit zone.
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
      var zoned = new Date(s);
      return isNaN(zoned.getTime()) ? null : zoned;
    }

    // Naive form -> UTC by convention.
    var d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }

  /** "26 Sep 2026, 3:45 PM" in the viewer's locale, or null. */
  function format(value) {
    var d = parse(value);
    if (!d) return null;
    return d.toLocaleString('en-PH', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Whole hours elapsed since a stored timestamp, or null when unparseable. */
  function ageHours(value) {
    var d = parse(value);
    if (!d) return null;
    var ms = Date.now() - d.getTime();
    // A clock skew, or a timestamp written by a machine running ahead of this
    // one, must not yield a negative age - it would render as "in 3 hours".
    return ms < 0 ? 0 : ms / 36e5;
  }

  /** "just now" / "40 min ago" / "6 hr ago" / "3 days ago", or null. */
  function relative(value) {
    var hours = ageHours(value);
    if (hours === null) return null;

    if (hours < 1) {
      var mins = Math.max(1, Math.round(hours * 60));
      return mins === 1 ? 'just now' : mins + ' min ago';
    }
    if (hours < 24) return Math.round(hours) + ' hr ago';

    var days = Math.round(hours / 24);
    if (days <= 45) return days === 1 ? 'yesterday' : days + ' days ago';

    var months = Math.round(days / 30.44);
    if (months <= 12) return months === 1 ? 'a month ago' : months + ' months ago';
    var years = Math.round(days / 365.25);
    return years === 1 ? 'a year ago' : years + ' years ago';
  }

  /** UTC "YYYY-MM-DD HH:MM:SS" for database storage. */
  function toDbString(date) {
    return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
  }

  /** Value for an <input type="datetime-local">, which is local wall time. */
  function toLocalInput(date) {
    var d = new Date(date);
    var shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }

  /** Parses an <input type="datetime-local"> value (local wall time) to UTC. */
  function fromLocalInput(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  global.FmtTime = {
    parse: parse,
    format: format,
    ageHours: ageHours,
    relative: relative,
    toDbString: toDbString,
    toLocalInput: toLocalInput,
    fromLocalInput: fromLocalInput,
  };
})(window);

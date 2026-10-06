<?php

namespace App\Http;

use App\Support\Bangued;
use Illuminate\Http\Request;

/**
 * Input helpers, ported one-for-one from src/lib/validate.js.
 *
 * Every method either returns a clean value or throws HttpError, so controllers
 * can assume well-formed input from the point of validation onwards.
 */
class Validate
{
    /** Trims a scalar to a trimmed string; null stays null, '' stays ''. */
    private static function str(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_string($value)) {
            return trim($value);
        }
        if (is_bool($value) || is_array($value) || is_object($value)) {
            // Not representable as user text; reject rather than stringify into
            // something like "Array" or "1".
            throw HttpError::badRequest('Value must be text.');
        }

        return trim((string) $value);
    }

    /** Optional string, max length, null when empty. */
    public static function optionalString(mixed $value, string $field, int $max = 500): ?string
    {
        $s = self::str($value);
        if ($s === null || $s === '') {
            return null;
        }
        if (mb_strlen($s) > $max) {
            throw HttpError::badRequest("{$field} must be {$max} characters or fewer.");
        }

        return $s;
    }

    /** Required non-empty string. */
    public static function requiredString(mixed $value, string $field, int $max = 160): string
    {
        $s = self::str($value);
        if ($s === null || $s === '') {
            throw HttpError::badRequest("{$field} is required.");
        }
        if (mb_strlen($s) > $max) {
            throw HttpError::badRequest("{$field} must be {$max} characters or fewer.");
        }

        return $s;
    }

    /**
     * Parses a latitude/longitude pair and enforces the Bangued-only
     * constraint. Returns ['latitude' => float|null, 'longitude' => float|null]
     * or throws 400.
     *
     * Mirrors the JS exactly, including the "either field blank clears the
     * pair" rule and the bounds error carrying the offending limits.
     */
    public static function coordinates(mixed $latInput, mixed $lonInput, bool $required = true): array
    {
        $empty = self::isBlank($latInput) || self::isBlank($lonInput);

        if ($empty) {
            if ($required) {
                throw HttpError::badRequest('Latitude and longitude are required.');
            }

            return ['latitude' => null, 'longitude' => null];
        }

        $latitude = self::num($latInput);
        $longitude = self::num($lonInput);

        if ($latitude === null || $longitude === null) {
            throw HttpError::badRequest('Latitude and longitude must be numbers.');
        }
        if ($latitude < -90 || $latitude > 90) {
            throw HttpError::badRequest('Latitude must be between -90 and 90.');
        }
        if ($longitude < -180 || $longitude > 180) {
            throw HttpError::badRequest('Longitude must be between -180 and 180.');
        }

        // Resolved through Bangued so the limits are derived from
        // data/bangued-boundary.json rather than hardcoded here.
        $bounds = Bangued::stationBounds();
        if ($latitude < $bounds['minLat'] || $latitude > $bounds['maxLat']
            || $longitude < $bounds['minLon'] || $longitude > $bounds['maxLon']) {
            throw HttpError::badRequest(
                'That location is outside Bangued, Abra. This map only accepts stations inside the Bangued boundary.',
                ['bounds' => $bounds],
            );
        }

        return ['latitude' => $latitude, 'longitude' => $longitude];
    }

    /** True for null, '', or a whitespace-only string. */
    private static function isBlank(mixed $value): bool
    {
        if ($value === null || $value === '') {
            return true;
        }

        return is_string($value) && trim($value) === '';
    }

    /**
     * Numeric coercion that refuses non-numeric text.
     *
     * is_numeric() rather than a bare (float) cast: PHP would turn "abc" into
     * 0.0, which would then be rejected as out-of-bounds instead of as the type
     * error it actually is.
     */
    private static function num(mixed $value): ?float
    {
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        if (is_string($value) && is_numeric(trim($value))) {
            return (float) trim($value);
        }

        return null;
    }

    /** Accepts real booleans and the usual form-encoded spellings. */
    public static function boolean(mixed $value, bool $fallback = false): bool
    {
        if ($value === null || $value === '') {
            return $fallback;
        }
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }

        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
    }

    /** Positive integer id from a route parameter or body field. */
    public static function id(mixed $value, string $field = 'id'): int
    {
        $n = is_numeric($value) ? (int) $value : 0;
        if ($n < 1) {
            throw HttpError::badRequest("Invalid {$field}.");
        }

        return $n;
    }

    /** True when a request body key is present, even if its value is null. */
    public static function hasKey(Request $request, string $key): bool
    {
        return array_key_exists($key, $request->all());
    }
}

<?php

namespace App\Http\Controllers;

use App\Http\HttpError;
use App\Http\Validate;
use App\Models\Brand;
use App\Models\FuelPrice;
use App\Models\FuelPriceHistory;
use App\Models\Station;
use App\Support\Bangued;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Station CRUD plus the fuel price editor.
 *
 * Port of src/routes/admin.js. No action here re-checks the session: the reads
 * and the price editor sit behind RequireStaff (either dashboard role), and
 * store/update/destroy sit behind RequireAdmin as well, because a station
 * manager only maintains prices.
 */
class AdminApiController extends Controller
{
    /** All stations, including placeholders and hidden ones. */
    public function stations(): JsonResponse
    {
        $stations = Station::with(['brand', 'prices'])->get()
            ->sortBy([
                fn ($a, $b) => $a->brand->sort_order <=> $b->brand->sort_order,
                fn ($a, $b) => strcasecmp($a->name, $b->name),
            ])
            ->values();

        return response()->json([
            'data' => $stations->map(fn (Station $s) => $s->toApiArray())->all(),
        ]);
    }

    public function brands(): JsonResponse
    {
        return response()->json([
            'data' => Brand::orderBy('sort_order')->orderBy('name')->get()
                ->map(fn (Brand $b) => $b->toApiArray())->all(),
        ]);
    }

    /** Fuel types, coordinate bounds and map config for the dashboard. */
    public function config(): JsonResponse
    {
        return response()->json([
            'data' => [
                'fuelTypes' => config('bangued.fuel_types'),
                'stationBounds' => Bangued::stationBounds(),
                'map' => [
                    'center' => config('bangued.map.center'),
                    'defaultZoom' => config('bangued.map.defaultZoom'),
                    'minZoom' => config('bangued.map.minZoom'),
                    'maxZoom' => config('bangued.map.maxZoom'),
                    'maxBounds' => Bangued::maxBounds(),
                    // The coordinate picker is a Google Map too, so it needs
                    // the same key the public map boots with.
                    'google' => Bangued::googleConfig(),
                ],
            ],
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $name = Validate::requiredString($request->input('name'), 'Station name');
        $brandId = $this->resolveBrandId($request->input('brandId'));
        if (! $brandId) {
            throw HttpError::badRequest('Brand is required.');
        }

        ['latitude' => $latitude, 'longitude' => $longitude] =
            Validate::coordinates($request->input('latitude'), $request->input('longitude'), required: false);

        $hasCoords = $latitude !== null;

        // A record with no coordinates cannot be plotted, so it starts pending.
        $station = new Station([
            'brand_id' => $brandId,
            'name' => $name,
            'address' => Validate::optionalString($request->input('address'), 'Address', 400),
            'barangay' => Validate::optionalString($request->input('barangay'), 'Barangay', 120),
            'latitude' => $latitude,
            'longitude' => $longitude,
            'contact_phone' => Validate::optionalString($request->input('contactPhone'), 'Contact phone', 60),
            'contact_email' => Validate::optionalString($request->input('contactEmail'), 'Contact email', 160),
            'operating_hours' => Validate::optionalString($request->input('operatingHours'), 'Operating hours', 200),
            'notes' => Validate::optionalString($request->input('notes'), 'Notes', 2000),
            'is_pending' => ! $hasCoords,
            'is_active' => Validate::boolean($request->input('isActive'), true),
            'location_confidence' => $hasCoords ? $this->confidenceOrApproximate($request->input('locationConfidence')) : 'pending',
            'osm_ref' => Validate::optionalString($request->input('osmRef'), 'OSM reference', 60),
        ]);
        $station->save();

        return response()->json(
            ['data' => $station->fresh(['brand', 'prices'])->toApiArray()],
            201,
        );
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $station = Station::find(Validate::id($id, 'station id'));
        if (! $station) {
            throw HttpError::notFound('Station not found.');
        }

        // Tracks whether the body contained anything updatable, so an empty
        // PATCH is rejected instead of silently bumping updated_at.
        $touched = false;

        // Only keys actually present in the body are touched, so a PATCH never
        // blanks a field the caller did not mention.
        if (Validate::hasKey($request, 'name')) {
            $touched = true;
            $station->name = Validate::requiredString($request->input('name'), 'Station name');
        }
        if (Validate::hasKey($request, 'brandId')) {
            $touched = true;
            $brandId = $this->resolveBrandId($request->input('brandId'));
            if (! $brandId) {
                throw HttpError::badRequest('Brand is required.');
            }
            $station->brand_id = $brandId;
        }
        foreach ([
            'address' => ['Address', 400],
            'barangay' => ['Barangay', 120],
            'contactPhone' => ['Contact phone', 60],
            'contactEmail' => ['Contact email', 160],
            'operatingHours' => ['Operating hours', 200],
            'notes' => ['Notes', 2000],
            'osmRef' => ['OSM reference', 60],
        ] as $key => [$label, $max]) {
            if (Validate::hasKey($request, $key)) {
                $touched = true;
                $column = $this->columnFor($key);
                $station->{$column} = Validate::optionalString($request->input($key), $label, $max);
            }
        }
        if (Validate::hasKey($request, 'isActive')) {
            $touched = true;
            $station->is_active = Validate::boolean($request->input('isActive'), true);
        }

        if (Validate::hasKey($request, 'latitude') || Validate::hasKey($request, 'longitude')) {
            $touched = true;
            ['latitude' => $latitude, 'longitude' => $longitude] = Validate::coordinates(
                Validate::hasKey($request, 'latitude') ? $request->input('latitude') : $station->latitude,
                Validate::hasKey($request, 'longitude') ? $request->input('longitude') : $station->longitude,
                required: false,
            );
            $station->latitude = $latitude;
            $station->longitude = $longitude;

            // Supplying coordinates completes a pending record: publish it.
            if ($latitude !== null) {
                $station->is_pending = false;
                $station->location_confidence = $this->confidenceOrApproximate($request->input('locationConfidence'));
            } else {
                $station->is_pending = true;
                $station->location_confidence = 'pending';
            }
        } elseif (Validate::hasKey($request, 'locationConfidence')) {
            $touched = true;
            $value = (string) $request->input('locationConfidence');
            if (! in_array($value, Station::CONFIDENCE, true)) {
                throw HttpError::badRequest('locationConfidence must be confirmed, approximate or pending.');
            }
            $station->location_confidence = $value;
        }

        if (! $touched) {
            throw HttpError::badRequest('No fields to update.');
        }

        $station->save();

        return response()->json(['data' => $station->fresh(['brand', 'prices'])->toApiArray()]);
    }

    public function destroy(string $id): JsonResponse
    {
        $stationId = Validate::id($id, 'station id');
        if (! Station::whereKey($stationId)->exists()) {
            throw HttpError::notFound('Station not found.');
        }

        // Prices and their history rows cascade at the database level; the
        // explicit transaction keeps that atomic with the station delete.
        DB::transaction(fn () => Station::whereKey($stationId)->delete());

        return response()->json(['data' => ['ok' => true, 'id' => $stationId]]);
    }

    /**
     * Replaces the price set for a station.
     *
     * The set is authoritative: any fuel type missing from the request is
     * deleted, so removing a row in the editor really removes it. Case-only
     * spelling changes are treated as the same fuel type rather than as a
     * delete plus an insert, which is what the UNIQUE (station_id, fuel_type)
     * key would otherwise turn into a duplicate row.
     */
    public function savePrices(Request $request, string $id): JsonResponse
    {
        $stationId = Validate::id($id, 'station id');

        /*
         * Ownership, checked here rather than in RequireStaff because it
         * depends on the station id in this URL: an admin may price any
         * station, a station_manager only the one they are assigned to. This
         * runs server-side on every call - public/js/map.js hides the editor
         * on every other station's popup, but that is presentation, not
         * permission. RequireStaff has already proved the caller is signed in
         * with a dashboard role. A manager with no station (station_id null,
         * or one whose station was deleted) fails the comparison against every
         * id, so an unassigned account prices nothing.
         */
        $user = $request->attributes->get('auth_user');
        if (! $user->isAdmin() && (int) $user->station_id !== $stationId) {
            throw HttpError::forbidden('You can only edit prices for the station assigned to you.');
        }

        $station = Station::find($stationId);
        if (! $station) {
            throw HttpError::notFound('Station not found.');
        }

        $input = $request->input('prices');
        if (! is_array($input) || $input === []) {
            throw HttpError::badRequest(
                'Send a non-empty `prices` array, e.g. [{ "fuelType": "Gasoline", "pricePerLiter": 72.50 }].'
            );
        }

        $effectiveAt = Validate::optionalString($request->input('effectiveAt'), 'effectiveAt', 40)
            ?? now()->utc()->format('Y-m-d H:i:s');

        $rows = [];
        $seen = [];
        foreach ($input as $p) {
            $fuelType = Validate::requiredString(is_array($p) ? ($p['fuelType'] ?? null) : null, 'fuelType', 80);

            $raw = is_array($p) ? ($p['pricePerLiter'] ?? null) : null;
            if (! is_numeric($raw)) {
                throw HttpError::badRequest("Price for \"{$fuelType}\" must be a number of 0 or more.");
            }
            $price = (float) $raw;
            if ($price < 0) {
                throw HttpError::badRequest("Price for \"{$fuelType}\" must be a number of 0 or more.");
            }
            if ($price > 10000) {
                throw HttpError::badRequest("Price for \"{$fuelType}\" looks wrong (max 10000).");
            }

            $key = mb_strtolower($fuelType);
            if (isset($seen[$key])) {
                throw HttpError::badRequest("Duplicate fuel type \"{$fuelType}\".");
            }
            $seen[$key] = true;

            $rows[] = ['fuelType' => $fuelType, 'key' => $key, 'price' => $price];
        }

        $username = $request->attributes->get('auth_user')->username;

        DB::transaction(function () use ($stationId, $rows, $effectiveAt, $username) {
            /*
             * Snapshot the current prices BEFORE anything is deleted.
             *
             * The stale-spelling cleanup below removes the row holding the
             * previous value when only the capitalisation changed, so reading
             * it afterwards found nothing and every case-only edit was logged
             * as a jump from NULL. Keyed by the lower-cased fuel type to match
             * the case-blind comparisons used here.
             */
            $previous = [];
            foreach (FuelPrice::where('station_id', $stationId)->get() as $existing) {
                $previous[mb_strtolower($existing->fuel_type)] = (float) $existing->price_per_liter;
            }

            $kept = array_column($rows, 'key');

            // (a) Removals: fuel types the admin deleted in the editor.
            FuelPrice::where('station_id', $stationId)
                ->whereNotIn(DB::raw('lower(fuel_type)'), $kept)
                ->delete();

            // (b) Stale spellings of a fuel type that is still present. The
            // unique key is on the raw text, so without this "Gasoline" and a
            // later save spelling it "GASOLINE" would become two rows for one
            // fuel type. Clearing the variant first lets the upsert hit it.
            foreach ($rows as $row) {
                FuelPrice::where('station_id', $stationId)
                    ->whereRaw('lower(fuel_type) = ?', [$row['key']])
                    ->where('fuel_type', '!=', $row['fuelType'])
                    ->delete();
            }

            foreach ($rows as $row) {
                FuelPrice::updateOrCreate(
                    ['station_id' => $stationId, 'fuel_type' => $row['fuelType']],
                    [
                        'price_per_liter' => $row['price'],
                        'effective_at' => $effectiveAt,
                        'updated_at' => now(),
                    ],
                );

                $prevPrice = $previous[$row['key']] ?? null;
                if ($prevPrice === null || $prevPrice !== $row['price']) {
                    FuelPriceHistory::create([
                        'station_id' => $stationId,
                        'fuel_type' => $row['fuelType'],
                        'previous_price' => $prevPrice,
                        'new_price' => $row['price'],
                        'changed_at' => now(),
                        'changed_by' => $username,
                    ]);
                }
            }
        });

        return response()->json(['data' => $station->fresh(['brand', 'prices'])->toApiArray()]);
    }

    /** Last 100 price changes for a station, newest first. */
    public function priceHistory(string $id): JsonResponse
    {
        $stationId = Validate::id($id, 'station id');

        $rows = FuelPriceHistory::where('station_id', $stationId)
            ->orderByDesc('changed_at')
            ->orderByDesc('id')
            ->limit(100)
            ->get()
            ->map(fn (FuelPriceHistory $h) => $h->toApiArray())
            ->all();

        return response()->json(['data' => $rows]);
    }

    /** Validates a brand id and returns it, or null when absent. */
    private function resolveBrandId(mixed $input): ?int
    {
        if ($input === null || $input === '') {
            return null;
        }
        $id = Validate::id($input, 'brand');
        if (! Brand::whereKey($id)->exists()) {
            throw HttpError::badRequest('Unknown brand.');
        }

        return $id;
    }

    /** Confirmed/approximate, defaulting to approximate for unknown values. */
    private function confidenceOrApproximate(mixed $value): string
    {
        return in_array($value, ['confirmed', 'approximate'], true) ? $value : 'approximate';
    }

    /** camelCase body key -> snake_case column. */
    private function columnFor(string $key): string
    {
        return match ($key) {
            'contactPhone' => 'contact_phone',
            'contactEmail' => 'contact_email',
            'operatingHours' => 'operating_hours',
            'osmRef' => 'osm_ref',
            default => $key,
        };
    }
}

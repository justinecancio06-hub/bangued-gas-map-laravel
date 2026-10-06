<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\FuelPrice;
use App\Models\FuelPriceHistory;
use App\Models\Station;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Covers the admin CRUD, price and history rules, including the two bugs fixed
 * during the port:
 *
 *  1. price history must snapshot the real previous price before a variant is
 *     collapsed or deleted, otherwise previous_price was recorded as null;
 *  2. the model must read fuel_price_history, not the pluralised default
 *     fuel_price_histories.
 */
class AdminApiTest extends TestCase
{
    private const PASSWORD = 'admin123';

    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
        $this->actingAs(User::where('username', 'admin')->firstOrFail());
    }

    public function test_admin_station_list_includes_pending_and_inactive(): void
    {
        $response = $this->getJson('/api/admin/stations');

        $response->assertOk();
        $this->assertCount(Station::count(), $response->json('data'), 'admin sees every station');

        foreach ($response->json('data') as $station) {
            $this->assertIsBool($station['isPending']);
            $this->assertIsBool($station['isActive']);
        }
    }

    public function test_store_creates_a_pending_station_without_coordinates(): void
    {
        $brand = Brand::where('slug', 'shell')->firstOrFail();

        $response = $this->postJson('/api/admin/stations', [
            'name' => 'Unverified Lead',
            'brandId' => $brand->id,
            'notes' => 'Awaiting coordinates.',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('data.isPending', true)
            ->assertJsonPath('data.locationConfidence', 'pending')
            ->assertJsonPath('data.latitude', null);
    }

    public function test_store_rejects_an_unknown_brand(): void
    {
        $this->postJson('/api/admin/stations', [
            'name' => 'Nope',
            'brandId' => 9999,
        ])->assertStatus(400);
    }

    public function test_store_rejects_a_blank_name(): void
    {
        $brand = Brand::firstOrFail();

        $this->postJson('/api/admin/stations', [
            'name' => '   ',
            'brandId' => $brand->id,
        ])->assertStatus(400);
    }

    public function test_store_rejects_non_numeric_coordinates(): void
    {
        $brand = Brand::firstOrFail();

        $this->postJson('/api/admin/stations', [
            'name' => 'Bad Coords',
            'brandId' => $brand->id,
            'latitude' => 'not-a-number',
            'longitude' => 120.6,
        ])->assertStatus(400);
    }

    public function test_store_treats_blank_coordinates_as_pending(): void
    {
        $brand = Brand::firstOrFail();

        $response = $this->postJson('/api/admin/stations', [
            'name' => 'Blank Coords',
            'brandId' => $brand->id,
            'latitude' => '',
            'longitude' => '',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('data.isPending', true)
            ->assertJsonPath('data.latitude', null);
    }

    /**
     * Coordinates outside the Bangued bbox must be refused, otherwise a
     * mis-typed pin puts a station somewhere off the map.
     */
    public function test_store_rejects_coordinates_outside_the_boundary(): void
    {
        $brand = Brand::firstOrFail();

        $this->postJson('/api/admin/stations', [
            'name' => 'Manila',
            'brandId' => $brand->id,
            'latitude' => 14.5995,
            'longitude' => 120.9842,
        ])->assertStatus(400);
    }

    public function test_patch_touching_only_one_coordinate_keeps_the_other(): void
    {
        $station = Station::where('is_pending', true)->firstOrFail();
        $this->patchJson("/api/admin/stations/{$station->id}", [
            'latitude' => 17.5925,
            'longitude' => 120.6175,
        ])->assertOk();

        $response = $this->patchJson("/api/admin/stations/{$station->id}", [
            'latitude' => 17.5926,
        ]);

        $response->assertOk()
            ->assertJsonPath('data.latitude', 17.5926)
            ->assertJsonPath('data.longitude', 120.6175)
            ->assertJsonPath('data.isPending', false);
    }

    public function test_patch_returning_coordinates_marks_the_station_pending(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $response = $this->patchJson("/api/admin/stations/{$station->id}", [
            'latitude' => null,
            'longitude' => null,
        ]);

        $response->assertOk()
            ->assertJsonPath('data.isPending', true)
            ->assertJsonPath('data.locationConfidence', 'pending');
    }

    public function test_patch_rejects_an_empty_body(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->patchJson("/api/admin/stations/{$station->id}", [])->assertStatus(400);
    }

    public function test_patch_rejects_an_invalid_location_confidence(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->patchJson("/api/admin/stations/{$station->id}", [
            'locationConfidence' => 'vibes',
        ])->assertStatus(400);
    }

    public function test_patch_ignores_fields_absent_from_the_body(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();
        $before = $station->only(['name', 'address', 'barangay', 'notes']);

        $this->patchJson("/api/admin/stations/{$station->id}", [
            'address' => 'New Address',
        ])->assertOk();

        $station->refresh();
        $this->assertSame('New Address', $station->address);
        foreach (['name', 'barangay', 'notes'] as $untouched) {
            $this->assertSame($before[$untouched], $station->{$untouched});
        }
    }

    public function test_patch_unknown_station_is_404(): void
    {
        $this->patchJson('/api/admin/stations/999999', ['address' => 'x'])->assertNotFound();
    }

    public function test_destroy_removes_the_station_and_its_prices(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();
        $id = $station->id;

        $this->deleteJson("/api/admin/stations/{$id}")->assertOk();

        $this->assertDatabaseMissing('stations', ['id' => $id]);
        $this->assertDatabaseMissing('fuel_prices', ['station_id' => $id]);
    }

    public function test_save_prices_rejects_an_empty_list(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", ['prices' => []])
            ->assertStatus(400);
    }

    public function test_save_prices_stores_every_fuel_type(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $response = $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 72.5, 'effectiveAt' => '2026-10-01 08:00:00'],
                ['fuelType' => 'Diesel', 'pricePerLiter' => 65.75, 'effectiveAt' => '2026-10-01 08:00:00'],
            ],
        ]);

        $response->assertOk();
        $this->assertCount(2, FuelPrice::where('station_id', $station->id)->get());
    }

    /**
     * effectiveAt is a top-level field, not a per-price one: admin.js reads it
     * from the single datetime input and passes it alongside the price list.
     */
    public function test_save_prices_preserves_effective_at(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'effectiveAt' => '2026-09-01 06:30:00',
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 70],
            ],
        ])->assertOk();

        $price = FuelPrice::where('station_id', $station->id)->where('fuel_type', 'Gasoline')->firstOrFail();
        $this->assertStringStartsWith('2026-09-01 06:30:00', $price->effective_at);
    }

    public function test_duplicate_fuel_types_in_one_request_are_rejected(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        // "Gasoline" and "GASOLINE" are one fuel type, so sending both in a
        // single request is a 400 rather than a silent last-one-wins.
        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 70],
                ['fuelType' => 'GASOLINE', 'pricePerLiter' => 72],
            ],
        ])->assertStatus(400);
    }

    /**
     * The case-variant collapse fix: a later save that spells a fuel type
     * differently must update the single existing row rather than leaving the
     * stale spelling behind as a duplicate.
     */
    public function test_case_variants_collapse_to_a_single_row(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 70],
                ['fuelType' => 'Diesel', 'pricePerLiter' => 65],
            ],
        ])->assertOk();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'GASOLINE', 'pricePerLiter' => 72],
            ],
        ])->assertOk();

        $rows = FuelPrice::where('station_id', $station->id)->get();

        $this->assertCount(1, $rows, 'case variants must not duplicate');
        $this->assertSame('GASOLINE', $rows->first()->fuel_type);
        $this->assertDatabaseMissing('fuel_prices', [
            'station_id' => $station->id,
            'fuel_type' => 'Diesel',
        ]);
    }

    /**
     * Regression test for the history bug.
     *
     * The snapshot has to be taken before the stale-spelling cleanup deletes
     * the row holding the old value. Reading it afterwards found nothing, so a
     * case-only edit logged a spurious jump from null instead of the real
     * previous price.
     */
    public function test_case_only_edit_records_the_real_previous_price(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 70]],
        ])->assertOk();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'GASOLINE', 'pricePerLiter' => 72]],
        ])->assertOk();

        $edit = FuelPriceHistory::where('station_id', $station->id)
            ->where('new_price', 72)
            ->firstOrFail();

        $this->assertEqualsWithDelta(
            70.0,
            $edit->previous_price,
            0.001,
            'a case-only edit must record the real previous price, not null',
        );
    }

    /**
     * A genuinely new fuel type has no previous price, so null is the correct
     * value there - this pins the boundary of the fix above.
     */
    public function test_first_time_fuel_type_records_a_null_previous_price(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Kerosene', 'pricePerLiter' => 58]],
        ])->assertOk();

        $history = FuelPriceHistory::where('station_id', $station->id)
            ->where('fuel_type', 'Kerosene')
            ->firstOrFail();

        $this->assertNull($history->previous_price);
        $this->assertEqualsWithDelta(58.0, $history->new_price, 0.001);
    }

    public function test_removing_a_fuel_type_deletes_the_price_row(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 70],
                ['fuelType' => 'Diesel', 'pricePerLiter' => 65],
            ],
        ])->assertOk();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 70]],
        ])->assertOk();

        $this->assertDatabaseMissing('fuel_prices', [
            'station_id' => $station->id,
            'fuel_type' => 'Diesel',
        ]);
    }

    public function test_price_history_endpoint_returns_the_rows(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 70]],
        ])->assertOk();
        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 72]],
        ])->assertOk();

        $response = $this->getJson("/api/admin/stations/{$station->id}/price-history");

        $response->assertOk();
        $this->assertNotEmpty($response->json('data'));
    }

    /**
     * The keys the dashboard renders from. public/js/admin.js reads exactly
     * these names, so they are pinned here: the panel once shipped reading
     * snake_case (is_pending, price_lines, contact_phone) against this
     * camelCase API, which made every station render as "Inactive" with no
     * prices, opened the edit form blank and failed every save with 400.
     */
    public function test_station_payload_exposes_the_keys_the_dashboard_reads(): void
    {
        $station = $this->getJson('/api/admin/stations')->json('data.0');

        foreach ([
            'id', 'name', 'address', 'barangay', 'latitude', 'longitude',
            'contactPhone', 'contactEmail', 'operatingHours', 'notes',
            'isPending', 'isActive', 'locationConfidence', 'osmRef',
            'brand', 'prices', 'lastPriceUpdate',
        ] as $key) {
            $this->assertArrayHasKey($key, $station, "admin.js reads station.$key");
        }

        // admin.js looks a station up by brand slug and falls back to the
        // canonical /images/brands/<slug>.png path for the logo.
        $this->assertArrayHasKey('slug', $station['brand']);
        $this->assertArrayHasKey('sortOrder', $station['brand']);

        foreach ($station['prices'] as $price) {
            $this->assertArrayHasKey('fuelType', $price);
            $this->assertArrayHasKey('pricePerLiter', $price);
        }
    }

    /** admin.js feeds cfg.fuelTypes straight into the fuel-type datalist. */
    public function test_config_exposes_camel_case_fuel_types(): void
    {
        $response = $this->getJson('/api/admin/config');

        $response->assertOk();
        $this->assertIsArray($response->json('data.fuelTypes'));
        $this->assertNotEmpty($response->json('data.fuelTypes'));
        $this->assertArrayHasKey('stationBounds', $response->json('data'));
    }

    /**
     * The list endpoint serialises every station, and toApiArray() needs its
     * prices. Without eager loading that is one query per station, so the
     * dashboard's single request grew with the table.
     */
    public function test_station_list_does_not_query_prices_per_station(): void
    {
        $count = Station::count();
        $this->assertGreaterThan(1, $count, 'needs several stations to be meaningful');

        $queries = 0;
        DB::listen(function () use (&$queries) {
            $queries++;
        });

        $this->getJson('/api/admin/stations')->assertOk();

        // brands, prices and the station rows: a fixed count, not one per row.
        $this->assertLessThanOrEqual(
            $count,
            $queries,
            'query count must not scale with the number of stations',
        );
    }

    public function test_admin_config_exposes_the_fuel_types(): void
    {
        $response = $this->getJson('/api/admin/config');

        $response->assertOk();
        $this->assertNotEmpty($response->json('data.fuelTypes'));
    }

    /** The station modal's coordinate picker is a Google Map, so the dashboard
        needs the same key the public map boots with. */
    public function test_admin_config_carries_the_google_maps_key(): void
    {
        config(['bangued.google_maps.api_key' => 'test-maps-key']);

        $response = $this->getJson('/api/admin/config');

        $response->assertOk()->assertJsonPath('data.map.google.apiKey', 'test-maps-key');
    }

    public function test_unknown_api_endpoint_answers_json_404(): void
    {
        $this->getJson('/api/does-not-exist')
            ->assertNotFound()
            ->assertJsonPath('error.message', 'Endpoint not found.');
    }

    public function test_validation_errors_use_the_same_envelope_as_the_node_version(): void
    {
        $response = $this->postJson('/api/admin/stations', ['brandId' => Brand::firstOrFail()->id]);

        $response->assertStatus(400);
        $this->assertArrayHasKey('error', $response->json());
        $this->assertArrayHasKey('message', $response->json('error'));
    }
}

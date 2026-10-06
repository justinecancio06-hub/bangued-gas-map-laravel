<?php

namespace Tests\Feature;

use App\Models\FuelPrice;
use App\Models\Station;
use Tests\TestCase;

/**
 * Pins the lastPriceUpdate value the public map shows, including the reduce()
 * against null that the Node version got wrong.
 */
class LastPriceUpdateTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
    }

    public function test_last_price_update_is_null_before_any_price_is_saved(): void
    {
        // Freshly seeded stations carry no prices, so there is nothing to
        // reduce over and the per-station field must be null rather than a
        // crash or a bogus zero timestamp.
        $this->assertSame(0, FuelPrice::count());

        foreach ($this->getJson('/api/stations')->json('data') as $station) {
            $this->assertNull($station['lastPriceUpdate']);
        }
    }

    public function test_last_price_update_tracks_the_newest_price_save(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 72.5]],
        ])->assertOk();

        $saved = collect($this->getJson('/api/stations')->json('data'))
            ->firstWhere('id', $station->id);

        $this->assertNotNull($saved);
        $this->assertNotNull(
            $saved['lastPriceUpdate'],
            'a station with saved prices must report when they were last updated',
        );
        $this->assertStringStartsWith(
            substr((string) FuelPrice::where('station_id', $station->id)->max('updated_at'), 0, 16),
            $saved['lastPriceUpdate'],
        );
    }

    public function test_last_price_update_uses_the_newest_of_several_price_rows(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();

        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [
                ['fuelType' => 'Gasoline', 'pricePerLiter' => 72.5],
                ['fuelType' => 'Diesel', 'pricePerLiter' => 65.75],
            ],
        ])->assertOk();

        $reported = collect($this->getJson('/api/stations')->json('data'))
            ->firstWhere('id', $station->id)['lastPriceUpdate'];

        $newest = FuelPrice::where('station_id', $station->id)->max('updated_at');

        $this->assertStringStartsWith(substr((string) $newest, 0, 16), $reported);
        $this->assertNotNull($reported);
    }
}

<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Station;
use Tests\TestCase;

/**
 * Pins the public API contract that the Node version served and that the
 * frontend JS depends on.
 */
class PublicApiTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
    }

    public function test_meta_is_unwrapped_and_exposes_the_map_payload(): void
    {
        config(['bangued.google_maps.api_key' => 'test-maps-key']);

        $response = $this->getJson('/api/meta');

        $response->assertOk()->assertJsonStructure([
            'map' => [
                'center',
                'defaultZoom',
                'minZoom',
                'maxZoom',
                // [[minLat, minLon], [maxLat, maxLon]] - the two diagonal
                // corners google.maps.LatLngBounds is built from, not a flat
                // array.
                'maxBounds' => [0 => ['0', '1'], 1 => ['0', '1']],
                'boundary' => ['geometry' => ['coordinates']],
                'google' => ['apiKey', 'mapId', 'language'],
            ],
            'place',
            'fuelTypes',
        ]);

        $this->assertArrayNotHasKey('data', $response->json(), 'meta must stay unwrapped');
        $this->assertGreaterThan(3, count($response->json('map.boundary.geometry.coordinates.0')));
    }

    /**
     * The client cannot build the map without the key, so /api/meta has to
     * carry it. It ships in cleartext by design - a Google browser key is
     * public and protected by an HTTP referrer restriction - but a missing
     * key must arrive as an empty string rather than null or absent, so
     * GMaps.load() can reject with a useful message instead of injecting a
     * script tag with "key=undefined" in it.
     */
    public function test_meta_carries_the_google_maps_key(): void
    {
        config(['bangued.google_maps.api_key' => 'test-maps-key']);

        $this->assertSame('test-maps-key', $this->getJson('/api/meta')->json('map.google.apiKey'));
    }

    public function test_meta_reports_an_empty_google_maps_key_when_none_is_configured(): void
    {
        config(['bangued.google_maps.api_key' => null]);

        $google = $this->getJson('/api/meta')->json('map.google');

        $this->assertSame('', $google['apiKey']);
        $this->assertNull($google['mapId']);
    }

    /** The map clamps to Bangued, so the key never needs a zoom beyond 21 - the
        ceiling for Google's satellite and hybrid map types. */
    public function test_meta_max_zoom_stays_within_the_google_maps_ceiling(): void
    {
        $maxZoom = $this->getJson('/api/meta')->json('map.maxZoom');

        $this->assertGreaterThanOrEqual(config('bangued.map.defaultZoom'), $maxZoom);
        $this->assertLessThanOrEqual(21, $maxZoom);
    }

    /**
     * maxBounds is the boundary polygon padded by a margin, not a box fitted to
     * the stations: it is the viewport clamp, so stations must sit INSIDE it
     * but it is expected to be roomier than the tightest station extent.
     */
    public function test_meta_max_bounds_enclose_every_station(): void
    {
        $bounds = $this->getJson('/api/meta')->json('map.maxBounds');
        [$minLat, $minLon] = $bounds[0];
        [$maxLat, $maxLon] = $bounds[1];

        $this->assertGreaterThan($minLat, $maxLat);
        $this->assertGreaterThan($minLon, $maxLon);

        foreach (Station::where('is_pending', false)->get() as $station) {
            $this->assertGreaterThan($minLat, $station->latitude, 'station lat at or below maxBounds');
            $this->assertLessThan($maxLat, $station->latitude, 'station lat at or above maxBounds');
            $this->assertGreaterThan($minLon, $station->longitude, 'station lon at or below maxBounds');
            $this->assertLessThan($maxLon, $station->longitude, 'station lon at or above maxBounds');
        }
    }

    public function test_brands_list_is_wrapped_in_data(): void
    {
        $response = $this->getJson('/api/brands');

        $response->assertOk()->assertJsonStructure(['data' => [['id', 'name', 'colorPrimary', 'markerIcon', 'logoPath', 'sortOrder']]]);
        $this->assertCount(Brand::count(), $response->json('data'));
    }

    /**
     * C-Oil is a brand of its own, with its own row and slug, but the two share a
     * logo file. Pinned because the public map draws each station's marker from
     * this exact path: pointing C-Oil back at the non-existent c-oil.png left its
     * stations as a broken image on a pin.
     */
    public function test_c_oil_uses_the_shared_seaoil_logo(): void
    {
        $brand = Brand::where('slug', 'c-oil')->firstOrFail();

        $this->assertSame('/images/brands/seaoil.png', $brand->logo_path);

        $response = $this->getJson('/api/brands');
        $response->assertOk();

        $logos = collect($response->json('data'))->pluck('logoPath', 'slug');
        $this->assertSame('/images/brands/seaoil.png', $logos['c-oil']);
    }

    /**
     * Every advertised logo has to exist on disk, or its stations render as
     * broken-image pins. A missing file was invisible before: the API happily
     * returned the path it was given.
     */
    public function test_every_advertised_brand_logo_exists(): void
    {
        foreach (Brand::all() as $brand) {
            $this->assertFileExists(
                public_path(ltrim($brand->logo_path, '/')),
                "brand '{$brand->slug}' advertises a logo that is not on disk",
            );
        }
    }

    public function test_stations_list_omits_pending_and_returns_booleans(): void
    {
        $response = $this->getJson('/api/stations');

        $response->assertOk();
        $data = $response->json('data');

        $this->assertCount(Station::where('is_pending', false)->count(), $data);
        $this->assertNotContains(Station::where('is_pending', true)->count(), [0]);

        foreach ($data as $station) {
            $this->assertIsBool($station['isPending'], 'isPending must be a JSON boolean');
            $this->assertIsBool($station['isActive'], 'isActive must be a JSON boolean');
            $this->assertNotNull($station['latitude']);
            $this->assertNotNull($station['longitude']);
        }
    }

    public function test_inactive_stations_are_hidden_from_the_public_list(): void
    {
        $target = Station::where('is_pending', false)->first();
        $target->update(['is_active' => false]);

        $names = array_column($this->getJson('/api/stations')->json('data'), 'name');

        $this->assertNotContains($target->name, $names);
    }

    public function test_stations_are_sorted_by_brand_order_then_name(): void
    {
        $names = array_column($this->getJson('/api/stations')->json('data'), 'name');

        $this->assertSame(
            ['Shell', 'Caltex (Power V Caltex Service Station)', 'Seaoil #1'],
            $names,
        );
    }

    public function test_price_history_is_admin_only(): void
    {
        $station = Station::where('is_pending', false)->first();

        $this->getJson("/api/admin/stations/{$station->id}/price-history")->assertUnauthorized();
    }
}

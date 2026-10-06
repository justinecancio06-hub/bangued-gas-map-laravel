<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\FuelPrice;
use App\Models\Station;
use App\Models\User;
use Tests\TestCase;

/**
 * Covers the split introduced by the station_manager role.
 *
 * A station manager is a second dashboard role rather than a second admin: they
 * read the dataset and maintain fuel prices, which is the work they actually do,
 * but only for the one station their account is assigned to - who a station is,
 * whether it exists, and what any *other* station charges stays with an admin.
 * Both halves are asserted here because either one alone would pass even if the
 * other route group had been left on the wrong middleware - and public/js/map.js
 * only draws the Edit Prices button on the manager's own station on the strength
 * of exactly this rule, so a regression here would show up as a save that 403s.
 */
class StationManagerAccessTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
        $this->actingAs(User::where('username', 'manager')->firstOrFail());
    }

    /** The seeded manager's own station - the one station they may price. */
    private function managedStation(): Station
    {
        $manager = User::where('username', 'manager')->firstOrFail();

        return Station::findOrFail($manager->station_id);
    }

    public function test_the_seeded_station_manager_has_the_manager_role(): void
    {
        $user = User::where('username', 'manager')->firstOrFail();

        $this->assertSame(User::ROLE_STATION_MANAGER, $user->role);
        $this->assertTrue($user->isStationManager());
        $this->assertFalse($user->isAdmin());
        // Both dashboard roles are staff; the helper the middleware relies on.
        $this->assertTrue($user->isStaff());
        // Assigned, and to a station that actually exists - an unassigned
        // manager would be refused by savePrices() on every id in the map.
        $this->assertNotNull($user->station_id);
        $this->assertSame('Blu Gas Station #1', $user->station->name);
    }

    public function test_a_station_manager_can_read_the_station_list(): void
    {
        $response = $this->getJson('/api/admin/stations');

        $response->assertOk();
        $this->assertCount(Station::count(), $response->json('data'));
    }

    public function test_a_station_manager_can_read_the_brand_list_and_config(): void
    {
        $this->getJson('/api/admin/brands')->assertOk();
        $this->getJson('/api/admin/config')
            ->assertOk()
            ->assertJsonPath('data.map.google.apiKey', config('bangued.google_maps.api_key'));
    }

    public function test_a_station_manager_can_save_prices_for_their_own_station(): void
    {
        $station = $this->managedStation();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 71.5]],
        ])->assertOk();

        $this->assertDatabaseHas('fuel_prices', [
            'station_id' => $station->id,
            'fuel_type' => 'Gasoline',
            'price_per_liter' => 71.5,
        ]);
    }

    /**
     * The whole point of the assignment: the same signed-in session, the same
     * route, the same payload - only the station in the URL differs, and the
     * server must refuse it. public/js/map.js hides the editor everywhere
     * else, but this is the check that actually holds when it does not.
     */
    public function test_a_station_manager_cannot_save_prices_for_another_station(): void
    {
        $own = $this->managedStation();
        $other = Station::where('is_pending', false)
            ->where('id', '!=', $own->id)
            ->firstOrFail();

        $before = FuelPrice::where('station_id', $other->id)
            ->pluck('price_per_liter', 'fuel_type')
            ->all();

        $this->putJson("/api/admin/stations/{$other->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 42.0]],
        ])->assertForbidden();

        $this->assertSame(
            $before,
            FuelPrice::where('station_id', $other->id)
                ->pluck('price_per_liter', 'fuel_type')
                ->all(),
            'a refused save must leave the other station\'s prices untouched',
        );
    }

    /**
     * station_id is ON DELETE SET NULL, so a manager whose station was deleted
     * - or one never assigned - keeps their account but prices nothing. Null
     * has to fail every comparison rather than read as "matches anything".
     */
    public function test_an_unassigned_station_manager_cannot_price_any_station(): void
    {
        $station = $this->managedStation();
        User::where('username', 'manager')->update(['station_id' => null]);

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 42.0]],
        ])->assertForbidden();
    }

    public function test_a_station_manager_can_read_price_history(): void
    {
        $station = $this->managedStation();

        $this->putJson("/api/admin/stations/{$station->id}/prices", [
            'prices' => [['fuelType' => 'Gasoline', 'pricePerLiter' => 70]],
        ])->assertOk();

        $this->getJson("/api/admin/stations/{$station->id}/price-history")
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }

    /**
     * GET /api/me is the public map's session probe: flat (no "data" envelope,
     * as documented on the route), carrying the assignment the inline editor is
     * drawn from, and a 401 a visitor reads as "no edit controls anywhere".
     */
    public function test_the_me_probe_reports_the_managers_assignment(): void
    {
        $station = $this->managedStation();

        $this->getJson('/api/me')
            ->assertOk()
            ->assertExactJson([
                'id' => User::where('username', 'manager')->firstOrFail()->id,
                'username' => 'manager',
                'role' => User::ROLE_STATION_MANAGER,
                'station_id' => $station->id,
            ]);
    }

    public function test_the_me_probe_reports_nothing_for_a_guest(): void
    {
        auth()->logout();

        $this->getJson('/api/me')->assertUnauthorized();
    }

    /**
     * The dashboard is an admin's page; a manager's work happens on the public
     * map, where their station carries the editor. Serving them /admin would
     * only put them in front of controls the API answers with 403 - and /login
     * bounces them straight back here, so without this redirect they would be
     * stuck in a loop between two pages neither of which is theirs.
     */
    public function test_a_station_manager_is_redirected_away_from_the_admin_page(): void
    {
        $this->get('/admin')->assertRedirect('/');
    }

    public function test_an_admin_can_still_open_the_admin_page(): void
    {
        auth()->logout();
        $this->actingAs(User::where('username', 'admin')->firstOrFail());

        $this->get('/admin')->assertOk();
    }

    public function test_a_guest_still_gets_the_admin_page_to_probe_from(): void
    {
        auth()->logout();

        // The page itself runs the /api/auth/me probe and redirects visitors
        // to /login; serving it is what makes that client-side bounce work.
        $this->get('/admin')->assertOk();
    }

    public function test_a_station_manager_cannot_create_a_station(): void
    {
        $brandId = Brand::firstOrFail()->id;

        $this->postJson('/api/admin/stations', [
            'name' => 'Manager Addition',
            'brandId' => $brandId,
        ])->assertForbidden();

        $this->assertDatabaseMissing('stations', ['name' => 'Manager Addition']);
    }

    public function test_a_station_manager_cannot_update_a_station(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();
        $original = $station->name;

        $this->patchJson("/api/admin/stations/{$station->id}", [
            'name' => 'Renamed By Manager',
        ])->assertForbidden();

        $this->assertSame($original, $station->fresh()->name);
    }

    public function test_a_station_manager_cannot_move_a_station(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();
        $latitude = $station->latitude;

        // Coordinates live on the same update route as the name, so the geofence
        // the map relies on is admin-controlled too.
        $this->patchJson("/api/admin/stations/{$station->id}", [
            'latitude' => 17.5930,
            'longitude' => 120.6180,
        ])->assertForbidden();

        $this->assertSame($latitude, $station->fresh()->latitude);
    }

    public function test_a_station_manager_cannot_delete_a_station(): void
    {
        $station = Station::where('is_pending', false)->firstOrFail();
        $id = $station->id;

        $this->deleteJson("/api/admin/stations/{$id}")->assertForbidden();

        $this->assertDatabaseHas('stations', ['id' => $id]);
        $this->assertSame(
            0,
            FuelPrice::where('station_id', $id)->count(),
            'deleting a station as a manager must not take its prices either',
        );
    }

    public function test_a_guest_cannot_read_the_station_list(): void
    {
        auth()->logout();

        $this->getJson('/api/admin/stations')->assertUnauthorized();
    }

    public function test_an_admin_keeps_full_access(): void
    {
        auth()->logout();
        $this->actingAs(User::where('username', 'admin')->firstOrFail());

        $station = Station::where('is_pending', false)->firstOrFail();
        $brandId = Brand::firstOrFail()->id;

        $this->postJson('/api/admin/stations', ['name' => 'Admin Addition', 'brandId' => $brandId])
            ->assertStatus(201);
        $this->patchJson("/api/admin/stations/{$station->id}", ['name' => 'Renamed By Admin'])
            ->assertOk();
        $this->deleteJson("/api/admin/stations/{$station->id}")->assertOk();

        $this->assertDatabaseMissing('stations', ['id' => $station->id]);
    }

    /**
     * Both roles are reachable from the session probe admin.js calls before it
     * renders anything. It redirects anyone else to /login, so a manager whose
     * role failed to survive the enum widening would be locked out of the
     * dashboard entirely rather than merely losing the station controls.
     */
    public function test_both_dashboard_roles_are_reported_by_the_session_probe(): void
    {
        foreach (['admin', 'manager'] as $username) {
            auth()->logout();
            $this->actingAs(User::where('username', $username)->firstOrFail());

            $this->getJson('/api/auth/me')
                ->assertOk()
                ->assertJsonPath('data.role', $username === 'manager'
                    ? User::ROLE_STATION_MANAGER
                    : User::ROLE_ADMIN);
        }
    }
}

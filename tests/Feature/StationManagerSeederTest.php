<?php

namespace Tests\Feature;

use App\Models\Brand;
use App\Models\Station;
use App\Models\User;
use Database\Seeders\StationManagerSeeder;
use Tests\TestCase;

/**
 * Covers StationManagerSeeder's one-manager-per-station contract.
 *
 * The seeded accounts are the documented way to try the manager role from the
 * public map, so their names, their stations and their stability across re-runs
 * are the contract: every station reachable, none left without a manager, none
 * given a second one, and no password or username shifting under an owner who
 * already changed it. The username rules are asserted against known values
 * (the derivation is the thing under test, so the expectations are written
 * out by hand rather than recomputed here).
 */
class StationManagerSeederTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
    }

    public function test_every_station_has_exactly_one_manager_account(): void
    {
        $managers = User::where('role', User::ROLE_STATION_MANAGER)->get();

        foreach (Station::pluck('id') as $stationId) {
            $this->assertSame(
                1,
                $managers->where('station_id', $stationId)->count(),
                "station #{$stationId} must have exactly one manager",
            );
        }

        $this->assertSame(
            0,
            User::where('role', User::ROLE_STATION_MANAGER)->whereNull('station_id')->count(),
            'no manager may be left without a station',
        );
    }

    public function test_manager_accounts_are_named_after_their_station(): void
    {
        $expected = [
            'manager' => 'Blu Gas Station #1',
            'manager_shell' => 'Shell',
            'manager_caltex1' => 'Caltex (Power V Caltex Service Station)',
            'manager_blugas2' => 'Blu Gas Station #2',
            'manager_petron' => 'Petron',
            'manager_seaoil' => 'Seaoil #1',
            'manager_coil' => 'C-Oil',
            'manager_phoenix' => 'Phoenix',
        ];

        foreach ($expected as $username => $stationName) {
            $user = User::where('username', $username)->firstOrFail();

            $this->assertSame(User::ROLE_STATION_MANAGER, $user->role, $username);
            $this->assertSame($stationName, $user->station->name, $username);
        }
    }

    public function test_reseeding_keeps_the_same_accounts_and_passwords(): void
    {
        $columns = ['id', 'username', 'display_name', 'role', 'station_id', 'password_hash'];
        $before = User::orderBy('id')->get($columns);

        $this->seed(StationManagerSeeder::class);

        $after = User::orderBy('id')->get($columns);

        $this->assertSame($before->toArray(), $after->toArray());
    }

    public function test_two_stations_sharing_a_name_get_numbered_usernames(): void
    {
        $original = Station::where('name', 'Petron')->firstOrFail();
        $petronBrandId = Brand::where('slug', 'petron')->firstOrFail()->id;

        Station::create(['name' => 'Petron', 'brand_id' => $petronBrandId]);
        Station::create(['name' => 'Petron', 'brand_id' => $petronBrandId]);

        $this->seed(StationManagerSeeder::class);

        $created = User::whereIn('username', ['manager_petron1', 'manager_petron2'])->get();
        $newStationIds = Station::where('name', 'Petron')
            ->where('id', '!=', $original->id)
            ->pluck('id')
            ->sort()
            ->values()
            ->all();

        $this->assertCount(2, $created);
        $this->assertSame($newStationIds, $created->pluck('station_id')->sort()->values()->all());
        $this->assertSame(
            $original->id,
            User::where('username', 'manager_petron')->firstOrFail()->station_id,
            'the original Petron keeps the account it already had',
        );
    }

    public function test_an_existing_username_held_by_another_account_gets_a_number(): void
    {
        User::where('username', 'manager_shell')->delete();
        $foreign = new User([
            'username' => 'manager_shell',
            'display_name' => 'Someone Else',
            'role' => User::ROLE_STATION_MANAGER,
            'station_id' => null,
        ]);
        $foreign->setPasswordHash('foreign-secret', (int) config('bangued.station_manager.bcrypt_rounds'));
        $foreign->save();

        $this->seed(StationManagerSeeder::class);

        $shell = Station::where('name', 'Shell')->firstOrFail();
        $derived = User::where('username', 'manager_shell2')->firstOrFail();

        $this->assertSame(User::ROLE_STATION_MANAGER, $derived->role);
        $this->assertSame($shell->id, $derived->station_id);
        $this->assertSame(1, User::where('station_id', $shell->id)->count());
        $this->assertNull($foreign->fresh()->station_id, 'the account holding the name is left alone');
    }

    public function test_an_unknown_station_name_falls_back_to_a_slugified_username(): void
    {
        $brandId = Brand::firstOrFail()->id;
        Station::create(['name' => 'Total (Phase II) Filling', 'brand_id' => $brandId]);

        $this->seed(StationManagerSeeder::class);

        $station = Station::where('name', 'Total (Phase II) Filling')->firstOrFail();
        $user = User::where('username', 'manager_totalphaseiifilling')->firstOrFail();

        $this->assertSame(User::ROLE_STATION_MANAGER, $user->role);
        $this->assertSame($station->id, $user->station_id);
    }
}

<?php

namespace Database\Seeders;

use App\Models\Station;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * Gives every station a station_manager account of its own.
 *
 * The config `manager` account keeps behaving exactly as before: it is pinned
 * to Blu Gas Station #1 and never deleted or re-passworded. Every other
 * station gets a demo account named after it - manager_shell, manager_caltex1,
 * manager_petron1, ... - so a visitor can sign in as the manager of any station
 * on the map and see the inline price editor scoped to that station.
 *
 * Idempotent by username: a re-run looks each name up, repairs role and
 * station if they drifted, and never touches a password the owner may have
 * already changed. A station that already has a manager keeps that account
 * even when a re-run would derive a different username for it (the station was
 * renamed, a duplicate name appeared), which is what holds the
 * one-manager-per-station shape together.
 *
 * BanguedSeeder calls this right after it seeds the dashboard accounts, so
 * `db:seed`, `bangued:seed` and the test suite all end up with a manager per
 * station. It also runs on its own:
 *
 *   php artisan db:seed --class=StationManagerSeeder
 */
class StationManagerSeeder extends Seeder
{
    /** The station the config `manager` account is pinned to, by name. */
    private const STATION_NAME = 'Blu Gas Station #1';

    /**
     * Preferred username slug per station name. Without this the full names
     * slugify to things like manager_caltexpowervcaltexservicestation; the map
     * keeps the demo accounts short, and it keeps the two Caltex rows (and any
     * future pair of same-brand stations) apart. Names not listed here fall
     * back to slugify().
     *
     * @var array<string, string>
     */
    private const PREFERRED_SLUGS = [
        'Shell' => 'shell',
        'Caltex (Power V Caltex Service Station)' => 'caltex1',
        'Caltex (AFM Platinum Gas Station)' => 'caltex2',
        self::STATION_NAME => 'blugas1',
        'Blu Gas Station #2' => 'blugas2',
        'Petron' => 'petron',
        'Seaoil #1' => 'seaoil',
        'C-Oil' => 'coil',
        'Phoenix' => 'phoenix',
    ];

    public function run(): void
    {
        $this->repairAdminRole();
        $this->seedManager();
        [$created, $updated] = $this->seedStationManagers();
        $this->report($created, $updated);
    }

    /**
     * The existing admin keeps admin. role is nullable as of the station_id
     * migration, so an account nulled out at some point is pinned back rather
     * than left to fail every isStaff() check on the way into the dashboard.
     */
    private function repairAdminRole(): void
    {
        $username = (string) config('bangued.admin.username');
        $admin = User::where('username', $username)->first();

        if ($admin && $admin->role === null) {
            $admin->role = User::ROLE_ADMIN;
            $admin->save();
            $this->command?->info("  admin user '{$username}': role set to admin.");
        }
    }

    private function seedManager(): void
    {
        $station = Station::where('name', self::STATION_NAME)->first();
        if (! $station) {
            $this->command?->warn(
                '  station_manager skipped: "'.self::STATION_NAME.'" not found - seed the Bangued dataset first.',
            );

            return;
        }

        $config = config('bangued.station_manager');
        $user = User::where('username', $config['username'])->first();

        if (! $user) {
            $user = new User([
                'username' => $config['username'],
                'display_name' => $config['display_name'],
                'role' => $config['role'],
                'station_id' => $station->id,
            ]);
            $user->setPasswordHash($config['password'], (int) $config['bcrypt_rounds']);
            $user->save();

            $this->command?->info(
                "  station_manager user: {$config['username']} (bcrypt, {$config['bcrypt_rounds']} rounds)",
            );
            $this->command?->info('    password: '.$config['password']);
            $this->command?->info('    station : '.self::STATION_NAME." (#{$station->id})");
            $this->command?->warn('    !! Change this before deploying to a public server.');

            return;
        }

        // Existing account: the password is left exactly as it is (it may have
        // been changed in the dashboard already), but this seeder's whole job
        // is to make `manager` the manager of Blu Gas Station #1, so role and
        // station are re-pinned to that on every run.
        $user->role = $config['role'];
        $user->station_id = $station->id;
        $user->save();

        $this->command?->info(
            "  {$config['role']} user '{$config['username']}' assigned to ".self::STATION_NAME." (#{$station->id}).",
        );
    }

    /**
     * Creates one account for every station that does not have a manager yet.
     *
     * @return array{0: int, 1: int} the number of accounts created and the
     *                               number of existing ones repaired
     */
    private function seedStationManagers(): array
    {
        $config = config('bangued.station_manager');

        // Every station whose account already exists is off limits: it keeps
        // its username as-is, and only a nulled-out role is repaired. This is
        // also what holds the config `manager` on Blu Gas Station #1.
        $managed = User::whereNotNull('station_id')
            ->get()
            ->filter(fn (User $user) => ! $user->isAdmin())
            ->keyBy('station_id');

        $updated = 0;
        foreach ($managed as $user) {
            if ($user->role !== User::ROLE_STATION_MANAGER) {
                $user->role = User::ROLE_STATION_MANAGER;
                $user->save();
                $updated++;
            }
        }

        $targets = Station::orderBy('id')
            ->get()
            ->reject(fn (Station $station) => $managed->has($station->id))
            ->values();

        $slugs = $targets
            ->mapWithKeys(fn (Station $station) => [$station->id => $this->slugFor($station)])
            ->all();

        // Stations sharing a slug (two rows named "Petron") are numbered 1, 2,
        // ... in station-id order - but only among the ones being created, so
        // the numbering can never shift out from under an existing username.
        $groupSize = array_count_values($slugs);
        $seen = [];
        $created = 0;

        foreach ($targets as $station) {
            $slug = $slugs[$station->id];
            $base = 'manager_'.$slug;
            $seen[$slug] = ($seen[$slug] ?? 0) + 1;
            $n = $seen[$slug];
            $username = ($groupSize[$slug] ?? 0) > 1 ? $base.$n : $base;

            // The name is already taken by an unrelated account: append a
            // number, as manager_shell2, until it is free.
            while (User::where('username', $username)->exists()) {
                $username = $base.++$n;
            }

            $user = new User([
                'username' => $username,
                'display_name' => $config['display_name'],
                'role' => User::ROLE_STATION_MANAGER,
                'station_id' => $station->id,
            ]);
            $user->setPasswordHash($config['password'], (int) $config['bcrypt_rounds']);
            $user->save();
            $created++;

            $this->command?->info("  station_manager user: {$username} -> {$station->name} (#{$station->id})");
        }

        return [$created, $updated];
    }

    /** The station's preferred slug, or a slugified name for unknown ones. */
    private function slugFor(Station $station): string
    {
        if (isset(self::PREFERRED_SLUGS[$station->name])) {
            return self::PREFERRED_SLUGS[$station->name];
        }

        $slug = preg_replace('/[^a-z0-9]+/', '', strtolower($station->name));

        return $slug !== '' && $slug !== null ? $slug : 'station'.$station->id;
    }

    /**
     * The account table the seeded logins are verified against, followed by
     * the admin credentials - printed apart from the managers so the admin
     * dashboard login is not mistaken for one of the per-station accounts.
     *
     * @param  int  $created  accounts this run created
     * @param  int  $updated  existing accounts whose role was repaired
     */
    private function report(int $created, int $updated): void
    {
        $managers = User::where('role', User::ROLE_STATION_MANAGER)
            ->with('station:id,name')
            ->orderBy('id')
            ->get();

        $this->command?->newLine();
        $this->command?->info("station_manager accounts ({$created} created, {$updated} updated):");
        $this->command?->table(
            ['username', 'role', 'assigned station'],
            $managers->map(fn (User $user) => [
                $user->username,
                $user->role,
                $user->station?->name ?? '(unassigned)',
            ])->all(),
        );

        $assigned = $managers->pluck('station_id')->filter()->all();
        $unmanaged = Station::whereNotIn('id', $assigned)->pluck('name');

        if ($unmanaged->isEmpty()) {
            $this->command?->info('  every station has a manager account.');
        } else {
            foreach ($unmanaged as $name) {
                $this->command?->warn("  NO manager assigned: {$name}");
            }
        }

        $admin = config('bangued.admin');
        $this->command?->newLine();
        $this->command?->info('admin dashboard account (separate from the managers above):');
        $this->command?->info("  {$admin['username']} / {$admin['password']}  ->  /admin");
        $this->command?->warn('  !! Change the seeded passwords before deploying to a public server.');
    }
}

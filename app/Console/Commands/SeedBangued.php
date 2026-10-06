<?php

namespace App\Console\Commands;

use Database\Seeders\BanguedSeeder;
use Illuminate\Console\Command;

/**
 * Replaces `npm run seed` / `npm run reset` from the Node version.
 *
 *   php artisan bangued:seed              load brands, stations and the dashboard accounts
 *   php artisan bangued:seed --force      wipe those tables first, then reload
 *   php artisan bangued:seed --demo-prices  also load FICTIONAL fuel prices
 */
class SeedBangued extends Command
{
    protected $signature = 'bangued:seed
        {--force : Delete stations, prices, price history and brands first}
        {--demo-prices : Also load clearly-labelled FICTIONAL fuel prices}';

    protected $description = 'Seed Refuelio - Bangued\'s Gas Station Hub with brands, stations and dashboard users';

    public function handle(): int
    {
        $this->components->info('Seeding Refuelio - Bangued\'s Gas Station Hub');

        if ($this->option('force')) {
            // Child rows first: fuel_prices and fuel_price_history cascade from
            // stations, but being explicit keeps the intent obvious and works
            // even if the FK cascade is ever dropped.
            $this->call('db:wipe', ['--database' => config('database.default'), '--drop-views' => false]);

            $this->components->info('Dropped all tables; re-running migrations.');
            $this->call('migrate', ['--force' => true]);
        }

        // Resolved through the container so the seeder's $demoPrices flag is
        // set on the instance that actually runs. db:seed exposes no
        // --demo-prices option to forward, and $this->call() with a class name
        // would ignore the extra argument, so the flag is passed via a public
        // property on the seeder instead.
        $seeder = resolve(BanguedSeeder::class);
        $seeder->setContainer(app());
        // Without this the seeder's $this->command is null, so every
        // $this->command?->info() summary line is silently dropped.
        $seeder->setCommand($this);
        $seeder->demoPrices = (bool) $this->option('demo-prices');
        $seeder->__invoke();

        $this->newLine();
        $this->components->info('Start the app with: php artisan serve');
        $this->components->info('  Public map  : http://localhost:8000/');
        $this->components->info('  Admin login : http://localhost:8000/login');
        $this->components->info('  Dashboard   : http://localhost:8000/admin');

        return self::SUCCESS;
    }
}

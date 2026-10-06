<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

/**
 * `php artisan db:seed` seeds the Bangued data set. The Laravel default test
 * user is deliberately gone: this app has exactly one kind of account, an
 * admin, created by BanguedSeeder with a bcrypt hash and a username the admin
 * form can actually sign in with.
 */
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call(BanguedSeeder::class);
    }
}

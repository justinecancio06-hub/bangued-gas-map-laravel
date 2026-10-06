<?php

namespace Tests;

use Database\Seeders\BanguedSeeder;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    /**
     * The suite runs against an in-memory SQLite database, so no test database
     * is migrated for us and the seeder fails with "no such table: brands".
     */
    protected function setUp(): void
    {
        parent::setUp();

        $this->artisan('migrate', ['--force' => true])->run();
    }

    /**
     * Seeds brands, stations and the admin user into the test database before
     * each test, mirroring `php artisan bangued:seed` without demo prices.
     */
    protected function seedBanguedData(): void
    {
        $this->seed(BanguedSeeder::class);
    }
}

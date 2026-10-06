<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Widens users.role from admin-only to admin + station_manager.
 *
 * `change()` is used rather than a fresh column because role carries a CHECK
 * constraint (SQLite) / a native ENUM (MySQL) listing the allowed values, and
 * both are defined on the column itself. Every modifier the column had is
 * restated: change() rebuilds the definition from what this migration passes,
 * and anything left off is dropped.
 */
return new class extends Migration
{
    /** Deliberately literal, not read from the User model: a migration has to
     *  describe the schema as it was at this point in history, not whatever the
     *  model says today. */
    private const ROLES = ['admin', 'station_manager'];

    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->enum('role', self::ROLES)->default('admin')->change();
        });
    }

    public function down(): void
    {
        // Narrowing the constraint again would fail outright on a station_manager
        // row, so they are removed first rather than leaving the rollback stuck
        // halfway through with a half-applied constraint.
        DB::table('users')->where('role', 'station_manager')->delete();

        Schema::table('users', function (Blueprint $table) {
            $table->enum('role', ['admin'])->default('admin')->change();
        });
    }
};

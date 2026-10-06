<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Ties each dashboard account to a station, so a station_manager can be
 * limited server-side to pricing the one station they run.
 *
 * station_id is a nullable FK with ON DELETE SET NULL: dropping a station must
 * not drop the account that signs in to manage it, it just leaves them without
 * an assignment (which the price editor then refuses to write for - see
 * AdminApiController::savePrices()).
 *
 * role is restated only to become nullable, keeping the enum values ('admin',
 * 'station_manager') that AuthenticationTest asserts at the database level.
 *
 * Both changes ride in ONE Schema::table() call on purpose. SQLite has no
 * ALTER COLUMN, so Laravel rebuilds the whole table for any change - and a
 * rebuild re-emits UNCHANGED columns from pragma reflection, whose `type`
 * reports `role` as plain `varchar`, silently dropping the enum's CHECK
 * constraint. Changing the column in the same blueprint as the new FK means
 * `role` is a changed column, so it recompiles from the fluent definition and
 * the check comes back with it. (Verified: a second Schema::table for the FK
 * alone loses the constraint and leaves 'user' insertable.)
 */
return new class extends Migration
{
    /** Deliberately literal, matching the enum written by the widening migration. */
    private const ROLES = ['admin', 'station_manager'];

    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->enum('role', self::ROLES)->default('admin')->nullable()->change();
            $table->foreignId('station_id')->nullable()->constrained('stations')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropConstrainedForeignId('station_id');
        });

        // The column becomes NOT NULL below, so any account left without a role
        // is pinned to admin first rather than failing the rebuild halfway.
        DB::table('users')->whereNull('role')->update(['role' => 'admin']);

        Schema::table('users', function (Blueprint $table) {
            $table->enum('role', self::ROLES)->default('admin')->change();
        });
    }
};

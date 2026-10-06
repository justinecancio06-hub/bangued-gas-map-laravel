<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Direct port of the SQLite schema in the Node version (src/db/schema.sql).
 * Column names are kept identical so the two apps stay interchangeable and the
 * existing MySQL dump (sql/schema.mysql.sql) still applies.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('username', 60)->unique();
            $table->string('password_hash');
            $table->string('display_name')->nullable();
            // Only one role exists in the schema, kept as a CHECK-compatible enum
            // so future roles stay a deliberate, reviewed change.
            $table->enum('role', ['admin'])->default('admin');
            $table->timestamp('created_at')->useCurrent();
            $table->timestamp('last_login_at')->nullable();
        });

        Schema::create('brands', function (Blueprint $table) {
            $table->id();
            $table->string('slug', 60)->unique();
            $table->string('name');
            $table->string('color_primary', 32);
            $table->string('color_secondary', 32)->nullable();
            $table->string('marker_icon', 40)->default('pump');
            // Site-root-relative path to the brand logo served out of
            // public/images/brands. NULL means "no logo file" and the UI falls
            // back to the coloured pump chip.
            $table->string('logo_path')->nullable();
            $table->integer('sort_order')->default(100);
            $table->timestamp('created_at')->useCurrent();
        });

        Schema::create('stations', function (Blueprint $table) {
            $table->id();
            // RESTRICT, matching the SQLite schema: a brand cannot be deleted
            // while stations still point at it.
            $table->foreignId('brand_id')->constrained('brands')->restrictOnDelete();
            $table->string('name', 160);
            $table->string('address', 400)->nullable();
            $table->string('barangay', 120)->nullable();
            // double, not decimal: the Node schema used SQLite REAL, and seeded
            // coordinates carry 14 significant digits (e.g. 17.60059519068887).
            // decimal(10,7) would silently round those to ~1 cm.
            $table->double('latitude')->nullable();
            $table->double('longitude')->nullable();
            $table->string('contact_phone', 60)->nullable();
            $table->string('contact_email', 160)->nullable();
            $table->string('operating_hours', 200)->nullable();
            $table->text('notes')->nullable();
            // is_pending = record exists but coordinates/details are not yet
            // confirmed. Pending stations are excluded from the public map.
            $table->boolean('is_pending')->default(false);
            $table->boolean('is_active')->default(true);
            // confirmed = verified by the owner; approximate = derived from a
            // place centroid; pending = no usable coordinates yet.
            $table->enum('location_confidence', ['confirmed', 'approximate', 'pending'])
                ->default('pending');
            $table->string('osm_ref', 60)->nullable();
            $table->timestamps();
        });

        Schema::create('fuel_prices', function (Blueprint $table) {
            $table->id();
            // Prices cascade when a station is deleted.
            $table->foreignId('station_id')->constrained()->cascadeOnDelete();
            $table->string('fuel_type', 80);
            // double for the same reason as latitude: keeps a peso-per-litre
            // value exactly as typed rather than re-rounding it on every read.
            $table->double('price_per_liter');
            $table->timestamp('effective_at');
            $table->timestamp('updated_at');
            // Mirrors UNIQUE (station_id, fuel_type) in the SQLite schema.
            $table->unique(['station_id', 'fuel_type']);
        });

        Schema::create('fuel_price_history', function (Blueprint $table) {
            $table->id();
            $table->foreignId('station_id')->constrained()->cascadeOnDelete();
            $table->string('fuel_type', 80);
            $table->double('previous_price')->nullable();
            $table->double('new_price');
            $table->timestamp('changed_at');
            $table->string('changed_by')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('fuel_price_history');
        Schema::dropIfExists('fuel_prices');
        Schema::dropIfExists('stations');
        Schema::dropIfExists('brands');
        Schema::dropIfExists('users');
    }
};

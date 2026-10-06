<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Session storage for the admin login cookie (SESSION_DRIVER=database).
 *
 * The Node version kept sessions in a signed JWT cookie and needed no table.
 * Laravel stores the session server-side and puts only an opaque id in the
 * cookie, which invalidates sessions on logout for real rather than asking the
 * client to drop a token.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sessions', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->foreignId('user_id')->nullable()->index();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->longText('payload');
            $table->integer('last_activity')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sessions');
    }
};

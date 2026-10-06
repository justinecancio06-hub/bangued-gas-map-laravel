<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

/**
 * A signed-in dashboard account. The Node version authenticated with a JWT
 * cookie (bgm_session); here Laravel's encrypted session cookie replaces it, so
 * the token plumbing disappears while the observable behaviour stays the same:
 * httpOnly cookie, SameSite=Lax, 12 h lifetime, cleared on logout.
 *
 * Two roles exist. An admin owns the dataset: they can create, edit and delete
 * stations, and price any of them. A station manager only maintains fuel
 * prices, and only for the station station_id points at. The split is enforced
 * by App\Http\Middleware\RequireStaff (either role),
 * App\Http\Middleware\RequireAdmin (admin only) and the ownership check in
 * AdminApiController::savePrices(), never just in the controllers.
 */
class User extends Authenticatable
{
    use HasFactory, Notifiable;

    public const ROLE_ADMIN = 'admin';

    public const ROLE_STATION_MANAGER = 'station_manager';

    /**
     * Every value users.role accepts, in the order the database CHECK constraint
     * lists them. The migration writes the same list literally rather than
     * reading it from here, because a migration has to pin the schema as it was.
     *
     * @var list<string>
     */
    public const ROLES = [self::ROLE_ADMIN, self::ROLE_STATION_MANAGER];

    // Matches the SQLite schema: created_at + last_login_at, no updated_at.
    // Without this Eloquent writes an updated_at column that does not exist.
    public $timestamps = false;

    protected $fillable = [
        'username',
        'password_hash',
        'display_name',
        'role',
        'station_id',
        'last_login_at',
    ];

    // The bcrypt hash must never leave the model by accident, and the password
    // is never set on this model: hashing happens through setPasswordHash().
    protected $hidden = ['password_hash'];

    protected function casts(): array
    {
        return [
            'last_login_at' => 'datetime',
            'created_at' => 'datetime',
        ];
    }

    /**
     * Passwords are stored as a bcrypt hash (cost 12, matching the Node app).
     * Written through an explicit method rather than the usual
     * $user->password = ... so a plain hash column can never be filled
     * directly from request input.
     */
    public function setPasswordHash(string $plain, int $rounds = 12): void
    {
        $this->attributes['password_hash'] = password_hash($plain, PASSWORD_BCRYPT, [
            'cost' => $rounds,
        ]);
    }

    public function checkPassword(string $plain): bool
    {
        return password_verify($plain, (string) $this->attributes['password_hash']);
    }

    /**
     * The station a station_manager is assigned to. Null for an admin, for an
     * account whose station was deleted (ON DELETE SET NULL), and for a
     * manager not yet placed - which the price editor treats as "may edit
     * nothing" rather than as "may edit anything".
     */
    public function station(): BelongsTo
    {
        return $this->belongsTo(Station::class);
    }

    public function isAdmin(): bool
    {
        return $this->role === self::ROLE_ADMIN;
    }

    public function isStationManager(): bool
    {
        return $this->role === self::ROLE_STATION_MANAGER;
    }

    /**
     * True for either dashboard role, i.e. anyone allowed past RequireStaff.
     * Admins count: they hold every permission a manager has.
     */
    public function isStaff(): bool
    {
        return in_array($this->role, self::ROLES, true);
    }

    /** Shape sent to the client by /api/auth/me and /api/auth/login. */
    public function toPublicArray(): array
    {
        return [
            'id' => $this->id,
            'username' => $this->username,
            'displayName' => $this->display_name,
            'role' => $this->role,
            'station_id' => $this->station_id,
        ];
    }

    /**
     * Dummy hash used to keep login timing uniform for unknown usernames.
     * A precomputed bcrypt hash is verified against when the username does not
     * exist, so a missing account and a wrong password take the same time and
     * cannot be told apart by response latency.
     */
    public static function dummyHash(): string
    {
        return '$2y$12$C6UzMDM.H6dfI/f/IKcEe.yrOZf6ZBqMKjEHWfPPQlL9Bp/aSpaRy';
    }
}

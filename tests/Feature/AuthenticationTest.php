<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Database\QueryException;
use Tests\TestCase;

/**
 * Pins the session behaviour the admin frontend depends on.
 */
class AuthenticationTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->seedBanguedData();
    }

    public function test_login_with_bad_credentials_is_rejected(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'wrong-password',
        ])->assertUnauthorized();
    }

    public function test_login_rejects_an_unknown_username(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'nobody',
            'password' => 'admin123',
        ])->assertUnauthorized();
    }

    public function test_login_succeeds_and_returns_the_user_profile(): void
    {
        $response = $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ]);

        $response->assertOk()->assertJsonPath('data.username', 'admin');
        $response->assertJsonMissingPath('data.password');
        $this->assertAuthenticated();
    }

    /**
     * The login page calls /api/auth/me to decide whether to redirect. A 401
     * there is normal for a signed-out visitor, and the frontend treats it as
     * "not signed in" rather than as an error.
     */
    public function test_me_is_401_when_signed_out(): void
    {
        $this->getJson('/api/auth/me')->assertUnauthorized();
    }

    public function test_me_returns_the_profile_once_signed_in(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        $this->getJson('/api/auth/me')
            ->assertOk()
            ->assertJsonPath('data.username', 'admin')
            ->assertJsonPath('data.role', 'admin');
    }

    public function test_logout_clears_the_session(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        $this->postJson('/api/auth/logout')->assertOk();

        $this->assertGuest();
        $this->getJson('/api/auth/me')->assertUnauthorized();
    }

    public function test_admin_endpoints_reject_anonymous_callers(): void
    {
        $this->getJson('/api/admin/stations')->assertUnauthorized();
        $this->getJson('/api/admin/brands')->assertUnauthorized();
        $this->getJson('/api/admin/config')->assertUnauthorized();
        $this->postJson('/api/admin/stations')->assertUnauthorized();
    }

    /**
     * Both schemas pin role to 'admin' (sql/schema.sql: CHECK (role IN
     * ('admin')), so a signed-in non-admin cannot exist and RequireAdmin's 403
     * branch is unreachable. This asserts the constraint itself is still in
     * place rather than testing a user that cannot be created.
     */
    public function test_schema_only_permits_the_admin_role(): void
    {
        $this->expectException(QueryException::class);

        User::create([
            'username' => 'viewer',
            'display_name' => 'Read Only',
            'role' => 'user',
            'password_hash' => password_hash('viewer123', PASSWORD_BCRYPT),
        ]);
    }

    public function test_change_password_requires_the_current_password(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        // 401, not 400: the Node version answered unauthorized() for a wrong
        // current password (src/routes/auth.js), and the frontend keys off the
        // status, so 401 is the parity-correct answer.
        $this->postJson('/api/auth/change-password', [
            'currentPassword' => 'not-the-password',
            'newPassword' => 'brand-new-password',
        ])->assertUnauthorized();
    }

    public function test_change_password_updates_the_stored_hash(): void
    {
        $this->postJson('/api/auth/login', [
            'username' => 'admin',
            'password' => 'admin123',
        ])->assertOk();

        $this->postJson('/api/auth/change-password', [
            'currentPassword' => 'admin123',
            'newPassword' => 'brand-new-password',
        ])->assertOk();

        $this->assertTrue(
            password_verify('brand-new-password', User::where('username', 'admin')->value('password_hash')),
        );
    }
}

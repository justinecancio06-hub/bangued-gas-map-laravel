<?php

namespace App\Http\Controllers;

use App\Http\HttpError;
use App\Http\Validate;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;

/**
 * Sign-in, sign-out, session probe and password change.
 *
 * Port of src/routes/auth.js. The Node version issued a JWT in a `bgm_session`
 * cookie; this uses Laravel's encrypted session cookie instead. The observable
 * contract is unchanged: httpOnly, SameSite=Lax, secure in production, cleared
 * on logout, and JSON errors of the same shape.
 */
class AuthController extends Controller
{
    /** Failed sign-ins allowed per username+IP before a 429. */
    private const MAX_ATTEMPTS = 8;

    /** Throttle window, matching the Node version's 10 minutes. */
    private const DECAY_SECONDS = 600;

    public function login(Request $request): JsonResponse
    {
        $username = Validate::requiredString($request->input('username'), 'Username', 60);
        $password = Validate::requiredString($request->input('password'), 'Password', 200);

        $key = $this->throttleKey($request, $username);

        if (RateLimiter::tooManyAttempts($key, self::MAX_ATTEMPTS)) {
            $seconds = RateLimiter::availableIn($key);
            $mins = (int) ceil($seconds / 60);
            throw HttpError::tooManyRequests("Too many failed attempts. Try again in {$mins} minute(s).");
        }

        $user = User::where('username', $username)->first();

        // Always run a hash comparison so a missing user and a wrong password
        // take the same time, which stops response latency from revealing which
        // accounts exist.
        $hash = $user?->password_hash ?? User::dummyHash();
        $ok = password_verify($password, $hash);

        if (! $user || ! $ok) {
            RateLimiter::hit($key, self::DECAY_SECONDS);

            throw HttpError::unauthorized('Invalid username or password.');
        }

        RateLimiter::clear($key);

        // Regenerate the session id on sign-in to prevent session fixation.
        Auth::login($user, remember: false);
        $request->session()->regenerate();

        $user->forceFill(['last_login_at' => now()])->save();

        return response()->json(['data' => $user->toPublicArray()]);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['data' => ['ok' => true]]);
    }

    /** Current user, or 401. */
    public function me(Request $request): JsonResponse
    {
        $user = $request->attributes->get('auth_user');

        if (! $user instanceof User) {
            return response()->json(['error' => ['message' => 'Not signed in.']], 401);
        }

        return response()->json(['data' => $user->toPublicArray()]);
    }

    /**
     * GET /api/me: the four fields the public map needs to decide whether to
     * offer inline price editing - who is signed in, in which role, and for
     * which station. Answered flat (no "data" envelope) as documented on the
     * route; 401 for a visitor with no session, which public/js/map.js folds
     * into "signed out, draw no edit controls".
     */
    public function whoami(Request $request): JsonResponse
    {
        $user = $request->attributes->get('auth_user');

        if (! $user instanceof User) {
            return response()->json(['error' => ['message' => 'Not signed in.']], 401);
        }

        return response()->json([
            'id' => $user->id,
            'username' => $user->username,
            'role' => $user->role,
            'station_id' => $user->station_id,
        ]);
    }

    public function changePassword(Request $request): JsonResponse
    {
        $user = $request->attributes->get('auth_user');

        if (! $user instanceof User) {
            throw HttpError::unauthorized();
        }

        $current = Validate::requiredString($request->input('currentPassword'), 'Current password');
        $next = Validate::requiredString($request->input('newPassword'), 'New password', 200);

        if (mb_strlen($next) < 8) {
            throw HttpError::badRequest('New password must be at least 8 characters.');
        }
        if ($next === $current) {
            throw HttpError::badRequest('New password must differ from the current one.');
        }

        if (! password_verify($current, (string) $user->password_hash)) {
            throw HttpError::unauthorized('Current password is incorrect.');
        }

        $user->setPasswordHash($next, (int) config('bangued.admin.bcrypt_rounds'));
        $user->save();

        return response()->json(['data' => ['ok' => true]]);
    }

    /**
     * Throttle bucket per IP + username pair, matching the Node version's
     * throttleKey(). Requested via the rate limiter rather than an in-process
     * Map, so the limit also holds across multiple PHP workers.
     */
    private function throttleKey(Request $request, string $username): string
    {
        return 'login:'.$request->ip().'|'.Str::lower($username);
    }
}

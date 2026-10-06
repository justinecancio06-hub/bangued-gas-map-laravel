<?php

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Attaches the signed-in user to the request when a valid session cookie is
 * present. Never rejects: read-only endpoints use it only to personalise the UI.
 *
 * Equivalent to the Node version's attachUser, which validated a JWT cookie.
 * Laravel's session middleware already decrypts and verifies the cookie, so all
 * that is left is loading the user. An expired or tampered cookie produces no
 * user and is treated as anonymous.
 */
class AttachUser
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user instanceof User) {
            // Re-read the role from the database rather than trusting anything
            // cached in the session payload, so a role change takes effect on
            // the next request instead of at the next sign-in.
            $request->attributes->set('auth_user', User::find($user->id));
        }

        return $next($request);
    }
}

<?php

namespace App\Http\Middleware;

use App\Http\HttpError;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Hard gate for the /api/admin routes.
 *
 * Equivalent to the Node version's requireAdmin. Returns JSON rather than
 * redirecting, because every caller is a fetch() in the dashboard: the page
 * reacts to 401 by bouncing to /login.
 */
class RequireAdmin
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->attributes->get('auth_user');

        if (! $user instanceof User) {
            throw HttpError::unauthorized('You must be signed in as an administrator.');
        }
        if (! $user->isAdmin()) {
            throw HttpError::forbidden('Administrator access required.');
        }

        return $next($request);
    }
}

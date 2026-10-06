<?php

namespace App\Http\Middleware;

use App\Http\HttpError;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Gate for the /api/admin routes that either dashboard role may use: reading
 * the station list, the brand list and the dashboard config, and editing fuel
 * prices.
 *
 * The sibling of RequireAdmin, which admits admins only. The two answer
 * identically for an anonymous visitor (401) and for a signed-in user with no
 * dashboard role (403), so the dashboard only has to recognise those two
 * statuses. Creating, editing and deleting stations stays admin-only.
 */
class RequireStaff
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->attributes->get('auth_user');

        if (! $user instanceof User) {
            throw HttpError::unauthorized('You must be signed in to the dashboard.');
        }
        if (! $user->isStaff()) {
            throw HttpError::forbidden('Dashboard access required.');
        }

        return $next($request);
    }
}

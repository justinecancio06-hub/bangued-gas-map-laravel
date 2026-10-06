<?php

use App\Http\Controllers\AdminApiController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\PublicApiController;
use App\Http\Middleware\RequireAdmin;
use App\Http\Middleware\RequireStaff;
use App\Models\Station;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API routes
|--------------------------------------------------------------------------
|
| Same paths, methods, auth rules and JSON envelopes as the Node version, so
| public/js/api.js and the rest of the frontend are unchanged:
|   - read endpoints answer { "data": ... }
|   - /api/meta is the one exception and answers unwrapped (map.js reads
|     meta.map directly)
|   - everything under /api/admin requires a signed-in dashboard user, and the
|     station CRUD half of it requires an admin rather than a station manager
|
*/

Route::get('/health', function () {
    return response()->json([
        'data' => [
            'ok' => true,
            'stations' => Station::count(),
            'uptimeSeconds' => (int) (microtime(true) - $_SERVER['REQUEST_TIME_FLOAT']),
        ],
    ]);
});

Route::get('/meta', [PublicApiController::class, 'meta']);
Route::get('/brands', [PublicApiController::class, 'brands']);
Route::get('/stations', [PublicApiController::class, 'stations']);
Route::get('/stations/{id}', [PublicApiController::class, 'station']);

Route::post('/auth/login', [AuthController::class, 'login']);
Route::post('/auth/logout', [AuthController::class, 'logout']);
Route::get('/auth/me', [AuthController::class, 'me']);
/*
 * Flat session probe for the public map: { id, username, role, station_id }.
 * Unlike every other read it is NOT wrapped in "data" - the map only needs
 * these four fields to decide whether to draw the inline price editor, and
 * /api/auth/me stays the richer dashboard probe. 401 when signed out, which
 * the map reads as "no edit controls".
 */
Route::get('/me', [AuthController::class, 'whoami']);
Route::post('/auth/change-password', [AuthController::class, 'changePassword']);

Route::middleware(RequireStaff::class)->prefix('admin')->group(function () {
    // Either dashboard role may read the dataset and maintain prices.
    Route::get('/stations', [AdminApiController::class, 'stations']);
    Route::get('/brands', [AdminApiController::class, 'brands']);
    Route::get('/config', [AdminApiController::class, 'config']);
    Route::put('/stations/{id}/prices', [AdminApiController::class, 'savePrices']);
    Route::get('/stations/{id}/price-history', [AdminApiController::class, 'priceHistory']);
});

/*
| Admin-only. A station manager maintains prices; who a station is, and
| whether it exists at all, stays with an admin. Nested inside the staff group
| so a manager is stopped by RequireAdmin rather than by a 404 for a route that
| only exists for admins.
 */
Route::middleware([RequireStaff::class, RequireAdmin::class])->prefix('admin')->group(function () {
    Route::post('/stations', [AdminApiController::class, 'store']);
    Route::patch('/stations/{id}', [AdminApiController::class, 'update']);
    Route::delete('/stations/{id}', [AdminApiController::class, 'destroy']);
});

/*
| Unknown API endpoints must answer 404 JSON, not Laravel's HTML error page -
| the frontend reads payload.error.message out of the response.
*/
Route::fallback(function () {
    return response()->json(['error' => ['message' => 'Endpoint not found.']], 404);
});

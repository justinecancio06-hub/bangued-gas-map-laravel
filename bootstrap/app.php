<?php

use App\Http\HttpError;
use App\Http\Middleware\AttachUser;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Validation\ValidationException;
use Illuminate\View\Middleware\ShareErrorsFromSession;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // No statefulApi() here: that helper pulls in Sanctum's
        // EnsureFrontendRequestsAreStateful, which this app does not use and
        // does not have installed. Admin actions are authorised by the encrypted
        // session cookie alone, so the api group only needs the session and
        // cookie middleware to read it - added below.
        $middleware->api(prepend: [
            EncryptCookies::class,
            StartSession::class,
            ShareErrorsFromSession::class,
            // Must come AFTER StartSession. Registered globally it ran first,
            // where the session was not started yet, so $request->user() was
            // always null and every /api/admin call answered 401 even with a
            // perfectly valid session cookie.
            AttachUser::class,
        ]);

        // The dashboard and login pages are plain fetch() clients that never
        // send a CSRF token, so token verification is disabled for the JSON API
        // only. The session cookie itself stays HttpOnly and SameSite=Lax, and
        // GET requests remain CSRF-exempt regardless.
        $middleware->validateCsrfTokens(except: [
            'api/*',
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        $exceptions->renderable(function (HttpError $e, Request $request) {
            return $e->toResponse();
        });

        $exceptions->renderable(function (ValidationException $e, Request $request) {
            if ($request->expectsJson() || $request->is('api/*')) {
                return response()->json(['error' => ['message' => $e->getMessage(), 'details' => $e->errors()]], 422);
            }

            return null;
        });

        // Malformed JSON in the request body - map to 400 to match the Node
        // version's "Malformed JSON body." response.
        $exceptions->renderable(function (PostTooLargeException $e, Request $request) {
            if ($request->expectsJson() || $request->is('api/*')) {
                return response()->json(['error' => ['message' => 'Request body too large.']], 413);
            }

            return null;
        });
        $exceptions->renderable(function (JsonException $e, Request $request) {
            if ($request->expectsJson() || $request->is('api/*')) {
                return response()->json(['error' => ['message' => 'Malformed JSON body.']], 400);
            }

            return null;
        });
        $exceptions->renderable(function (ModelNotFoundException $e, Request $request) {
            if ($request->expectsJson() || $request->is('api/*')) {
                return response()->json(['error' => ['message' => 'Not found.']], 404);
            }

            return null;
        });
    })->create();

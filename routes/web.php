<?php

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return response()->file(public_path('index.html'));
});

Route::get('/login', function () {
    return response()->file(public_path('login.html'));
});

/*
 * The dashboard belongs to admins. A station_manager signs in through the same
 * /login page but works on the public map, where their own station carries the
 * inline price editor - serving them this page would only put them in front of
 * controls the API refuses with a 403 anyway. Anonymous visitors still get the
 * page: it probes /api/auth/me itself and bounces them to /login.
 */
Route::get('/admin', function (Request $request) {
    $user = $request->user();

    if ($user instanceof User && $user->isStationManager()) {
        return redirect('/');
    }

    return response()->file(public_path('admin.html'));
});

<?php

/*
|--------------------------------------------------------------------------
| Refuelio - Bangued's Gas Station Hub
|--------------------------------------------------------------------------
|
| Everything about the map that the client and the API share. The boundary ring
| itself is not duplicated here - it is read from data/bangued-boundary.json and
| the limits below are derived from it, so replacing that one file with the
| official PSA/PhilGIS boundary needs no code change.
|
| station_bounds is intentionally NOT resolved at config-load time: config files
| are read by artisan before the application container exists (composer scripts,
| package discovery), so anything that touches the filesystem or a service here
| would run too early. It is resolved on first read instead - see
| App\Support\Bangued::stationBounds().
|
*/

return [
    'map' => [
        // Bangued town proper.
        'center' => [17.5965, 120.6167],
        'defaultZoom' => 15,
        'minZoom' => 13,
        // Google Maps carries imagery well past this; 21 is the ceiling for
        // the satellite and hybrid map types, so the cap only ever bites on
        // the street view.
        'maxZoom' => 21,
    ],

    /*
    | Maps JavaScript API. The key is a browser key and is deliberately sent to
    | the client - it has to be, the script tag carries it. Restrict it in the
    | Google Cloud console by HTTP referrer to the domains that serve this app
    | (and restrict the API to "Maps JavaScript API") so it cannot be lifted
    | and used elsewhere.
    |
    | map_id is read and served to the client, but it is NOT applied to the map.
    | A Google map is styled by the mapId option on its own constructor, and a
    | map that carries a map id requires AdvancedMarkerElement - the client here
    | still draws the classic google.maps.Marker from a canvas-rasterised icon,
    | so wiring this up means migrating the markers, not just passing an option.
    | Until that is done, setting GOOGLE_MAPS_MAP_ID changes nothing.
    */
    'google_maps' => [
        'api_key' => env('GOOGLE_MAPS_API_KEY'),
        'map_id' => env('GOOGLE_MAPS_MAP_ID'),
        'language' => env('GOOGLE_MAPS_LANGUAGE', 'en'),
    ],

    'boundary_path' => null, // filled in by Bangued::path() at runtime

    'fuel_types' => ['Gasoline', 'Diesel', 'Kerosene', 'Premium Gasoline'],

    'place' => [
        'name' => 'Bangued',
        'province' => 'Abra',
        'region' => 'Cordillera Administrative Region',
        'country' => 'Philippines',
    ],

    /*
    | The dashboard accounts loaded by `php artisan bangued:seed`. Both roles are
    | covered; an admin can do everything a station manager can and more.
    | Change ADMIN_PASSWORD and STATION_MANAGER_PASSWORD before seeding
    | anything you intend to expose publicly.
    */
    'admin' => [
        'username' => env('ADMIN_USERNAME', 'admin'),
        'password' => env('ADMIN_PASSWORD', 'admin123'),
        'display_name' => 'Map Administrator',
        'role' => 'admin',
        'bcrypt_rounds' => (int) env('BCRYPT_ROUNDS', 12),
    ],

    'station_manager' => [
        'username' => env('STATION_MANAGER_USERNAME', 'manager'),
        'password' => env('STATION_MANAGER_PASSWORD', 'manager123'),
        'display_name' => 'Station Manager',
        'role' => 'station_manager',
        'bcrypt_rounds' => (int) env('BCRYPT_ROUNDS', 12),
    ],
];

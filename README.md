# Bangued Gas Map

An interactive map of gas stations in Bangued, Abra, with fuel prices and a
public/admin site split: anyone can browse the map, only a signed-in
administrator can edit stations and prices.

This is a Laravel port of the original Node/Express version. The frontend
(HTML, CSS, JS) and the HTTP API are unchanged, so every URL, JSON field name
and login flow behaves exactly as it did before.

## Requirements

- PHP 8.2 or newer (built and tested on 8.5)
- Composer 2
- SQLite (the default; MySQL 8.0.16+ also supported, see `sql/` in the Node
  repo for the equivalent schema)

## Running it

```bash
composer install
cp .env.example .env          # Windows: copy .env.example .env
php artisan key:generate
php artisan bangued:seed      # brands, stations and the admin user
php artisan serve
```

Then open:

- <http://localhost:8000/> — public map
- <http://localhost:8000/login> — admin sign-in
- <http://localhost:8000/admin> — dashboard (redirects to /login when signed out)

The seeder prints the admin credentials it created. The defaults come from
`config/bangued.php` and are `admin` / `admin123` — **change the password
before putting this on a public server.**

To load clearly-labelled *fictional* fuel prices so the price UI is populated,
add `--demo-prices`. Prices are otherwise never seeded: inventing them would
present fabricated data as real.

```bash
php artisan bangued:seed --demo-prices
```

### Seeding and resetting

```bash
php artisan bangued:seed                 # idempotent: updates existing rows
php artisan bangued:seed --force         # wipe the tables, re-migrate, reload
php artisan bangued:seed --force --demo-prices
```

`--force` drops all tables including the sessions table, so everyone is signed
out afterwards.

## Tests

```bash
php artisan test
```

The suite runs against an in-memory SQLite database and seeds itself, so it
never touches `database/database.sqlite`. It pins the API contract the
frontend depends on, including the `/api/meta` exception to the `{data: ...}`
envelope and the price-history rules.

## How it fits together

| Path | Role |
| --- | --- |
| `app/Http/Controllers/PublicApiController.php` | `/api/meta`, `/api/brands`, `/api/stations` |
| `app/Http/Controllers/AdminApiController.php` | station CRUD, prices, price history, config |
| `app/Http/Controllers/AuthController.php` | login, logout, session probe, password change |
| `app/Http/Middleware/AttachUser.php` | resolves the session user for API requests |
| `app/Http/Middleware/RequireAdmin.php` | 401 when signed out, 403 when not an admin |
| `app/Http/Validate.php` | shared input validation, all errors shaped as `{error:{message}}` |
| `app/Support/Bangued.php` | boundary GeoJSON, map viewport, coordinate limits |
| `config/bangued.php` | map, admin and fuel-type configuration |
| `database/seeders/BanguedSeeder.php` | brands, stations, optional demo prices, admin |
| `public/` | the frontend, copied unchanged from the Node version |

### API contract

- Read endpoints answer `{"data": ...}`.
- `/api/meta` is the one exception and answers unwrapped, because `map.js`
  reads `meta.map` directly.
- Errors answer `{"error": {"message": "..."}}`, which is what `public/js/api.js`
  surfaces to the user.
- Unknown `/api/*` paths answer JSON 404 rather than an HTML error page.

### Admin auth

Session-based, not token-based: login writes a `laravel_session` cookie and the
admin gate reads it back. The 12-hour session lifetime matches the JWT expiry
the Node version used.

The login page calls `/api/auth/me` to check whether you are already signed in.
For a signed-out visitor that answers **401**, which the browser logs as a
failed network request. That is expected, and the page handles it by showing
the form. It is not an application error.

## Coordinate provenance

Read `database/seeders/BanguedSeeder.php` before editing station coordinates.
Shell and Seaoil came from the project owner. Caltex uses the OpenStreetMap
centroid of a village node and is flagged `approximate` — verify and correct it
in the dashboard. The three records with no coordinates are seeded as
`is_pending` placeholders and deliberately do not appear on the public map
until an admin fills them in.

## Deploying

Any standard Laravel host works. Point the document root at `public/`, set
`APP_ENV=production`, `APP_DEBUG=false`, and a real `APP_KEY`, then run
`php artisan migrate --force`. The default seed command is
`php artisan bangued:seed --force`; do not pass `--demo-prices` in production.

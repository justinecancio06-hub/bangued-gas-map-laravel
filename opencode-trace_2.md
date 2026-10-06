Rename Application Branding
   - Change the app name from "Bangued Gas Station" to "Refuelio Bangued's Gas Station Hub".
   - Update the "APP_NAME" value in the .env file and the "name" value in "config/app.php" to "Refuelio Bangued's Gas Station Hub" 

Restore Brand Logo Markers on the Public Map
   - The public map is currently showing default generic gas station icons.
   - Restore the code so that each station marker displays its corresponding brand logo (from "public/images/brands/") as the marker icon instead of the default.

 Add "CyclOSM" as a New Map Type
   - Add a new base map layer called "CyclOSM" to the map type selector, using the OpenStreetMap CyclOSM tile server.
   - Add it to the existing map type options (Default and Satellite).

Set C-Oil's Logo to the Seaoil Image
   - The C-Oil brand should remain its own separate brand with its own slug (c-oil) and database row.
   - It should display the Seaoil logo image.

Add a "Station Manager" role to the Laravel project (C:\xampp\htdocs\bangued-gas-map-laravel). Do NOT touch anything else — no renaming, no map layers, no marker changes.

=== GOAL ===

A station manager is a limited user who:
- Logs in via the existing /login page.
- Is assigned to exactly ONE station.
- Can edit fuel prices ONLY for their own station, ONLY on the public map.
- Cannot edit any other station's prices.
- Cannot access /admin.

Admins keep full access to everything (dashboard + price editing in /admin for any station).

=== DATABASE ===

1. Create a migration that adds two columns to the users table:
   - role: string, nullable, allowed values 'admin' or 'station_manager'
   - station_id: unsigned big integer, nullable, foreign key → stations(id), on delete set null

2. Update the User model:
   - Add 'role' and 'station_id' to the $fillable array.
   - Add a relationship: station() → belongsTo(Station::class)
   - Add helper methods: isAdmin() returns role === 'admin'; isStationManager() returns role === 'station_manager'.
   - Set the existing admin user's role to 'admin' if currently null.

3. Create a seeder or artisan command that creates ONE demo station manager:
   - username: manager
   - password: manager123 (bcrypt, 12 rounds)
   - role: station_manager
   - station_id: <the id of Blu Gas Station #1>  ← replace with the real id before running

=== BACKEND ===

4. Add a GET /api/me endpoint that returns:
   { id, username, role, station_id }
   for the currently authenticated user. Returns 401 if not logged in.

5. Modify the existing PUT /api/admin/stations/{id}/prices endpoint:
   - If user is admin → allow (no change from current behavior).
   - If user is station_manager AND user.station_id === {id} → allow.
   - Otherwise → return 403 with a clear error message.
   - Do NOT trust the frontend. The check must run server-side.

6. Add a redirect: if a user with role 'station_manager' tries to GET /admin, redirect them to / (the public map).

=== FRONTEND (public map) ===

7. On page load, call GET /api/me:
   - If the response is 401 (not logged in) → show the map normally, no edit buttons anywhere.
   - If the user is admin → show the map normally, no inline edit button (admins use /admin for editing).
   - If the user is station_manager → check each station's popup:
     - If station.id === user.station_id → show an "Edit Prices" button in the popup.
     - Otherwise → no edit button.

8. Clicking "Edit Prices":
   - Opens a small inline form (or modal) inside the popup.
   - Shows the station's current fuel types and prices.
   - Manager can add, edit, or remove fuel types and prices for that station.
   - Save button → PUT /api/admin/stations/{id}/prices with the payload.
   - On success → close the form and refresh the popup's price display.
   - On 403 → show an error message.

9. After login:
   - Admin users redirect to /admin (existing behavior).
   - Station managers redirect to / (the public map).

=== WHAT NOT TO CHANGE ===

- Do NOT remove the price editor from the admin dashboard. Admins still edit prices there.
- Do NOT rename anything.
- Do NOT modify the map type selector.
- Do NOT modify the marker icons.
- Do NOT touch any existing station or brand data.

=== VERIFY ===

After making changes, run php artisan migrate and php artisan optimize:clear, then verify:

1. Log in as admin/admin123 → lands on /admin, can still edit any station's prices in the dashboard.
2. Log in as manager/manager123 → lands on / (public map), sees the Edit Prices button ONLY on their assigned station's popup.
3. Click Edit Prices on the manager's own station → form opens → save works → popup updates.
4. As manager, try PUT /api/admin/stations/{other_id}/prices via curl or Postman → returns 403.
5. As manager, visit /admin → redirected back to /.

Report:
- Files changed
- Migration name
- Confirmation of each of the 5 verify steps
- Anything you couldn't resolve

Add one demo station manager account per station in the database.

Requirements:

1. Keep the existing 'manager' user (assigned to Blu Gas Station #1, station_id=3). Do NOT delete or modify it.

2. For every OTHER station in the stations table, create a new user with:
   - username: a short, clean identifier derived from the station name (e.g., manager_shell, manager_caltex1, manager_caltex2, manager_blugas2, manager_petron1, manager_petron2, manager_seaoil, manager_coil, manager_phoenix)
   - If a username already exists, append a number (e.g., manager_shell2).
   - password: manager123 (bcrypt, 12 rounds)
   - role: station_manager
   - station_id: that station's id

3. Make it idempotent — running the seeder twice must not create duplicates. Use updateOrCreate or firstOrCreate keyed on username.

4. Put this in the existing StationManagerSeeder (or create a new one, but keep the same class name pattern). Extend BanguedSeeder to call it if not already called.

5. At the end of seeding, print a table showing:
   username | role | assigned station name
   for every station_manager created or updated.

6. Print the admin credentials separately (existing admin/admin123) so they're not confused with the manager accounts.

7. Do NOT modify:
   - The station_manager role logic (middleware, /api/me, price ownership check)
   - The admin dashboard
   - Any other feature

Expected: one line per station, e.g.:
manager -> Blu Gas Station #1
manager_shell -> Shell
manager_caltex1 -> Caltex #1
manager_caltex2 -> Caltex #2
manager_blugas2 -> Blu Gas Station #2
manager_petron1 -> Petron #1
manager_petron2 -> Petron #2
manager_seaoil -> Seaoil
manager_coil -> C-Oil
manager_phoenix -> Phoenix

Report:
- List of manager accounts created/updated
- Assigned station for each
- Whether any station has no manager assigned (should be none)
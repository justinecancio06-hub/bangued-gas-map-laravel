<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;

/**
 * Explains, in one command, why the map is or is not working.
 *
 * Google Maps fails in a way that is invisible from inside the app: the script
 * loads, google.maps.Map constructs, nothing throws, and Google paints its own
 * grey "Oops! Something went wrong" panel over the map. The real reason is only
 * ever printed to the browser console, which is exactly where nobody looks when
 * a page looks broken.
 *
 * So this reproduces the browser's own checks from the command line, and prints
 * the fix for each one that fails. Two of those checks - whether billing is
 * enabled, and whether the key is valid - are settled by asking Google a
 * question over HTTP, because a billable API reports both in its response body.
 * That is the whole point of the probe: a project with no billing enabled serves
 * the Maps script perfectly happily and then paints the grey panel, so nothing
 * short of an explicit request to Google reveals it.
 *
 * The quota is the exception, and stays called out rather than guessed at: only
 * the Maps JavaScript API reports a per-day quota, and only from inside a page.
 */
class MapsDoctor extends Command
{
    protected $signature = 'bangued:maps-doctor
                            {--url= : The site URL the browser will load, for the referrer hint}';

    protected $description = 'Diagnose why Google Maps is not loading';

    public function handle(): int
    {
        $this->components->info('Google Maps check');

        $problems = 0;
        $key = (string) config('bangued.google_maps.api_key');

        // 1. Is a key configured at all?
        if ($key === '') {
            $problems++;
            $this->components->error('No API key configured.');
            $this->line('   Set GOOGLE_MAPS_API_KEY in .env, then run: php artisan config:clear');
        } else {
            $this->line('  API key: configured ('.strlen($key).' chars)');
        }

        // 2. Is a stale config cache pinning an older key? This is the reason a
        //    correct .env edit appears to do nothing.
        if (file_exists($this->configCachePath())) {
            $problems++;
            $this->components->error('Config is cached - a changed .env will be ignored.');
            $this->line('   Run: php artisan config:clear');
        } else {
            $this->line('  Config cache: not cached (edits take effect)');
        }

        // 3. Does the page ship a referrer policy that suppresses the Referer
        //    header? Google needs it to match a key's HTTP-referrer restriction,
        //    and the two policies that send nothing cross-origin make such a key
        //    look invalid.
        //
        //    Only no-referrer and same-origin qualify. The others -
        //    strict-origin-when-cross-origin being the browser default - do send
        //    the origin, which is all a domain-level restriction needs.
        $referrer = $this->suppressingReferrerPolicyInPages();
        if ($referrer !== null) {
            $problems++;
            $this->components->error("Pages declare referrer policy \"$referrer\", which hides this site from Google.");
            $this->line('   Cross-origin requests to maps.googleapis.com then carry no Referer');
            $this->line('   header, so a referrer-restricted key looks invalid.');
            $this->line('   Use strict-origin-when-cross-origin, or remove the meta tag.');
        } else {
            $this->line('  Referrer policy: browser default (origin is sent)');
        }

        // 4. Ask Google whether the key can actually bill. This is the one
        //    failure that produces no signal anywhere else in the app: the
        //    script loads, the map constructs, and Google paints its own grey
        //    failure panel over the canvas with nothing in the DOM to match on.
        if ($key !== '') {
            if ($this->reportKeyProbe($this->probeKey($key))) {
                $problems++;
            }
        }

        // 5. Report the exact URL the loader will request, so it can be compared
        //    against the key's allowed referrers by eye.
        if ($key !== '') {
            $this->line('  Loader requests: maps.googleapis.com/maps/api/js?key=...&v=weekly');
            $host = $this->hostHint();
            if ($host !== null) {
                $this->line("  Your referrer will be: $host");
            }
            $this->line('   The key must allow that referrer under "Application restrictions".');
        }

        $this->newLine();

        if ($problems > 0) {
            $this->components->error("$problems configuration problem(s) found above.");
        }

        // Always print the part only a browser can see. The probe above settles
        // billing and key validity; a quota and a referrer rejection are only
        // ever reported by the Maps JavaScript API from inside a page.
        $this->components->warn('Only a real page load confirms the quota and any referrer rejection.');
        $this->line('   Open the site, press F12, and read the Console. Google names the');
        $this->line('   exact failure there. The messages mean:');
        $this->newLine();
        $this->line('     "Maps Demo Key limit reached"        -> this is Google\'s shared');
        $this->line('                                             demo key. It cannot be used');
        $this->line('                                             for a real site. Create your');
        $this->line('                                             own key and enable billing.');
        $this->line('     "RefererNotAllowedMapError"          -> key is referrer-restricted;');
        $this->line('                                             add this site\'s domain.');
        $this->line('     "BillingNotEnabledMapError"          -> enable billing on the');
        $this->line('                                             Cloud project.');
        $this->line('     "InvalidKeyMapError"                 -> the key is malformed or');
        $this->line('                                             the API is not enabled.');
        $this->newLine();

        return $problems > 0 ? self::FAILURE : self::SUCCESS;
    }

    /**
     * Asks Google directly whether the configured key is real and whether its
     * Cloud project has billing switched on.
     *
     * Geocoding stands in for the probe because it bills against the same Cloud
     * project as the Maps JavaScript API and reports authentication failures in
     * the response body, instead of by painting over a canvas. Google answers
     * with HTTP 200 even when it refuses the request, so the status field in the
     * body - not the response code - is what carries the verdict.
     *
     * The request deliberately carries no Referer: that is how a properly
     * referrer-restricted browser key is expected to answer, so a restriction
     * reads as correct rather than as a fault.
     *
     * @return array{verdict: string, detail: string}
     */
    private function probeKey(string $key): array
    {
        try {
            $response = Http::connectTimeout(5)
                ->timeout(15)
                ->get('https://maps.googleapis.com/maps/api/geocode/json', [
                    'address' => 'Bangued, Abra',
                    'key' => $key,
                ]);
        } catch (ConnectionException $e) {
            // A TLS trust failure is the most common way this probe fails on
            // Windows, where PHP ships without a CA bundle and cURL then refuses
            // every https:// host. It reads as "cannot reach Google" but it is a
            // php.ini problem, not a key problem, so it is named outright.
            $message = $e->getMessage();

            return preg_match('/cURL error 6[0-9]|SSL certificate|unable to get local issuer/i', $message) === 1
                ? ['verdict' => 'tls_untrusted', 'detail' => $message]
                : ['verdict' => 'unreachable', 'detail' => 'no response from maps.googleapis.com'];
        }

        if (! $response->successful()) {
            return ['verdict' => 'unreachable', 'detail' => 'HTTP '.$response->status().' from Google'];
        }

        $status = (string) $response->json('status');
        $message = (string) $response->json('error_message');

        if ($status === 'OK') {
            return ['verdict' => 'ok', 'detail' => 'Google accepted the key'];
        }

        // Ordered most-specific first: several of these arrive in one message.
        return match (true) {
            str_contains($message, 'enable Billing') => [
                'verdict' => 'billing',
                'detail' => trim($message),
            ],
            str_contains($message, 'referrer restrictions') => [
                'verdict' => 'referrer_restricted',
                'detail' => trim($message),
            ],
            str_contains($message, 'ApiNotActivatedMapError'),
            str_contains($message, 'is not enabled') => [
                'verdict' => 'api_disabled',
                'detail' => trim($message),
            ],
            str_contains($message, 'not valid'),
            str_contains($message, 'InvalidKey') => [
                'verdict' => 'invalid',
                'detail' => trim($message),
            ],
            default => ['verdict' => 'unknown', 'detail' => $status.($message === '' ? '' : ': '.$message)],
        };
    }

    /**
     * Prints one probe verdict and reports whether it counts as a problem.
     *
     * Only a genuinely broken key or a project that cannot bill fails the
     * command. A referrer-restricted key is the correct way to ship a browser
     * key and is reported as such, and the inconclusive answers are warnings -
     * they describe the probe, not the map, and must not send someone off to
     * fix a configuration that is fine.
     */
    private function reportKeyProbe(array $result): bool
    {
        ['verdict' => $verdict, 'detail' => $detail] = $result;

        if ($verdict === 'ok') {
            $this->line('  Key probe: accepted by Google, billing is enabled');
        } elseif ($verdict === 'billing') {
            $this->components->error('Google refuses this key because its Cloud project has no billing.');
            $this->line('   The Maps script loads and the map constructs, then Google paints a grey');
            $this->line('   panel over it - which is why the page looks loaded but is not a map.');
            $this->line('   Enable billing at: https://console.cloud.google.com/project/_/billing/enable');
            $this->line('   Then confirm "Maps JavaScript API" is enabled for the same project.');
        } elseif ($verdict === 'invalid') {
            $this->components->error('Google does not recognise this key.');
            $this->line("   Google said: $detail");
            $this->line('   Check GOOGLE_MAPS_API_KEY in .env, then run: php artisan config:clear');
        } elseif ($verdict === 'referrer_restricted') {
            $this->line('  Key probe: key is referrer-restricted (expected for a browser key)');
        } elseif ($verdict === 'api_disabled') {
            $this->components->warn('Key probe inconclusive: the probe\'s own API is not enabled on this project.');
            $this->line("   Google said: $detail");
            $this->line('   This says nothing about the Maps JavaScript API. Enable the Geocoding API');
            $this->line('   to make this check conclusive.');
        } elseif ($verdict === 'unreachable') {
            $this->components->warn('Key probe inconclusive: could not reach Google.');
            $this->line("   $detail - checked from this machine, so an offline or");
            $this->line('   firewalled host will report this. It is not a fault in the key.');
        } elseif ($verdict === 'tls_untrusted') {
            $this->components->warn('Key probe inconclusive: this host does not trust HTTPS.');
            $this->line('   Google said: '.$detail);
            $this->line('   PHP has no CA bundle, so every https:// request fails before it');
            $this->line('   reaches Google. This is a php.ini problem, not a fault in the key.');
            $this->line('   Download https://curl.se/ca/cacert.pem, then point curl.cainfo at it:');
            $this->line('     curl.cainfo = "C:\path\to\cacert.pem"');
            $this->line('   Then restart the server and re-run this command.');
        } else {
            $this->components->warn('Key probe inconclusive.');
            $this->line("   Google said: $detail");
        }

        return in_array($verdict, ['billing', 'invalid'], true);
    }

    /**
     * Where Laravel writes the cached config. Not config_path('cache/...') -
     * the cache lives under bootstrap/, and looking in the wrong place reports
     * "not cached" even after `php artisan config:cache` has run.
     */
    private function configCachePath(): string
    {
        return base_path('bootstrap/cache/config.php');
    }

    /**
     * The first referrer policy in the served HTML that actually withholds the
     * Referer header from Google, or null.
     *
     * `strict-origin-when-cross-origin` (the browser default),
     * `origin`, `origin-when-cross-origin` and `unsafe-url` all send at least
     * the origin across origins, which is what a domain-level restriction
     * matches, so none of them count as a problem.
     */
    private function suppressingReferrerPolicyInPages(): ?string
    {
        foreach (['index.html', 'login.html', 'admin.html'] as $page) {
            $path = public_path($page);
            if (! is_file($path)) {
                continue;
            }
            if (preg_match('/<meta[^>]+name=["\']referrer["\'][^>]*content=["\']([^"\']+)["\']/i', (string) file_get_contents($path), $m)) {
                $policy = strtolower(trim($m[1]));

                if (in_array($policy, ['no-referrer', 'same-origin'], true)) {
                    return $policy;
                }
            }
        }

        return null;
    }

    /** A best guess at the referrer the browser will send, for comparison. */
    private function hostHint(): ?string
    {
        $url = $this->option('url') ?: config('app.url');
        if (! is_string($url) || $url === '') {
            return null;
        }
        $parts = parse_url($url);

        return isset($parts['scheme'], $parts['host'])
            ? $parts['scheme'].'://'.$parts['host'].'/'
            : null;
    }
}

<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The Google Maps key is the most common reason the map renders nothing, and it
 * fails in a way that leaves no trace in the app. bangued:maps-doctor exists to
 * turn that into a command that says what is wrong, so its verdicts are pinned
 * here.
 *
 * The tests drive Artisan::call() rather than $this->artisan() so the real
 * output string can be asserted on directly - the fluent expectations match
 * line-for-line and proved unreliable for the detail lines.
 */
class MapsDoctorTest extends TestCase
{
    private const PAGE = '<!DOCTYPE html><html><head>%s</head><body></body></html>';

    private const PROBE_URL = 'maps.googleapis.com/maps/api/geocode/json*';

    /** The body the fake probe answers with. Tests reassign it to vary the verdict. */
    private array $probeBody = ['status' => 'OK', 'results' => []];

    /** Set by the test that needs the probe to fail the way an offline host does. */
    private bool $probeUnreachable = false;

    /** Set by the test that needs the probe to fail on TLS verification. */
    private bool $probeTlsFailure = false;

    /**
     * The doctor now asks Google a real question to settle billing and key
     * validity, so every test has to answer it - and pin the key it asks with,
     * because the suite loads the real .env and would otherwise probe the
     * developer's own key.
     *
     * Only one fake is registered, and it reads the verdict from a property,
     * because Http::fake() merges rather than replaces: a second fake added by a
     * test would be shadowed by this one instead of overriding it.
     */
    protected function setUp(): void
    {
        parent::setUp();

        Http::preventStrayRequests();
        Http::fake([
            self::PROBE_URL => function () {
                if ($this->probeTlsFailure) {
                    return Http::failedConnection('cURL error 60: SSL certificate problem: '
                        .'unable to get local issuer certificate');
                }

                if ($this->probeUnreachable) {
                    return Http::failedConnection();
                }

                return Http::response($this->probeBody);
            },
        ]);
    }

    /**
     * Runs the doctor and returns [exit code, output]. Artisan::call() returns
     * the command's exit status, which is what the command's own failure
     * signalling is asserted on.
     *
     * @return array{0: int, 1: string}
     */
    private function runDoctor(): array
    {
        $code = Artisan::call('bangued:maps-doctor');

        return [$code, Artisan::output()];
    }

    /** Google says this - the wording of the billable APIs' refusal. */
    private function billingRefusal(): array
    {
        return [
            'status' => 'REQUEST_DENIED',
            'error_message' => 'You must enable Billing on the Google Cloud Project at '
                .'https://console.cloud.google.com/project/_/billing/enable',
        ];
    }

    public function test_it_reports_a_configured_key_and_a_clear_cache(): void
    {

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('API key: configured', $output);
        $this->assertStringContainsString('not cached', $output);
        $this->assertSame(0, $code, 'a clean configuration should not fail');
    }

    public function test_it_fails_when_no_key_is_configured(): void
    {
        config(['bangued.google_maps.api_key' => '']);

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('No API key configured', $output);
        $this->assertStringContainsString('GOOGLE_MAPS_API_KEY', $output);
        $this->assertSame(1, $code);
    }

    /**
     * A stale config cache pins the old key, which is why a correct .env edit
     * can appear to do nothing at all. The cache lives under bootstrap/, so the
     * command has to look there rather than under config/.
     */
    public function test_it_fails_when_the_config_is_cached(): void
    {
        $cachePath = base_path('bootstrap/cache/config.php');
        $dir = dirname($cachePath);
        $madeDir = ! is_dir($dir);
        if ($madeDir) {
            mkdir($dir, 0777, true);
        }
        file_put_contents($cachePath, '<?php return [];');

        try {
            [$code, $output] = $this->runDoctor();

            $this->assertStringContainsString('Config is cached', $output);
            $this->assertStringContainsString('config:clear', $output);
            $this->assertSame(1, $code);
        } finally {
            unlink($cachePath);
            if ($madeDir) {
                rmdir($dir);
            }
        }
    }

    /**
     * no-referrer and same-origin withhold the Referer header from
     * cross-origin requests, which makes a referrer-restricted key look invalid
     * for reasons the server cannot see.
     */
    public function test_it_flags_a_referrer_policy_that_suppresses_the_header(): void
    {
        foreach (['no-referrer', 'same-origin'] as $policy) {
            $this->withReferrerMeta($policy, function () use ($policy) {
                [$code, $output] = $this->runDoctor();

                $this->assertStringContainsString("referrer policy \"$policy\"", $output);
                $this->assertStringContainsString('strict-origin-when-cross-origin', $output);
                $this->assertSame(1, $code);
            });
        }
    }

    /**
     * The browser default sends the origin cross-origin, which is all a
     * domain-level restriction needs - so it must NOT be reported as a problem.
     */
    public function test_the_safe_referrer_policies_are_not_flagged(): void
    {
        foreach (['strict-origin-when-cross-origin', 'origin', 'origin-when-cross-origin', 'unsafe-url'] as $policy) {
            $this->withReferrerMeta($policy, function () use ($policy) {
                [$code, $output] = $this->runDoctor();

                $this->assertStringContainsString(
                    'Referrer policy: browser default',
                    $output,
                    "$policy should not be reported as a problem",
                );
                $this->assertSame(0, $code, "$policy should not fail the command");
            });
        }
    }

    public function test_it_confirms_billing_when_google_accepts_the_key(): void
    {

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('accepted by Google, billing is enabled', $output);
        $this->assertSame(0, $code);
    }

    /**
     * The failure that motivates the probe. A project with no billing enabled
     * still serves the Maps script and still constructs the map, then Google
     * paints a grey panel over the canvas, so nothing inside the app reveals it.
     */
    public function test_it_fails_when_google_reports_that_billing_is_off(): void
    {
        $this->probeBody = $this->billingRefusal();

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('no billing', $output);
        $this->assertStringContainsString('https://console.cloud.google.com/project/_/billing/enable', $output);
        $this->assertSame(1, $code);
    }

    public function test_it_fails_when_google_does_not_recognise_the_key(): void
    {
        $this->probeBody = [
            'status' => 'REQUEST_DENIED',
            'error_message' => 'The provided API key is not valid.',
        ];

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('does not recognise this key', $output);
        $this->assertSame(1, $code);
    }

    /**
     * A browser key is supposed to be referrer-restricted, and the probe sends
     * no Referer precisely so that restriction reads as correct. Reporting it as
     * a fault would send someone to weaken a correct configuration.
     */
    public function test_it_does_not_treat_a_referrer_restricted_key_as_a_problem(): void
    {
        $this->probeBody = [
            'status' => 'REQUEST_DENIED',
            'error_message' => 'API keys with referrer restrictions cannot be used with this API.',
        ];

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('referrer-restricted (expected for a browser key)', $output);
        $this->assertSame(0, $code);
    }

    /**
     * The probe uses Geocoding, so the project may not have that API on while
     * the Maps JavaScript API works fine. That describes the probe, not the map,
     * and must not fail the command.
     */
    public function test_it_warns_without_failing_when_the_probe_api_is_disabled(): void
    {
        $this->probeBody = [
            'status' => 'REQUEST_DENIED',
            'error_message' => 'Geocoding API is not enabled for this project.',
        ];

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('says nothing about the Maps JavaScript API', $output);
        $this->assertSame(0, $code, 'an inconclusive probe is not a configuration fault');
    }

    public function test_it_warns_without_failing_when_google_is_unreachable(): void
    {
        $this->probeUnreachable = true;

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('could not reach Google', $output);
        $this->assertStringContainsString('not a fault in the key', $output);
        $this->assertSame(0, $code, 'an offline host is not a configuration fault');
    }

    /**
     * A TLS trust failure reads as "cannot reach Google" but is a php.ini
     * problem, and it is what PHP on Windows reports by default. Naming it keeps
     * the fix from being chased in Google Cloud, where nothing is wrong.
     */
    public function test_it_names_a_missing_ca_bundle_when_tls_verification_fails(): void
    {
        $this->probeTlsFailure = true;

        [$code, $output] = $this->runDoctor();

        $this->assertStringContainsString('this host does not trust HTTPS', $output);
        $this->assertStringContainsString('curl.cainfo', $output);
        $this->assertStringContainsString('not a fault in the key', $output);
        $this->assertSame(0, $code);
    }

    public function test_it_does_not_probe_when_no_key_is_configured(): void
    {
        // The probe is unreachable, so if it ran the warning text would appear
        // and this assertion would fail on it.
        $this->probeUnreachable = true;
        config(['bangued.google_maps.api_key' => '']);

        [, $output] = $this->runDoctor();

        $this->assertStringNotContainsString('Key probe', $output);
    }

    /**
     * The quota verdict only ever comes from a real page load, so the command
     * must say so rather than quietly reporting success.
     */
    public function test_it_always_explains_the_browser_only_failures(): void
    {

        [, $output] = $this->runDoctor();

        $this->assertStringContainsString('Only a real page load confirms the quota', $output);
        $this->assertStringContainsString('Maps Demo Key limit reached', $output);
        $this->assertStringContainsString('RefererNotAllowedMapError', $output);
        $this->assertStringContainsString('BillingNotEnabledMapError', $output);
        $this->assertStringContainsString('InvalidKeyMapError', $output);
    }

    /** Temporarily gives public/index.html the given referrer meta tag. */
    private function withReferrerMeta(string $policy, callable $callback): void
    {
        $path = public_path('index.html');
        $original = file_get_contents($path);

        file_put_contents($path, sprintf(
            self::PAGE,
            '<meta name="referrer" content="'.$policy.'">',
        ));

        try {
            $callback();
        } finally {
            file_put_contents($path, $original);
        }
    }
}

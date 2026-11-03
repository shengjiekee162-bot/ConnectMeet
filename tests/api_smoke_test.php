<?php
/**
 * CLI smoke test for ConnectMeet APIs.
 * Usage: php tests/api_smoke_test.php
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "Run from CLI only.\n");
    exit(1);
}

$base = getenv('CM_BASE_URL') ?: 'http://localhost/connectmeet';
$pass = 0;
$fail = 0;

function req(string $method, string $url, ?array $body = null, array $headers = []): array
{
    $ch = curl_init($url);
    $hdrs = array_merge(['Accept: application/json'], $headers);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HEADER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_COOKIEJAR => sys_get_temp_dir() . '/cm_test_cookies.txt',
        CURLOPT_COOKIEFILE => sys_get_temp_dir() . '/cm_test_cookies.txt',
    ];
    if ($body !== null) {
        $hdrs[] = 'Content-Type: application/json';
        $opts[CURLOPT_POSTFIELDS] = json_encode($body);
    }
    $opts[CURLOPT_HTTPHEADER] = $hdrs;
    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    if ($raw === false) {
        throw new RuntimeException(curl_error($ch));
    }
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $json = json_decode(substr($raw, $headerSize), true) ?: [];
    return [$status, $json];
}

function assert_true(bool $cond, string $label): void
{
    global $pass, $fail;
    if ($cond) {
        echo "[PASS] $label\n";
        $pass++;
    } else {
        echo "[FAIL] $label\n";
        $fail++;
    }
}

echo "ConnectMeet API smoke test against $base\n\n";

@unlink(sys_get_temp_dir() . '/cm_test_cookies.txt');

[$st, $health] = req('GET', "$base/api/health.php");
assert_true($st === 200 && !empty($health['success']) && !empty($health['data']['database']), 'health + database');

[$st, $boot] = req('GET', "$base/api/meetings.php?action=bootstrap");
$csrf = $boot['data']['csrf_token'] ?? '';
assert_true($st === 200 && $csrf !== '', 'bootstrap CSRF');

[$st, $created] = req('POST', "$base/api/meetings.php?action=create", [
    'csrf_token' => $csrf,
    'mode' => 'instant',
    'display_name' => 'Host Tester',
    'title' => 'Smoke Test Meeting',
], ['X-CSRF-Token: ' . $csrf]);
$code = $created['data']['meeting_code'] ?? '';
$hostToken = $created['data']['host_token'] ?? '';
$pToken = $created['data']['participant']['token'] ?? '';
assert_true($st === 200 && $code !== '' && $pToken !== '', 'create instant meeting');

[$st, $bad] = req('GET', "$base/api/meetings.php?action=validate&meeting=000-000-000");
assert_true($st === 404 || empty($bad['success']), 'reject invalid meeting code');

[$st, $ok] = req('GET', "$base/api/meetings.php?action=validate&meeting=" . rawurlencode($code));
assert_true($st === 200 && !empty($ok['data']['joinable']), 'validate real meeting');

[$st, $join] = req('POST', "$base/api/participants.php?action=join", [
    'csrf_token' => $csrf,
    'meeting_code' => $code,
    'display_name' => 'Guest <script>alert(1)</script>',
    'audio_enabled' => true,
    'video_enabled' => false,
], ['X-CSRF-Token: ' . $csrf]);
$gToken = $join['data']['participant']['token'] ?? '';
$gName = $join['data']['participant']['display_name'] ?? '';
assert_true($st === 200 && $gToken !== '', 'second participant joins');
assert_true(strpos($gName, '<script>') === false, 'display name stripped of script tags');

[$st, $chat] = req('POST', "$base/api/chat.php?action=send", [
    'csrf_token' => $csrf,
    'message' => '<img src=x onerror=alert(1)> hello',
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $gToken,
]);
$msg = $chat['data']['message'] ?? '';
assert_true($st === 200 && strpos($msg, '<img') === false && strpos($msg, 'hello') !== false, 'chat HTML stripped');

[$st, $hand] = req('POST', "$base/api/participants.php?action=hand", [
    'csrf_token' => $csrf,
    'raised' => true,
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $gToken,
]);
assert_true($st === 200 && !empty($hand['data']['hand_raised']), 'raise hand');

[$st, $endDenied] = req('POST', "$base/api/meetings.php?action=end", [
    'csrf_token' => $csrf,
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $gToken,
]);
assert_true($st === 403, 'non-host cannot end meeting');

[$st, $leave] = req('POST', "$base/api/participants.php?action=leave", [
    'csrf_token' => $csrf,
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $gToken,
]);
assert_true($st === 200, 'guest leave');

[$st, $ended] = req('POST', "$base/api/meetings.php?action=end", [
    'csrf_token' => $csrf,
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $pToken,
    'X-Host-Token: ' . $hostToken,
]);
assert_true($st === 200, 'host ends meeting');

echo "\nPassed: $pass  Failed: $fail\n";
exit($fail > 0 ? 1 : 0);

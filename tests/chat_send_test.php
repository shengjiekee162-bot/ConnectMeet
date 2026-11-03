<?php
declare(strict_types=1);

$base = getenv('CM_BASE_URL') ?: 'http://localhost:8000';
$cookie = tempnam(sys_get_temp_dir(), 'cmck');

function req(string $method, string $url, ?array $body, array $headers, string $cookie): array
{
    $ch = curl_init($url);
    $hdrs = array_merge(['Accept: application/json'], $headers);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_COOKIEJAR => $cookie,
        CURLOPT_COOKIEFILE => $cookie,
        CURLOPT_HEADER => true,
        CURLOPT_TIMEOUT => 15,
    ];
    if ($body !== null) {
        $hdrs[] = 'Content-Type: application/json';
        $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
    }
    $opts[CURLOPT_HTTPHEADER] = $hdrs;
    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    if ($raw === false) {
        throw new RuntimeException(curl_error($ch));
    }
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hs = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    return [$code, json_decode(substr($raw, $hs), true)];
}

[$c, $boot] = req('GET', "$base/api/meetings.php?action=bootstrap", null, [], $cookie);
$csrf = $boot['data']['csrf_token'] ?? '';
echo "bootstrap=$c csrf=" . ($csrf !== '' ? 'yes' : 'NO') . PHP_EOL;

[$c, $created] = req('POST', "$base/api/meetings.php?action=create", [
    'csrf_token' => $csrf,
    'mode' => 'instant',
    'display_name' => 'ChatHost',
], ['X-CSRF-Token: ' . $csrf], $cookie);
$code = $created['data']['meeting_code'] ?? '';
$tok = $created['data']['participant']['token'] ?? '';
echo "create=$c meeting=$code token=" . ($tok !== '' ? 'yes' : 'NO') . ' msg=' . ($created['message'] ?? '') . PHP_EOL;

[$c, $chat] = req('POST', "$base/api/chat.php?action=send", [
    'csrf_token' => $csrf,
    'message' => 'hello from test',
], [
    'X-CSRF-Token: ' . $csrf,
    'X-Participant-Token: ' . $tok,
], $cookie);
echo "chat=$c " . json_encode($chat, JSON_UNESCAPED_UNICODE) . PHP_EOL;

// Missing participant token
[$c, $chat2] = req('POST', "$base/api/chat.php?action=send", [
    'csrf_token' => $csrf,
    'message' => 'no token',
], ['X-CSRF-Token: ' . $csrf], $cookie);
echo "chat_no_token=$c " . json_encode($chat2, JSON_UNESCAPED_UNICODE) . PHP_EOL;

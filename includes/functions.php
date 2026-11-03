<?php

declare(strict_types=1);

function cm_request_json(): array
{
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        $cached = [];
        return $cached;
    }

    $decoded = json_decode($raw, true);
    $cached = is_array($decoded) ? $decoded : [];
    return $cached;
}

function cm_client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function cm_hash_token(string $token): string
{
    return hash('sha256', $token);
}

function cm_generate_token(int $bytes = 32): string
{
    return bin2hex(random_bytes($bytes));
}

function cm_generate_meeting_code(int $length = 9): string
{
    // Numeric meeting codes only (easier to read/type on phones)
    $length = max(6, min(12, $length));
    $raw = '';
    for ($i = 0; $i < $length; $i++) {
        $raw .= (string) random_int(0, 9);
    }

    // Format like 123-456-789 (groups of 3)
    if ($length === 9) {
        return substr($raw, 0, 3) . '-' . substr($raw, 3, 3) . '-' . substr($raw, 6, 3);
    }
    if ($length === 10) {
        return substr($raw, 0, 3) . '-' . substr($raw, 3, 4) . '-' . substr($raw, 7, 3);
    }
    return $raw;
}

function cm_normalize_meeting_code(string $code): string
{
    $digits = preg_replace('/\D+/', '', trim($code)) ?? '';
    $len = strlen($digits);
    if ($len === 9) {
        return substr($digits, 0, 3) . '-' . substr($digits, 3, 3) . '-' . substr($digits, 6, 3);
    }
    if ($len === 10) {
        return substr($digits, 0, 3) . '-' . substr($digits, 3, 4) . '-' . substr($digits, 7, 3);
    }
    return $digits;
}

function cm_sanitize_display_name(string $name, int $max = 60): string
{
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    $name = strip_tags($name);
    if ($name === '') {
        return '';
    }
    if (mb_strlen($name) > $max) {
        $name = mb_substr($name, 0, $max);
    }
    return $name;
}

function cm_meeting_url(string $meetingCode): string
{
    $base = rtrim((string) ($GLOBALS['cm_config']['app']['base_url'] ?? ''), '/');
    return $base . '/room.php?meeting=' . rawurlencode($meetingCode);
}

function cm_log(string $message, array $context = []): void
{
    $cfg = $GLOBALS['cm_config']['logging'] ?? [];
    if (empty($cfg['enabled'])) {
        return;
    }
    $path = $cfg['path'] ?? (__DIR__ . '/../storage/logs/app.log');
    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }

    // Never log secrets
    unset($context['token'], $context['host_token'], $context['participant_token'], $context['password'], $context['csrf_token']);

    $line = sprintf(
        "[%s] %s %s\n",
        date('Y-m-d H:i:s'),
        $message,
        $context ? json_encode($context, JSON_UNESCAPED_SLASHES) : ''
    );
    @file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
}

function cm_rate_limit(string $action, int $maxPerMinute): void
{
    $key = $action . ':' . cm_client_ip();
    $pdo = cm_db();
    $now = new DateTimeImmutable('now');
    $windowStart = $now->modify('-60 seconds')->format('Y-m-d H:i:s');

    $pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$windowStart]);

    $stmt = $pdo->prepare('SELECT id, hits, window_start FROM rate_limits WHERE rate_key = ? LIMIT 1');
    $stmt->execute([$key]);
    $row = $stmt->fetch();

    if (!$row) {
        $ins = $pdo->prepare('INSERT INTO rate_limits (rate_key, hits, window_start) VALUES (?, 1, ?)');
        $ins->execute([$key, $now->format('Y-m-d H:i:s')]);
        return;
    }

    $started = new DateTimeImmutable($row['window_start']);
    if ($started < $now->modify('-60 seconds')) {
        $upd = $pdo->prepare('UPDATE rate_limits SET hits = 1, window_start = ? WHERE id = ?');
        $upd->execute([$now->format('Y-m-d H:i:s'), $row['id']]);
        return;
    }

    if ((int) $row['hits'] >= $maxPerMinute) {
        cm_json_error('Too many requests. Please slow down.', 429);
    }

    $upd = $pdo->prepare('UPDATE rate_limits SET hits = hits + 1 WHERE id = ?');
    $upd->execute([$row['id']]);
}

function cm_apply_cors(): void
{
    $origins = $GLOBALS['cm_config']['security']['cors_origins'] ?? [];
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && is_array($origins)) {
        foreach ($origins as $allowed) {
            if ($origin === $allowed || str_starts_with($origin, rtrim($allowed, '/'))) {
                header('Access-Control-Allow-Origin: ' . $origin);
                header('Vary: Origin');
                header('Access-Control-Allow-Credentials: true');
                header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token, X-Participant-Token, X-Host-Token');
                header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
                break;
            }
        }
    }

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function cm_public_config(): array
{
    $cfg = $GLOBALS['cm_config'];
    return [
        'app_name' => $cfg['app']['name'],
        'base_url' => $cfg['app']['base_url'],
        'csrf_token' => cm_csrf_token(),
        'polling' => $cfg['polling'],
        'meeting' => [
            'participant_limit' => $cfg['meeting']['participant_limit'],
            'max_display_name' => $cfg['meeting']['max_display_name'],
            'max_chat_length' => $cfg['meeting']['max_chat_length'],
        ],
        'ice_servers' => $cfg['ice_servers'],
    ];
}

function cm_find_meeting_by_code(string $code): ?array
{
    $code = cm_normalize_meeting_code($code);
    $stmt = cm_db()->prepare('SELECT * FROM meetings WHERE meeting_code = ? LIMIT 1');
    $stmt->execute([$code]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function cm_meeting_is_joinable(array $meeting): ?string
{
    if ($meeting['status'] === 'ended') {
        return 'This meeting has ended.';
    }
    if ($meeting['status'] === 'expired') {
        return 'This meeting has expired.';
    }
    if (!empty($meeting['expires_at'])) {
        $expires = new DateTimeImmutable($meeting['expires_at']);
        if ($expires < new DateTimeImmutable('now')) {
            return 'This meeting has expired.';
        }
    }
    if ((int) $meeting['is_locked'] === 1) {
        return 'This meeting is locked by the host.';
    }
    return null;
}

function cm_active_participant_count(int $meetingId): int
{
    $timeout = max(5, (int) ($GLOBALS['cm_config']['meeting']['heartbeat_timeout_seconds'] ?? 45));
    $stmt = cm_db()->prepare(
        "SELECT COUNT(*) AS c FROM meeting_participants
         WHERE meeting_id = ? AND left_at IS NULL AND is_admitted = 1
           AND last_seen_at >= (NOW() - INTERVAL {$timeout} SECOND)"
    );
    $stmt->execute([$meetingId]);
    return (int) ($stmt->fetch()['c'] ?? 0);
}

function cm_get_participant_by_token(string $token): ?array
{
    $hash = cm_hash_token($token);
    $stmt = cm_db()->prepare(
        'SELECT p.*, m.meeting_code, m.status AS meeting_status, m.is_locked, m.host_token_hash
         FROM meeting_participants p
         INNER JOIN meetings m ON m.id = p.meeting_id
         WHERE p.participant_token_hash = ? AND p.left_at IS NULL
         LIMIT 1'
    );
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function cm_request_header(string $name): ?string
{
    $serverKey = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (!empty($_SERVER[$serverKey]) && is_string($_SERVER[$serverKey])) {
        return $_SERVER[$serverKey];
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $key => $value) {
            if (strcasecmp((string) $key, $name) === 0 && is_string($value) && $value !== '') {
                return $value;
            }
        }
    }
    return null;
}

function cm_read_participant_token(): ?string
{
    $token = cm_request_header('X-Participant-Token');
    if (is_string($token) && $token !== '') {
        return $token;
    }

    $input = cm_request_json();
    $token = $input['participant_token'] ?? null;
    if (is_string($token) && $token !== '') {
        return $token;
    }

    $token = $_POST['participant_token'] ?? null;
    if (is_string($token) && $token !== '') {
        return $token;
    }

    // Cookie backup for hosts that strip custom headers
    $token = $_COOKIE['cm_participant_token'] ?? null;
    if (is_string($token) && $token !== '') {
        return $token;
    }

    return null;
}

function cm_set_participant_cookie(string $token): void
{
    if ($token === '' || headers_sent()) {
        return;
    }
    $secure = !empty($GLOBALS['cm_config']['security']['session_secure_cookie'])
        || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    setcookie('cm_participant_token', $token, [
        'expires' => time() + 86400,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function cm_require_participant(): array
{
    $token = cm_read_participant_token();
    if (!is_string($token) || $token === '') {
        cm_json_error('Participant authentication required.', 401);
    }

    $participant = cm_get_participant_by_token($token);
    if (!$participant) {
        cm_json_error('Invalid or expired participant session.', 401);
    }

    if ($participant['meeting_status'] === 'ended' || $participant['meeting_status'] === 'expired') {
        cm_json_error('This meeting is no longer active.', 410);
    }

    // Touch heartbeat lightly on authenticated calls
    $upd = cm_db()->prepare('UPDATE meeting_participants SET last_seen_at = NOW() WHERE id = ?');
    $upd->execute([(int) $participant['id']]);

    $participant['_token'] = $token;
    return $participant;
}

function cm_require_host(array $participant): void
{
    if (($participant['role'] ?? '') !== 'host') {
        cm_json_error('Only the meeting host can perform this action.', 403);
    }
}

function cm_emit_event(int $meetingId, ?int $participantId, string $type, array $payload = []): int
{
    $stmt = cm_db()->prepare(
        'INSERT INTO meeting_events (meeting_id, participant_id, event_type, event_payload)
         VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([
        $meetingId,
        $participantId,
        $type,
        $payload ? json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
    ]);
    return (int) cm_db()->lastInsertId();
}

function cm_format_participant(array $p): array
{
    return [
        'id' => (int) $p['id'],
        'display_name' => $p['display_name'],
        'role' => $p['role'],
        'audio_enabled' => (bool) $p['audio_enabled'],
        'video_enabled' => (bool) $p['video_enabled'],
        'screen_sharing' => (bool) ($p['screen_sharing'] ?? false),
        'hand_raised' => (bool) $p['hand_raised'],
        'connection_state' => $p['connection_state'] ?? 'connected',
        'joined_at' => $p['joined_at'],
    ];
}

function cm_list_active_participants(int $meetingId): array
{
    $timeout = max(5, (int) ($GLOBALS['cm_config']['meeting']['heartbeat_timeout_seconds'] ?? 45));

    $stmt = cm_db()->prepare(
        "SELECT * FROM meeting_participants
         WHERE meeting_id = ? AND left_at IS NULL AND is_admitted = 1
           AND last_seen_at >= (NOW() - INTERVAL {$timeout} SECOND)
         ORDER BY FIELD(role, \"host\", \"participant\"), joined_at ASC"
    );
    $stmt->execute([$meetingId]);
    $rows = $stmt->fetchAll();
    return array_map('cm_format_participant', $rows);
}

function cm_mark_participant_left(int $participantId, int $meetingId, string $reason = 'left'): void
{
    $pdo = cm_db();
    $stmt = $pdo->prepare(
        'UPDATE meeting_participants
         SET left_at = NOW(), connection_state = ?, hand_raised = 0, screen_sharing = 0
         WHERE id = ? AND left_at IS NULL'
    );
    $stmt->execute([$reason, $participantId]);

    // Cleanup undelivered signals for this participant
    $pdo->prepare(
        'DELETE FROM signaling_messages WHERE from_participant_id = ? OR to_participant_id = ?'
    )->execute([$participantId, $participantId]);

    cm_emit_event($meetingId, $participantId, 'participant_left', [
        'participant_id' => $participantId,
        'reason' => $reason,
    ]);
}

function cm_cleanup_stale_participants(int $meetingId, ?int $exceptParticipantId = null): void
{
    $timeout = max(5, (int) ($GLOBALS['cm_config']['meeting']['heartbeat_timeout_seconds'] ?? 45));

    // Compare last_seen_at against MySQL NOW() so PHP/MySQL timezone drift cannot
    // mark a freshly joined host as timed-out (which ejected rooms to ?ended=1).
    $sql = "SELECT id FROM meeting_participants
            WHERE meeting_id = ? AND left_at IS NULL
              AND last_seen_at < (NOW() - INTERVAL {$timeout} SECOND)";
    $params = [$meetingId];
    if ($exceptParticipantId !== null && $exceptParticipantId > 0) {
        $sql .= ' AND id <> ?';
        $params[] = $exceptParticipantId;
    }
    $stmt = cm_db()->prepare($sql);
    $stmt->execute($params);
    $stale = $stmt->fetchAll();
    foreach ($stale as $row) {
        cm_mark_participant_left((int) $row['id'], $meetingId, 'timeout');
    }
}

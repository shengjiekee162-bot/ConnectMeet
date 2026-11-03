<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

try {
    switch ($action) {
        case 'bootstrap':
            if ($method !== 'GET') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_json_success(cm_public_config(), 'Bootstrap configuration');
            break;

        case 'create':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            cm_rate_limit('create', (int) ($GLOBALS['cm_config']['rate_limit']['create_per_minute'] ?? 10));
            handle_create_meeting();
            break;

        case 'validate':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_validate_meeting();
            break;

        case 'info':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_meeting_info();
            break;

        case 'lock':
        case 'unlock':
        case 'end':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            handle_host_meeting_action($action);
            break;

        default:
            cm_json_error('Unknown action.', 404);
    }
} catch (Throwable $e) {
    cm_log('meetings API error', ['error' => $e->getMessage(), 'action' => $action]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    cm_json_error($debug ? $e->getMessage() : 'Meeting operation failed.', 500);
}

function handle_create_meeting(): void
{
    $input = cm_request_json();
    $cfg = $GLOBALS['cm_config']['meeting'];

    $title = cm_sanitize_display_name((string) ($input['title'] ?? 'ConnectMeet Meeting'), (int) $cfg['max_title_length']);
    if ($title === '') {
        $title = 'ConnectMeet Meeting';
    }

    $displayName = cm_sanitize_display_name((string) ($input['display_name'] ?? 'Host'), (int) $cfg['max_display_name']);
    if ($displayName === '') {
        $displayName = 'Host';
    }

    $mode = (string) ($input['mode'] ?? 'instant'); // instant | scheduled
    $scheduledAt = null;
    if ($mode === 'scheduled' && !empty($input['scheduled_at'])) {
        $ts = strtotime((string) $input['scheduled_at']);
        if ($ts === false) {
            cm_json_error('Invalid scheduled time.');
        }
        $scheduledAt = date('Y-m-d H:i:s', $ts);
    }

    $limit = (int) ($input['participant_limit'] ?? $cfg['participant_limit']);
    $limit = max(2, min(16, $limit));

    $ttlHours = (int) $cfg['default_ttl_hours'];
    $expiresAt = (new DateTimeImmutable('now'))->modify('+' . $ttlHours . ' hours')->format('Y-m-d H:i:s');

    $hostToken = cm_generate_token(32);
    $hostTokenHash = cm_hash_token($hostToken);
    $participantToken = cm_generate_token(32);
    $participantTokenHash = cm_hash_token($participantToken);

    $pdo = cm_db();
    $pdo->beginTransaction();

    try {
        $code = null;
        for ($attempt = 0; $attempt < 12; $attempt++) {
            $candidate = cm_generate_meeting_code((int) $cfg['code_length']);
            $check = $pdo->prepare('SELECT id FROM meetings WHERE meeting_code = ? LIMIT 1');
            $check->execute([$candidate]);
            if (!$check->fetch()) {
                $code = $candidate;
                break;
            }
        }
        if ($code === null) {
            throw new RuntimeException('Unable to generate a unique meeting code.');
        }

        $status = ($mode === 'scheduled' && $scheduledAt !== null) ? 'scheduled' : 'active';

        $ins = $pdo->prepare(
            'INSERT INTO meetings
             (meeting_code, host_token_hash, title, status, scheduled_at, expires_at, is_locked, waiting_room_enabled, participant_limit)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'
        );
        $ins->execute([
            $code,
            $hostTokenHash,
            $title,
            $status,
            $scheduledAt,
            $expiresAt,
            !empty($cfg['waiting_room_default']) ? 1 : 0,
            $limit,
        ]);
        $meetingId = (int) $pdo->lastInsertId();

        $participantId = null;
        $autoJoin = ($mode !== 'scheduled');

        // Instant meetings auto-seat the host; scheduled meetings return a host token for later join.
        if ($autoJoin) {
            $pIns = $pdo->prepare(
                'INSERT INTO meeting_participants
                 (meeting_id, participant_token_hash, display_name, role, audio_enabled, video_enabled, connection_state, is_admitted)
                 VALUES (?, ?, ?, "host", 1, 1, "connected", 1)'
            );
            $pIns->execute([$meetingId, $participantTokenHash, $displayName]);
            $participantId = (int) $pdo->lastInsertId();
        }

        cm_emit_event($meetingId, $participantId, 'meeting_created', [
            'meeting_code' => $code,
            'mode' => $mode,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $response = [
        'meeting_id' => $meetingId,
        'meeting_code' => $code,
        'title' => $title,
        'status' => $status,
        'scheduled_at' => $scheduledAt,
        'expires_at' => $expiresAt,
        'participant_limit' => $limit,
        'join_url' => cm_meeting_url($code),
        'host_token' => $hostToken,
        'auto_joined' => $autoJoin,
        'ice_servers' => $GLOBALS['cm_config']['ice_servers'],
    ];

    if ($autoJoin && $participantId !== null) {
        $response['participant'] = [
            'id' => $participantId,
            'display_name' => $displayName,
            'role' => 'host',
            'token' => $participantToken,
        ];
        cm_set_participant_cookie($participantToken);
    }

    cm_json_success($response, 'Meeting created');
}

function handle_validate_meeting(): void
{
    $code = $_GET['meeting'] ?? (cm_request_json()['meeting_code'] ?? '');
    if (!is_string($code) || trim($code) === '') {
        cm_json_error('Meeting code is required.');
    }

    $meeting = cm_find_meeting_by_code($code);
    if (!$meeting) {
        cm_json_error('Meeting not found. Check the code and try again.', 404);
    }

    cm_cleanup_stale_participants((int) $meeting['id']);

    // Expire if needed
    if (!empty($meeting['expires_at']) && new DateTimeImmutable($meeting['expires_at']) < new DateTimeImmutable('now')) {
        $upd = cm_db()->prepare('UPDATE meetings SET status = "expired" WHERE id = ?');
        $upd->execute([(int) $meeting['id']]);
        cm_json_error('This meeting has expired.', 410);
    }

    $joinError = cm_meeting_is_joinable($meeting);
    $activeCount = cm_active_participant_count((int) $meeting['id']);
    $full = $activeCount >= (int) $meeting['participant_limit'];

    cm_json_success([
        'meeting_code' => $meeting['meeting_code'],
        'title' => $meeting['title'],
        'status' => $meeting['status'],
        'is_locked' => (bool) $meeting['is_locked'],
        'participant_limit' => (int) $meeting['participant_limit'],
        'participant_count' => $activeCount,
        'is_full' => $full,
        'scheduled_at' => $meeting['scheduled_at'],
        'joinable' => $joinError === null && !$full,
        'message' => $joinError ?? ($full ? 'This meeting is full.' : 'Meeting is available.'),
        'join_url' => cm_meeting_url($meeting['meeting_code']),
    ], $joinError ?? 'Validated');
}

function handle_meeting_info(): void
{
    $participant = cm_require_participant();
    $meetingId = (int) $participant['meeting_id'];
    cm_cleanup_stale_participants($meetingId);

    $stmt = cm_db()->prepare('SELECT * FROM meetings WHERE id = ? LIMIT 1');
    $stmt->execute([$meetingId]);
    $meeting = $stmt->fetch();
    if (!$meeting) {
        cm_json_error('Meeting not found.', 404);
    }

    cm_json_success([
        'meeting_code' => $meeting['meeting_code'],
        'title' => $meeting['title'],
        'status' => $meeting['status'],
        'is_locked' => (bool) $meeting['is_locked'],
        'participant_limit' => (int) $meeting['participant_limit'],
        'participant_count' => cm_active_participant_count($meetingId),
        'participants' => cm_list_active_participants($meetingId),
        'join_url' => cm_meeting_url($meeting['meeting_code']),
        'self' => cm_format_participant($participant),
        'ice_servers' => $GLOBALS['cm_config']['ice_servers'],
    ]);
}

function handle_host_meeting_action(string $action): void
{
    $participant = cm_require_participant();
    cm_require_host($participant);
    $meetingId = (int) $participant['meeting_id'];
    $pdo = cm_db();

    if ($action === 'lock') {
        $pdo->prepare('UPDATE meetings SET is_locked = 1 WHERE id = ?')->execute([$meetingId]);
        cm_emit_event($meetingId, (int) $participant['id'], 'meeting_locked');
        cm_json_success(null, 'Meeting locked');
    }

    if ($action === 'unlock') {
        $pdo->prepare('UPDATE meetings SET is_locked = 0 WHERE id = ?')->execute([$meetingId]);
        cm_emit_event($meetingId, (int) $participant['id'], 'meeting_unlocked');
        cm_json_success(null, 'Meeting unlocked');
    }

    if ($action === 'end') {
        $pdo->beginTransaction();
        try {
            $pdo->prepare('UPDATE meetings SET status = "ended" WHERE id = ?')->execute([$meetingId]);
            $pdo->prepare(
                'UPDATE meeting_participants SET left_at = NOW(), connection_state = "ended"
                 WHERE meeting_id = ? AND left_at IS NULL'
            )->execute([$meetingId]);
            $pdo->prepare('DELETE FROM signaling_messages WHERE meeting_id = ?')->execute([$meetingId]);
            cm_emit_event($meetingId, (int) $participant['id'], 'meeting_ended', [
                'ended_by' => (int) $participant['id'],
            ]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        cm_json_success(null, 'Meeting ended for everyone');
    }
}

<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

try {
    switch ($action) {
        case 'join':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            cm_rate_limit('join', (int) ($GLOBALS['cm_config']['rate_limit']['join_per_minute'] ?? 20));
            handle_join();
            break;

        case 'leave':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            handle_leave();
            break;

        case 'heartbeat':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_heartbeat();
            break;

        case 'list':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_list();
            break;

        case 'update_media':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            handle_update_media();
            break;

        case 'hand':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            handle_hand();
            break;

        case 'remove':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            handle_remove();
            break;

        default:
            cm_json_error('Unknown action.', 404);
    }
} catch (Throwable $e) {
    cm_log('participants API error', ['error' => $e->getMessage(), 'action' => $action]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    cm_json_error($debug ? $e->getMessage() : 'Participant operation failed.', 500);
}

function handle_join(): void
{
    $input = cm_request_json();
    $cfg = $GLOBALS['cm_config']['meeting'];

    $code = cm_normalize_meeting_code((string) ($input['meeting_code'] ?? ''));
    if ($code === '') {
        cm_json_error('Meeting code is required.');
    }

    $displayName = cm_sanitize_display_name((string) ($input['display_name'] ?? ''), (int) $cfg['max_display_name']);
    if ($displayName === '') {
        cm_json_error('Display name is required.');
    }

    $audio = array_key_exists('audio_enabled', $input) ? (bool) $input['audio_enabled'] : true;
    $video = array_key_exists('video_enabled', $input) ? (bool) $input['video_enabled'] : true;

    $pdo = cm_db();
    $pdo->beginTransaction();

    try {
        $stmt = $pdo->prepare('SELECT * FROM meetings WHERE meeting_code = ? FOR UPDATE');
        $stmt->execute([$code]);
        $meeting = $stmt->fetch();
        if (!$meeting) {
            $pdo->rollBack();
            cm_json_error('Meeting not found. Check the code and try again.', 404);
        }

        if (!empty($meeting['expires_at']) && new DateTimeImmutable($meeting['expires_at']) < new DateTimeImmutable('now')) {
            $pdo->prepare('UPDATE meetings SET status = "expired" WHERE id = ?')->execute([(int) $meeting['id']]);
            $pdo->rollBack();
            cm_json_error('This meeting has expired.', 410);
        }

        $joinError = cm_meeting_is_joinable($meeting);
        if ($joinError !== null) {
            $pdo->rollBack();
            cm_json_error($joinError, 403);
        }

        // Promote scheduled meetings to active on first join
        if ($meeting['status'] === 'scheduled') {
            $pdo->prepare('UPDATE meetings SET status = "active" WHERE id = ?')->execute([(int) $meeting['id']]);
            $meeting['status'] = 'active';
        }

        cm_cleanup_stale_participants((int) $meeting['id']);

        $meetingId = (int) $meeting['id'];
        $hostToken = cm_get_host_token_from_request();
        $existingToken = isset($input['participant_token']) && is_string($input['participant_token'])
            ? $input['participant_token']
            : null;

        // 1) Reconnect with an existing participant token (prevents duplicate selves)
        if ($existingToken) {
            $tokenStmt = $pdo->prepare(
                'SELECT * FROM meeting_participants
                 WHERE meeting_id = ? AND participant_token_hash = ?
                 LIMIT 1'
            );
            $tokenStmt->execute([$meetingId, cm_hash_token($existingToken)]);
            $existing = $tokenStmt->fetch();
            if ($existing) {
                $pdo->prepare(
                    'UPDATE meeting_participants
                     SET display_name = ?, audio_enabled = ?, video_enabled = ?,
                         left_at = NULL, last_seen_at = NOW(), connection_state = "connected", is_admitted = 1
                     WHERE id = ?'
                )->execute([
                    $displayName,
                    $audio ? 1 : 0,
                    $video ? 1 : 0,
                    (int) $existing['id'],
                ]);

                cm_emit_event($meetingId, (int) $existing['id'], 'participant_joined', [
                    'participant_id' => (int) $existing['id'],
                    'display_name' => $displayName,
                    'role' => $existing['role'],
                    'audio_enabled' => $audio,
                    'video_enabled' => $video,
                    'reconnected' => true,
                ]);

                $pdo->commit();
                cm_set_participant_cookie($existingToken);

                cm_json_success([
                    'meeting_id' => $meetingId,
                    'meeting_code' => $meeting['meeting_code'],
                    'title' => $meeting['title'],
                    'join_url' => cm_meeting_url($meeting['meeting_code']),
                    'reconnected' => true,
                    'participant' => [
                        'id' => (int) $existing['id'],
                        'display_name' => $displayName,
                        'role' => $existing['role'],
                        'token' => $existingToken,
                        'audio_enabled' => $audio,
                        'video_enabled' => $video,
                    ],
                    'participants' => cm_list_active_participants($meetingId),
                    'ice_servers' => $GLOBALS['cm_config']['ice_servers'],
                    'polling' => $GLOBALS['cm_config']['polling'],
                ], 'Reconnected to meeting');
            }
        }

        // 2) Host token reclaim: reuse the host seat instead of creating a second self
        $role = 'participant';
        if ($hostToken && cm_verify_host_token($meeting, $hostToken)) {
            $hostRow = $pdo->prepare(
                'SELECT * FROM meeting_participants
                 WHERE meeting_id = ? AND role = "host"
                 ORDER BY id ASC
                 LIMIT 1'
            );
            $hostRow->execute([$meetingId]);
            $hostParticipant = $hostRow->fetch();

            if ($hostParticipant) {
                $token = cm_generate_token(32);
                $tokenHash = cm_hash_token($token);
                $pdo->prepare(
                    'UPDATE meeting_participants
                     SET participant_token_hash = ?, display_name = ?, audio_enabled = ?, video_enabled = ?,
                         left_at = NULL, last_seen_at = NOW(), connection_state = "connected", is_admitted = 1
                     WHERE id = ?'
                )->execute([
                    $tokenHash,
                    $displayName,
                    $audio ? 1 : 0,
                    $video ? 1 : 0,
                    (int) $hostParticipant['id'],
                ]);

                cm_emit_event($meetingId, (int) $hostParticipant['id'], 'participant_joined', [
                    'participant_id' => (int) $hostParticipant['id'],
                    'display_name' => $displayName,
                    'role' => 'host',
                    'audio_enabled' => $audio,
                    'video_enabled' => $video,
                    'reclaimed_host' => true,
                ]);

                $pdo->commit();
                cm_set_participant_cookie($token);

                cm_json_success([
                    'meeting_id' => $meetingId,
                    'meeting_code' => $meeting['meeting_code'],
                    'title' => $meeting['title'],
                    'join_url' => cm_meeting_url($meeting['meeting_code']),
                    'reconnected' => true,
                    'participant' => [
                        'id' => (int) $hostParticipant['id'],
                        'display_name' => $displayName,
                        'role' => 'host',
                        'token' => $token,
                        'audio_enabled' => $audio,
                        'video_enabled' => $video,
                    ],
                    'participants' => cm_list_active_participants($meetingId),
                    'ice_servers' => $GLOBALS['cm_config']['ice_servers'],
                    'polling' => $GLOBALS['cm_config']['polling'],
                ], 'Reclaimed host seat');
            }

            // No host row yet — this join becomes the host
            $role = 'host';
        }

        $activeCount = cm_active_participant_count($meetingId);
        if ($activeCount >= (int) $meeting['participant_limit']) {
            $pdo->rollBack();
            cm_json_error('This meeting has reached its participant limit.', 403);
        }

        $token = cm_generate_token(32);
        $tokenHash = cm_hash_token($token);

        $ins = $pdo->prepare(
            'INSERT INTO meeting_participants
             (meeting_id, participant_token_hash, display_name, role, audio_enabled, video_enabled, connection_state, is_admitted)
             VALUES (?, ?, ?, ?, ?, ?, "connected", 1)'
        );
        $ins->execute([
            $meetingId,
            $tokenHash,
            $displayName,
            $role,
            $audio ? 1 : 0,
            $video ? 1 : 0,
        ]);
        $participantId = (int) $pdo->lastInsertId();

        cm_emit_event($meetingId, $participantId, 'participant_joined', [
            'participant_id' => $participantId,
            'display_name' => $displayName,
            'role' => $role,
            'audio_enabled' => $audio,
            'video_enabled' => $video,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    cm_set_participant_cookie($token);

    cm_json_success([
        'meeting_id' => (int) $meeting['id'],
        'meeting_code' => $meeting['meeting_code'],
        'title' => $meeting['title'],
        'join_url' => cm_meeting_url($meeting['meeting_code']),
        'participant' => [
            'id' => $participantId,
            'display_name' => $displayName,
            'role' => $role,
            'token' => $token,
            'audio_enabled' => $audio,
            'video_enabled' => $video,
        ],
        'participants' => cm_list_active_participants((int) $meeting['id']),
        'ice_servers' => $GLOBALS['cm_config']['ice_servers'],
        'polling' => $GLOBALS['cm_config']['polling'],
    ], 'Joined meeting');
}

function handle_leave(): void
{
    $participant = cm_require_participant();
    cm_mark_participant_left((int) $participant['id'], (int) $participant['meeting_id'], 'left');
    cm_json_success(null, 'Left meeting');
}

function handle_heartbeat(): void
{
    $participant = cm_require_participant();
    $meetingId = (int) $participant['meeting_id'];
    cm_cleanup_stale_participants($meetingId, (int) $participant['id']);

    $input = cm_request_json();
    $connectionState = (string) ($input['connection_state'] ?? 'connected');
    $allowed = ['joining', 'connected', 'reconnecting', 'failed'];
    if (!in_array($connectionState, $allowed, true)) {
        $connectionState = 'connected';
    }

    cm_db()->prepare(
        'UPDATE meeting_participants SET last_seen_at = NOW(), connection_state = ? WHERE id = ?'
    )->execute([$connectionState, (int) $participant['id']]);

    cm_json_success([
        'server_time' => date('c'),
        'participants' => cm_list_active_participants($meetingId),
        'meeting_status' => $participant['meeting_status'],
    ], 'Heartbeat ok');
}

function handle_list(): void
{
    $participant = cm_require_participant();
    $meetingId = (int) $participant['meeting_id'];
    cm_cleanup_stale_participants($meetingId);
    cm_json_success([
        'participants' => cm_list_active_participants($meetingId),
    ]);
}

function handle_update_media(): void
{
    $participant = cm_require_participant();
    $input = cm_request_json();
    $meetingId = (int) $participant['meeting_id'];

    $audio = array_key_exists('audio_enabled', $input) ? (bool) $input['audio_enabled'] : (bool) $participant['audio_enabled'];
    $video = array_key_exists('video_enabled', $input) ? (bool) $input['video_enabled'] : (bool) $participant['video_enabled'];
    $screen = array_key_exists('screen_sharing', $input) ? (bool) $input['screen_sharing'] : (bool) $participant['screen_sharing'];

    cm_db()->prepare(
        'UPDATE meeting_participants
         SET audio_enabled = ?, video_enabled = ?, screen_sharing = ?, last_seen_at = NOW()
         WHERE id = ?'
    )->execute([$audio ? 1 : 0, $video ? 1 : 0, $screen ? 1 : 0, (int) $participant['id']]);

    $payload = [
        'participant_id' => (int) $participant['id'],
        'audio_enabled' => $audio,
        'video_enabled' => $video,
        'screen_sharing' => $screen,
    ];
    cm_emit_event($meetingId, (int) $participant['id'], 'media_state', $payload);

    if (array_key_exists('screen_sharing', $input)) {
        cm_emit_event(
            $meetingId,
            (int) $participant['id'],
            $screen ? 'screen_share_started' : 'screen_share_stopped',
            $payload
        );
    }

    cm_json_success($payload, 'Media state updated');
}

function handle_hand(): void
{
    $participant = cm_require_participant();
    cm_rate_limit('events', (int) ($GLOBALS['cm_config']['rate_limit']['events_per_minute'] ?? 60));

    $input = cm_request_json();
    $raised = !empty($input['raised']);

    cm_db()->prepare(
        'UPDATE meeting_participants SET hand_raised = ?, last_seen_at = NOW() WHERE id = ?'
    )->execute([$raised ? 1 : 0, (int) $participant['id']]);

    $payload = [
        'participant_id' => (int) $participant['id'],
        'hand_raised' => $raised,
        'display_name' => $participant['display_name'],
    ];
    cm_emit_event((int) $participant['meeting_id'], (int) $participant['id'], 'hand_state', $payload);
    cm_json_success($payload, $raised ? 'Hand raised' : 'Hand lowered');
}

function handle_remove(): void
{
    $participant = cm_require_participant();
    cm_require_host($participant);

    $input = cm_request_json();
    $targetId = (int) ($input['participant_id'] ?? 0);
    if ($targetId <= 0) {
        cm_json_error('participant_id is required.');
    }
    if ($targetId === (int) $participant['id']) {
        cm_json_error('Use leave to remove yourself.');
    }

    $stmt = cm_db()->prepare(
        'SELECT * FROM meeting_participants WHERE id = ? AND meeting_id = ? AND left_at IS NULL LIMIT 1'
    );
    $stmt->execute([$targetId, (int) $participant['meeting_id']]);
    $target = $stmt->fetch();
    if (!$target) {
        cm_json_error('Participant not found in this meeting.', 404);
    }
    if ($target['role'] === 'host') {
        cm_json_error('Cannot remove the host.', 403);
    }

    cm_mark_participant_left($targetId, (int) $participant['meeting_id'], 'removed');
    cm_emit_event((int) $participant['meeting_id'], (int) $participant['id'], 'participant_removed', [
        'participant_id' => $targetId,
        'removed_by' => (int) $participant['id'],
    ]);

    cm_json_success(['participant_id' => $targetId], 'Participant removed');
}

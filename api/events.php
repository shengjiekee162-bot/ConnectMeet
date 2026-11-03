<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? 'poll';

try {
    switch ($action) {
        case 'poll':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_poll_events();
            break;

        case 'reaction':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            cm_rate_limit('events', (int) ($GLOBALS['cm_config']['rate_limit']['events_per_minute'] ?? 60));
            handle_reaction();
            break;

        default:
            cm_json_error('Unknown action.', 404);
    }
} catch (Throwable $e) {
    cm_log('events API error', ['error' => $e->getMessage(), 'action' => $action]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    cm_json_error($debug ? $e->getMessage() : 'Events operation failed.', 500);
}

function handle_poll_events(): void
{
    $participant = cm_require_participant();
    $meetingId = (int) $participant['meeting_id'];

    $input = cm_request_json();
    $afterId = (int) ($_GET['after_id'] ?? ($input['after_id'] ?? 0));

    cm_cleanup_stale_participants($meetingId);

    $stmt = cm_db()->prepare(
        'SELECT id, participant_id, event_type, event_payload, created_at
         FROM meeting_events
         WHERE meeting_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT 100'
    );
    $stmt->execute([$meetingId, $afterId]);
    $rows = $stmt->fetchAll();

    $events = [];
    foreach ($rows as $row) {
        $payload = null;
        if (!empty($row['event_payload'])) {
            $payload = json_decode((string) $row['event_payload'], true);
        }
        $events[] = [
            'id' => (int) $row['id'],
            'participant_id' => $row['participant_id'] !== null ? (int) $row['participant_id'] : null,
            'event_type' => $row['event_type'],
            'payload' => $payload,
            'created_at' => $row['created_at'],
        ];
    }

    // Also return current participants snapshot for sync
    $meetingStmt = cm_db()->prepare('SELECT status, is_locked FROM meetings WHERE id = ? LIMIT 1');
    $meetingStmt->execute([$meetingId]);
    $meeting = $meetingStmt->fetch() ?: ['status' => 'ended', 'is_locked' => 0];

    cm_json_success([
        'events' => $events,
        'participants' => cm_list_active_participants($meetingId),
        'meeting_status' => $meeting['status'],
        'is_locked' => (bool) $meeting['is_locked'],
        'server_time' => date('c'),
    ]);
}

function handle_reaction(): void
{
    $participant = cm_require_participant();
    $input = cm_request_json();

    $emoji = trim((string) ($input['emoji'] ?? ''));
    $allowed = ['👍', '👏', '❤️', '😂', '😮', '🎉', '✋', '🔥'];
    if (!in_array($emoji, $allowed, true)) {
        cm_json_error('Unsupported reaction.');
    }

    $payload = [
        'participant_id' => (int) $participant['id'],
        'display_name' => $participant['display_name'],
        'emoji' => $emoji,
    ];
    $eventId = cm_emit_event((int) $participant['meeting_id'], (int) $participant['id'], 'reaction', $payload);

    cm_json_success(['event_id' => $eventId] + $payload, 'Reaction sent');
}

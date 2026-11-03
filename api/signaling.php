<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

try {
    switch ($action) {
        case 'send':
            if ($method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            cm_require_csrf();
            cm_rate_limit('signal', (int) ($GLOBALS['cm_config']['rate_limit']['signal_per_minute'] ?? 120));
            handle_send_signal();
            break;

        case 'poll':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_poll_signals();
            break;

        default:
            cm_json_error('Unknown action.', 404);
    }
} catch (Throwable $e) {
    cm_log('signaling API error', ['error' => $e->getMessage(), 'action' => $action]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    cm_json_error($debug ? $e->getMessage() : 'Signaling operation failed.', 500);
}

function handle_send_signal(): void
{
    $participant = cm_require_participant();
    $input = cm_request_json();

    $toId = (int) ($input['to_participant_id'] ?? 0);
    $type = (string) ($input['signal_type'] ?? '');
    $payload = $input['payload'] ?? null;

    $allowed = ['offer', 'answer', 'ice-candidate', 'renegotiate'];
    if (!in_array($type, $allowed, true)) {
        cm_json_error('Invalid signal_type.');
    }
    if ($toId <= 0 || $toId === (int) $participant['id']) {
        cm_json_error('Invalid to_participant_id.');
    }
    if ($payload === null) {
        cm_json_error('payload is required.');
    }

    // Limit payload size (SDP/ICE can be moderately large)
    $encoded = is_string($payload) ? $payload : json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($encoded === false || strlen($encoded) > 200000) {
        cm_json_error('Signal payload too large.', 413);
    }

    $meetingId = (int) $participant['meeting_id'];

    $stmt = cm_db()->prepare(
        'SELECT id FROM meeting_participants
         WHERE id = ? AND meeting_id = ? AND left_at IS NULL LIMIT 1'
    );
    $stmt->execute([$toId, $meetingId]);
    if (!$stmt->fetch()) {
        cm_json_error('Target participant is not in this meeting.', 404);
    }

    $ins = cm_db()->prepare(
        'INSERT INTO signaling_messages
         (meeting_id, from_participant_id, to_participant_id, signal_type, payload)
         VALUES (?, ?, ?, ?, ?)'
    );
    $ins->execute([
        $meetingId,
        (int) $participant['id'],
        $toId,
        $type,
        $encoded,
    ]);

    cm_json_success([
        'signal_id' => (int) cm_db()->lastInsertId(),
    ], 'Signal queued');
}

function handle_poll_signals(): void
{
    $participant = cm_require_participant();
    $meetingId = (int) $participant['meeting_id'];
    $selfId = (int) $participant['id'];

    // Clean very old undelivered signals (older than 2 minutes)
    cm_db()->prepare(
        'DELETE FROM signaling_messages
         WHERE meeting_id = ? AND created_at < (NOW() - INTERVAL 2 MINUTE)'
    )->execute([$meetingId]);

    $longPoll = (int) ($GLOBALS['cm_config']['polling']['long_poll_timeout_seconds'] ?? 0);
    $deadline = microtime(true) + max(0, min(25, $longPoll));
    $messages = [];

    do {
        $stmt = cm_db()->prepare(
            'SELECT id, from_participant_id, signal_type, payload, created_at
             FROM signaling_messages
             WHERE to_participant_id = ? AND meeting_id = ? AND delivered = 0
             ORDER BY id ASC
             LIMIT 50'
        );
        $stmt->execute([$selfId, $meetingId]);
        $rows = $stmt->fetchAll();

        if ($rows) {
            $ids = array_map(static fn($r) => (int) $r['id'], $rows);
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $mark = cm_db()->prepare("UPDATE signaling_messages SET delivered = 1 WHERE id IN ($placeholders)");
            $mark->execute($ids);

            foreach ($rows as $row) {
                $payload = json_decode((string) $row['payload'], true);
                $messages[] = [
                    'id' => (int) $row['id'],
                    'from_participant_id' => (int) $row['from_participant_id'],
                    'signal_type' => $row['signal_type'],
                    'payload' => $payload ?? $row['payload'],
                    'created_at' => $row['created_at'],
                ];
            }
            break;
        }

        if (microtime(true) >= $deadline) {
            break;
        }
        usleep(400000);
    } while (true);

    cm_json_success([
        'signals' => $messages,
        'server_time' => date('c'),
    ]);
}

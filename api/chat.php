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
            cm_rate_limit('chat', (int) ($GLOBALS['cm_config']['rate_limit']['chat_per_minute'] ?? 30));
            handle_send_chat();
            break;

        case 'poll':
            if ($method !== 'GET' && $method !== 'POST') {
                cm_json_error('Method not allowed.', 405);
            }
            handle_poll_chat();
            break;

        default:
            cm_json_error('Unknown action.', 404);
    }
} catch (Throwable $e) {
    cm_log('chat API error', ['error' => $e->getMessage(), 'action' => $action]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    cm_json_error($debug ? $e->getMessage() : 'Chat operation failed.', 500);
}

function handle_send_chat(): void
{
    $participant = cm_require_participant();
    $input = cm_request_json();
    $maxLen = (int) ($GLOBALS['cm_config']['meeting']['max_chat_length'] ?? 500);

    $content = trim((string) ($input['message'] ?? ''));
    // Strip tags — store plain text only
    $content = strip_tags($content);
    $content = preg_replace("/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]/", '', $content) ?? '';

    if ($content === '') {
        cm_json_error('Message cannot be empty.');
    }
    if (mb_strlen($content) > $maxLen) {
        cm_json_error("Message exceeds {$maxLen} characters.");
    }

    $stmt = cm_db()->prepare(
        'INSERT INTO meeting_messages (meeting_id, participant_id, message_type, message_content)
         VALUES (?, ?, "text", ?)'
    );
    $stmt->execute([
        (int) $participant['meeting_id'],
        (int) $participant['id'],
        $content,
    ]);
    $messageId = (int) cm_db()->lastInsertId();

    $payload = [
        'message_id' => $messageId,
        'participant_id' => (int) $participant['id'],
        'display_name' => $participant['display_name'],
        'message' => $content,
        'created_at' => date('Y-m-d H:i:s'),
    ];
    cm_emit_event((int) $participant['meeting_id'], (int) $participant['id'], 'chat_message', $payload);

    cm_json_success($payload, 'Message sent');
}

function handle_poll_chat(): void
{
    $participant = cm_require_participant();
    $input = cm_request_json();
    $afterId = (int) ($_GET['after_id'] ?? ($input['after_id'] ?? 0));

    $stmt = cm_db()->prepare(
        'SELECT m.id, m.participant_id, m.message_content, m.created_at, p.display_name
         FROM meeting_messages m
         INNER JOIN meeting_participants p ON p.id = m.participant_id
         WHERE m.meeting_id = ? AND m.id > ?
         ORDER BY m.id ASC
         LIMIT 100'
    );
    $stmt->execute([(int) $participant['meeting_id'], $afterId]);
    $rows = $stmt->fetchAll();

    $messages = [];
    foreach ($rows as $row) {
        $messages[] = [
            'message_id' => (int) $row['id'],
            'participant_id' => (int) $row['participant_id'],
            'display_name' => $row['display_name'],
            'message' => $row['message_content'],
            'created_at' => $row['created_at'],
        ];
    }

    cm_json_success(['messages' => $messages]);
}

<?php
/**
 * Cleanup expired meetings, stale participants, old signals and rate-limit rows.
 * Run via CLI cron: php scripts/cleanup.php
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    // Allow authenticated local web trigger only in debug mode with a simple key
    require_once dirname(__DIR__) . '/includes/bootstrap.php';
    $key = $_GET['key'] ?? '';
    if (empty($GLOBALS['cm_config']['app']['debug']) || $key !== 'local-cleanup') {
        http_response_code(403);
        echo 'Forbidden';
        exit;
    }
} else {
    require_once dirname(__DIR__) . '/includes/bootstrap.php';
}

$pdo = cm_db();
$stats = [
    'expired_meetings' => 0,
    'stale_participants' => 0,
    'old_signals' => 0,
    'old_events' => 0,
    'rate_limits' => 0,
];

// Expire meetings past expires_at
$stmt = $pdo->prepare(
    'UPDATE meetings SET status = "expired"
     WHERE status IN ("active", "scheduled") AND expires_at IS NOT NULL AND expires_at < NOW()'
);
$stmt->execute();
$stats['expired_meetings'] = $stmt->rowCount();

// Mark stale participants as left
$timeout = max(5, (int) ($GLOBALS['cm_config']['meeting']['heartbeat_timeout_seconds'] ?? 45));
$stmt = $pdo->prepare(
    "SELECT id, meeting_id FROM meeting_participants
     WHERE left_at IS NULL AND last_seen_at < (NOW() - INTERVAL {$timeout} SECOND)"
);
$stmt->execute();
foreach ($stmt->fetchAll() as $row) {
    cm_mark_participant_left((int) $row['id'], (int) $row['meeting_id'], 'timeout');
    $stats['stale_participants']++;
}

// Delete delivered/old signals
$stmt = $pdo->prepare(
    'DELETE FROM signaling_messages
     WHERE delivered = 1 OR created_at < (NOW() - INTERVAL 1 HOUR)'
);
$stmt->execute();
$stats['old_signals'] = $stmt->rowCount();

// Trim old events (keep 7 days)
$stmt = $pdo->prepare('DELETE FROM meeting_events WHERE created_at < (NOW() - INTERVAL 7 DAY)');
$stmt->execute();
$stats['old_events'] = $stmt->rowCount();

$stmt = $pdo->prepare('DELETE FROM rate_limits WHERE window_start < (NOW() - INTERVAL 1 HOUR)');
$stmt->execute();
$stats['rate_limits'] = $stmt->rowCount();

cm_log('Cleanup completed', $stats);

if (PHP_SAPI === 'cli') {
    echo json_encode(['success' => true, 'data' => $stats, 'message' => 'Cleanup completed'], JSON_PRETTY_PRINT) . PHP_EOL;
} else {
    cm_json_success($stats, 'Cleanup completed');
}

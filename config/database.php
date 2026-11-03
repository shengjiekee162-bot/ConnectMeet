<?php

declare(strict_types=1);

/**
 * PDO connection factory.
 */
function cm_db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $config = $GLOBALS['cm_config']['database'] ?? null;
    if (!is_array($config)) {
        throw new RuntimeException('Database configuration missing.');
    }

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $config['host'],
        (int) $config['port'],
        $config['name'],
        $config['charset'] ?? 'utf8mb4'
    );

    $pdo = new PDO($dsn, $config['user'], $config['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    // Align MySQL NOW()/CURRENT_TIMESTAMP with app timezone.
    // Shared hosts often stay on UTC while PHP uses Asia/Kuala_Lumpur — that made
    // heartbeat cleanup treat every participant as stale and kick them immediately.
    $tzName = (string) ($GLOBALS['cm_config']['app']['timezone'] ?? 'UTC');
    try {
        $offset = (new DateTimeImmutable('now', new DateTimeZone($tzName)))->format('P');
        $pdo->exec('SET time_zone = ' . $pdo->quote($offset));
    } catch (Throwable $e) {
        // Non-fatal: queries below also use NOW() - INTERVAL for last_seen checks.
    }

    return $pdo;
}

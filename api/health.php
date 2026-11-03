<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/includes/bootstrap.php';

$checks = [
    'app' => true,
    'database' => false,
    'time' => date('c'),
];

try {
    cm_db()->query('SELECT 1');
    $checks['database'] = true;
    cm_json_success($checks, 'Healthy');
} catch (Throwable $e) {
    cm_log('Health check failed', ['error' => $e->getMessage()]);
    cm_json_error('Database unavailable', 503, $checks);
}

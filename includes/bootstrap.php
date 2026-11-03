<?php

declare(strict_types=1);

$configPath = dirname(__DIR__) . '/config/config.php';
$examplePath = dirname(__DIR__) . '/config/config.example.php';

if (!is_file($configPath)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "ConnectMeet is not configured. Copy config/config.example.php to config/config.php and set your database credentials.";
    exit;
}

$GLOBALS['cm_config'] = require $configPath;

date_default_timezone_set($GLOBALS['cm_config']['app']['timezone'] ?? 'UTC');

$sec = $GLOBALS['cm_config']['security'] ?? [];
$sessionName = $GLOBALS['cm_config']['app']['session_name'] ?? 'CONNECTMEETSESSID';

if (session_status() !== PHP_SESSION_ACTIVE) {
    session_name($sessionName);
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => !empty($sec['session_secure_cookie']),
        'httponly' => $sec['session_httponly'] ?? true,
        'samesite' => $sec['session_samesite'] ?? 'Lax',
    ]);
    session_start();
}

require_once dirname(__DIR__) . '/config/database.php';
require_once __DIR__ . '/response.php';
require_once __DIR__ . '/functions.php';
require_once __DIR__ . '/csrf.php';
require_once __DIR__ . '/auth.php';

cm_apply_cors();

// Catch unexpected errors as JSON for API routes
set_exception_handler(static function (Throwable $e): void {
    cm_log('Unhandled exception', ['error' => $e->getMessage()]);
    $debug = !empty($GLOBALS['cm_config']['app']['debug']);
    $msg = $debug ? $e->getMessage() : 'An unexpected server error occurred.';
    if (!headers_sent()) {
        cm_json_error($msg, 500);
    }
    echo $msg;
    exit;
});

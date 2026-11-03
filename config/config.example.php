<?php
/**
 * ConnectMeet configuration example.
 * Copy this file to config.php and adjust values for your environment.
 * Never commit config.php with real credentials.
 */

declare(strict_types=1);

return [
    'app' => [
        'name' => 'ConnectMeet',
        'env' => 'local', // local | production
        'debug' => true,
        'base_url' => 'http://localhost:8000',
        'timezone' => 'Asia/Kuala_Lumpur',
        'session_name' => 'CONNECTMEETSESSID',
        'csrf_token_name' => 'cm_csrf',
    ],

    'database' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'name' => 'connectmeet',
        'user' => 'root',
        'pass' => 'YOUR_DB_PASSWORD',
        'charset' => 'utf8mb4',
    ],

    'meeting' => [
        'participant_limit' => 8,
        'code_length' => 9,
        'default_ttl_hours' => 24,
        'heartbeat_timeout_seconds' => 45,
        'stale_cleanup_seconds' => 60,
        'max_display_name' => 60,
        'max_chat_length' => 500,
        'max_title_length' => 120,
        'waiting_room_default' => false,
    ],

    'polling' => [
        'interval_ms' => 1000,
        'error_backoff_ms' => 3000,
        // Keep 0 unless using a multi-worker PHP setup; long poll blocks other API calls on single-thread servers
        'long_poll_timeout_seconds' => 0,
        'request_timeout_ms' => 8000,
    ],

    'rate_limit' => [
        'chat_per_minute' => 30,
        'signal_per_minute' => 120,
        'events_per_minute' => 60,
        'join_per_minute' => 20,
        'create_per_minute' => 10,
    ],

    'security' => [
        'cors_origins' => [
            'http://localhost',
            'http://127.0.0.1',
            'http://localhost/connectmeet',
        ],
        'session_secure_cookie' => false, // set true behind HTTPS
        'session_httponly' => true,
        'session_samesite' => 'Lax',
        'hash_algo' => 'sha256',
    ],

    // Public STUN is fine for learning. Production restrictive networks need TURN.
    'ice_servers' => [
        ['urls' => 'stun:stun.l.google.com:19302'],
        ['urls' => 'stun:stun1.l.google.com:19302'],
        // Example TURN (uncomment and replace):
        // [
        //     'urls' => 'turn:turn.example.com:3478',
        //     'username' => 'user',
        //     'credential' => 'pass',
        // ],
    ],

    'logging' => [
        'enabled' => true,
        'path' => __DIR__ . '/../storage/logs/app.log',
    ],
];

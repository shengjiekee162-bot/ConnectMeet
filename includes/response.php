<?php

declare(strict_types=1);

function cm_json_response(bool $success, mixed $data = null, string $message = '', int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store, no-cache, must-revalidate');

    echo json_encode([
        'success' => $success,
        'data' => $data,
        'message' => $message,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    exit;
}

function cm_json_error(string $message, int $status = 400, mixed $data = null): void
{
    cm_json_response(false, $data, $message, $status);
}

function cm_json_success(mixed $data = null, string $message = 'OK', int $status = 200): void
{
    cm_json_response(true, $data, $message, $status);
}

<?php

declare(strict_types=1);

function cm_csrf_token(): string
{
    $name = $GLOBALS['cm_config']['app']['csrf_token_name'] ?? 'cm_csrf';
    if (empty($_SESSION[$name]) || !is_string($_SESSION[$name])) {
        $_SESSION[$name] = bin2hex(random_bytes(32));
    }
    return $_SESSION[$name];
}

function cm_csrf_validate(?string $token): bool
{
    $name = $GLOBALS['cm_config']['app']['csrf_token_name'] ?? 'cm_csrf';
    $sessionToken = $_SESSION[$name] ?? '';
    if (!is_string($sessionToken) || $sessionToken === '' || !is_string($token) || $token === '') {
        return false;
    }
    return hash_equals($sessionToken, $token);
}

function cm_require_csrf(): void
{
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null;
    if ($token === null) {
        $input = cm_request_json();
        $token = $input['csrf_token'] ?? ($_POST['csrf_token'] ?? null);
    }

    if (!cm_csrf_validate(is_string($token) ? $token : null)) {
        cm_json_error('Invalid or missing CSRF token.', 403);
    }
}

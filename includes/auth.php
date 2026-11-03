<?php

declare(strict_types=1);

/**
 * Guest-host authentication helpers.
 * Full user accounts are optional; meetings can be hosted with a secure host token.
 */

function cm_verify_host_token(array $meeting, ?string $hostToken): bool
{
    if (!is_string($hostToken) || $hostToken === '') {
        return false;
    }
    return hash_equals((string) $meeting['host_token_hash'], cm_hash_token($hostToken));
}

function cm_get_host_token_from_request(): ?string
{
    $token = function_exists('cm_request_header') ? cm_request_header('X-Host-Token') : null;
    if (is_string($token) && $token !== '') {
        return $token;
    }
    $input = cm_request_json();
    $token = $input['host_token'] ?? ($_COOKIE['cm_host_token'] ?? null);
    return is_string($token) && $token !== '' ? $token : null;
}

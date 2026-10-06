<?php

namespace App\Http;

use Illuminate\Http\JsonResponse;

/**
 * The Node version's HttpError (src/lib/validate.js): an exception carrying an
 * HTTP status, a message and optional details, rendered by the error handler as
 * { "error": { "message": "...", "details": ... } }.
 *
 * Every validation failure in this app raises one of these, so the JSON error
 * shape is identical to the original.
 */
class HttpError extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly mixed $details = null,
    ) {
        parent::__construct($message);
    }

    public static function badRequest(string $message, mixed $details = null): self
    {
        return new self(400, $message, $details);
    }

    public static function unauthorized(string $message = 'Authentication required.'): self
    {
        return new self(401, $message);
    }

    public static function forbidden(string $message = 'You do not have permission to perform this action.'): self
    {
        return new self(403, $message);
    }

    public static function notFound(string $message = 'Not found.'): self
    {
        return new self(404, $message);
    }

    public static function tooManyRequests(string $message): self
    {
        return new self(429, $message);
    }

    public function toResponse(): JsonResponse
    {
        $payload = ['error' => ['message' => $this->getMessage()]];

        if ($this->details !== null) {
            $payload['error']['details'] = $this->details;
        }

        return response()->json($payload, $this->status);
    }
}

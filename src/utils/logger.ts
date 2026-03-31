let debugEnabled = false;

/**
 * Patterns that may indicate sensitive data in log messages.
 * These are redacted to prevent credential leaks in logs.
 */
const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /api[_-]?key["\s:=]+[A-Za-z0-9\-._~+/]{8,}/gi,
  /token["\s:=]+[A-Za-z0-9\-._~+/]{8,}/gi,
  /secret["\s:=]+[A-Za-z0-9\-._~+/]{8,}/gi,
  /password["\s:=]+\S+/gi,
];

function sanitizeLogMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export function log(message: string): void {
  console.error(`[openclaw-mcp] ${sanitizeLogMessage(message)}`);
}

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function logDebug(messageOrFactory: string | (() => string)): void {
  if (!debugEnabled) {
    return;
  }
  const message = typeof messageOrFactory === 'function' ? messageOrFactory() : messageOrFactory;
  console.error(`[openclaw-mcp] DEBUG: ${sanitizeLogMessage(message)}`);
}

export function logError(message: string, error?: unknown): void {
  console.error(`[openclaw-mcp] ERROR: ${sanitizeLogMessage(message)}`);
  if (error) {
    // Only log the error message, not the full object (which may contain request/response bodies)
    if (error instanceof Error) {
      console.error(`[openclaw-mcp] ${sanitizeLogMessage(error.message)}`);
    } else {
      console.error('[openclaw-mcp] (non-Error object thrown)');
    }
  }
}

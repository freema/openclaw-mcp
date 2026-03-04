/**
 * Input validation utilities for MCP tool handlers.
 *
 * Provides string length checks, numeric range validation,
 * and control character rejection to harden tool inputs.
 *
 * Uses flat result interfaces (not discriminated unions) for
 * compatibility with strict: false TypeScript configuration.
 */

/** Control character pattern (C0 and C1 control chars, excluding common whitespace) */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_ID_LENGTH = 256;

/** Validation result with all properties always present */
export interface StringValidation {
  valid: boolean;
  value: string;
  error: string;
}

/**
 * Validate that input is a non-null object.
 */
export function validateInputIsObject(input: unknown): input is Record<string, unknown> {
  return (
    input !== null && input !== undefined && typeof input === 'object' && !Array.isArray(input)
  );
}

/**
 * Validate a string field: checks type, max length, trims, rejects control characters.
 */
export function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number
): StringValidation {
  if (typeof value !== 'string') {
    return { valid: false, value: '', error: `${fieldName} must be a string` };
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return { valid: false, value: '', error: `${fieldName} must not be empty` };
  }

  if (trimmed.length > maxLength) {
    return {
      valid: false,
      value: '',
      error: `${fieldName} exceeds maximum length of ${maxLength} characters`,
    };
  }

  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { valid: false, value: '', error: `${fieldName} contains invalid control characters` };
  }

  return { valid: true, value: trimmed, error: '' };
}

/**
 * Validate a message string (max 100,000 chars).
 */
export function validateMessage(value: unknown): StringValidation {
  return validateString(value, 'message', MAX_MESSAGE_LENGTH);
}

/**
 * Validate an ID string (max 256 chars, no control characters).
 */
export function validateId(value: unknown, fieldName: string): StringValidation {
  return validateString(value, fieldName, MAX_ID_LENGTH);
}

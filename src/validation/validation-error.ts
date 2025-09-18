import type Joi from 'joi';

export class ConfigValidationError extends Error {
  public readonly details: Joi.ValidationErrorItem[];
  public readonly path?: string;

  constructor(message: string, validationError?: Joi.ValidationError) {
    super(message);
    this.name = 'ConfigValidationError';
    this.details = validationError?.details || [];

    if (validationError?.details && validationError.details.length > 0) {
      this.path = validationError.details[0].path.join('.');
    }

    // Maintain proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigValidationError);
    }
  }

  /**
   * Get a formatted error message with all validation details
   */
  getFormattedMessage(): string {
    if (this.details.length === 0) {
      return this.message;
    }

    const errorMessages = this.details.map(detail => {
      const path = detail.path.length > 0 ? `${detail.path.join('.')}: ` : '';
      return `${path}${detail.message}`;
    });

    return `${this.message}\n${errorMessages.join('\n')}`;
  }

  /**
   * Get validation errors grouped by field path
   */
  getErrorsByPath(): Record<string, string[]> {
    const errorsByPath: Record<string, string[]> = {};

    this.details.forEach(detail => {
      const path = detail.path.join('.') || 'root';
      if (!errorsByPath[path]) {
        errorsByPath[path] = [];
      }
      errorsByPath[path].push(detail.message);
    });

    return errorsByPath;
  }

  /**
   * Check if a specific field has validation errors
   */
  hasErrorForField(fieldPath: string): boolean {
    return this.details.some(detail => detail.path.join('.') === fieldPath);
  }

  /**
   * Get all error messages for a specific field
   */
  getErrorsForField(fieldPath: string): string[] {
    return this.details
      .filter(detail => detail.path.join('.') === fieldPath)
      .map(detail => detail.message);
  }
}
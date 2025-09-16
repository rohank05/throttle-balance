import type { Request } from 'express';
import type { Logger } from '../types/index.js';

export function createDefaultKeyGenerator(): (req: Request) => string {
  return (req: Request): string => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  };
}

export function createDefaultLogger(): Logger {
  const logLevel = process.env['FLOW_CONTROL_LOG_LEVEL'] || 'info';
  const levels: Record<string, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  const currentLevel = levels[logLevel] || 2;

  return {
    error(message: string, meta?: any): void {
      if (currentLevel >= 0) {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, meta ? meta : '');
      }
    },
    warn(message: string, meta?: any): void {
      if (currentLevel >= 1) {
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, meta ? meta : '');
      }
    },
    info(message: string, meta?: any): void {
      if (currentLevel >= 2) {
        console.info(`[INFO] ${new Date().toISOString()} - ${message}`, meta ? meta : '');
      }
    },
    debug(message: string, meta?: any): void {
      if (currentLevel >= 3) {
        console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`, meta ? meta : '');
      }
    },
  };
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function createServerKey(host: string, port: number, protocol: string = 'http'): string {
  return `${protocol}://${host}:${port}`;
}

export function getResetTime(windowMs: number): number {
  return Date.now() + windowMs;
}

export function getRemainingTime(resetTime: number): number {
  return Math.max(0, resetTime - Date.now());
}

export function validateConfig(config: any, requiredFields: string[]): void {
  for (const field of requiredFields) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`Required configuration field '${field}' is missing`);
    }
  }
}

export function createDefaults<T>(provided: Partial<T>, defaults: T): T {
  return { ...defaults, ...provided };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseIntWithDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
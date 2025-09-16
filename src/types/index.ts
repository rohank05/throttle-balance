import type { Request, Response, NextFunction } from 'express';

export type KeyGenerator = (req: Request) => string;
export type SkipFunction = (req: Request) => boolean;

export interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: KeyGenerator;
  skip?: SkipFunction;
  message?: string;
  statusCode?: number;
  headers?: boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface ServerConfig {
  host: string;
  port: number;
  protocol?: 'http' | 'https';
  weight?: number;
  metadata?: Record<string, any>;
}

export interface HealthCheckConfig {
  enabled?: boolean;
  endpoint?: string;
  interval?: number;
  timeout?: number;
  retries?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

export interface LoadBalancerConfig {
  servers: ServerConfig[];
  algorithm?: 'round-robin';
  healthCheck?: HealthCheckConfig;
  proxyTimeout?: number;
  retryAttempts?: number;
}

export interface FlowControlConfig {
  rateLimiter?: RateLimiterConfig;
  loadBalancer?: LoadBalancerConfig;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  info: RateLimitInfo;
}

export interface ServerHealth {
  server: ServerConfig;
  healthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  responseTime?: number;
  error?: string;
}

export interface LoadBalancerStats {
  totalRequests: number;
  totalErrors: number;
  serverStats: Map<string, ServerStats>;
}

export interface ServerStats {
  requests: number;
  errors: number;
  totalResponseTime: number;
  averageResponseTime: number;
  lastUsed: Date;
}

export interface FlowControlMiddleware {
  (req: Request, res: Response, next: NextFunction): void | Promise<void>;
}

export interface Store {
  get(key: string): Promise<number | undefined>;
  set(key: string, value: number, ttl: number): Promise<void>;
  increment(key: string, ttl: number): Promise<number>;
  clear(): Promise<void>;
}

export interface LogLevel {
  ERROR: 'error';
  WARN: 'warn';
  INFO: 'info';
  DEBUG: 'debug';
}

export interface Logger {
  error(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
}

export class FlowControlError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 500) {
    super(message);
    this.name = 'FlowControlError';
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, FlowControlError);
  }
}

export class RateLimitError extends FlowControlError {
  public readonly rateLimitInfo: RateLimitInfo;

  constructor(message: string, rateLimitInfo: RateLimitInfo) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429);
    this.name = 'RateLimitError';
    this.rateLimitInfo = rateLimitInfo;
  }
}

export class LoadBalancerError extends FlowControlError {
  constructor(message: string, code: string = 'LOAD_BALANCER_ERROR') {
    super(message, code, 503);
    this.name = 'LoadBalancerError';
  }
}
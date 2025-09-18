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
  store?: 'memory' | 'redis';
  redis?: RedisConfig;
}

export type RequiredRateLimiterConfig = Required<Omit<RateLimiterConfig, 'redis'>> & {
  redis?: RedisConfig;
};

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
  type?: 'http' | 'https' | 'tcp';
  expectedStatusCodes?: number[];
  expectedResponseBody?: string | RegExp;
  headers?: Record<string, string>;
}

export interface LoadBalancerConfig {
  servers: ServerConfig[];
  algorithm?: 'round-robin';
  healthCheck?: HealthCheckConfig;
  proxyTimeout?: number;
  retryAttempts?: number;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  recoveryTimeout?: number;
  monitoringPeriod?: number;
  expectedFailureRate?: number;
  minimumRequests?: number;
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
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  enableOfflineQueue?: boolean;
  cluster?: {
    enabledNodes: Array<{ host: string; port: number }>;
    enableReadyCheck?: boolean;
    maxRedirections?: number;
  };
  sentinel?: {
    sentinels: Array<{ host: string; port: number }>;
    name: string;
    password?: string;
  };
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

export interface IPRule {
  ip: string;
  action: 'allow' | 'block' | 'log';
  description?: string;
  priority?: number;
}

export interface IPFilterConfig {
  mode?: 'whitelist' | 'blacklist' | 'hybrid';
  defaultAction?: 'allow' | 'block' | 'log';
  whitelist?: string[];
  blacklist?: string[];
  rules?: IPRule[];
  trustProxy?: boolean;
  logActions?: boolean;
  onBlocked?: (req: Request, ip: string, rule?: IPRule) => void;
  onAllowed?: (req: Request, ip: string, rule?: IPRule) => void;
}

export interface IPFilterResult {
  allowed: boolean;
  action: 'allow' | 'block' | 'log';
  ip: string;
  rule?: IPRule;
  reason: string;
}

export interface SecurityRateLimitConfig {
  windowMs?: number;
  maxAttempts?: number;
  blockDuration?: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  store?: Store;
  onLimitReached?: (req: Request, key: string) => void;
  onBlocked?: (req: Request, key: string, resetTime: number) => void;
}

export interface SecurityRateLimitInfo {
  totalHits: number;
  resetTime: number;
  remaining: number;
  blocked: boolean;
  blockUntil?: number;
}

export interface SecurityRateLimitResult {
  allowed: boolean;
  info: SecurityRateLimitInfo;
}

export interface ValidationRule {
  field: string;
  type: 'string' | 'number' | 'boolean' | 'email' | 'url' | 'json' | 'custom';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  validator?: (value: any) => boolean | string;
  sanitize?: boolean;
  allowedValues?: any[];
}

export interface RequestValidationConfig {
  headers?: ValidationRule[];
  query?: ValidationRule[];
  body?: ValidationRule[];
  params?: ValidationRule[];
  maxBodySize?: number;
  allowedContentTypes?: string[];
  sanitizeInput?: boolean;
  strictMode?: boolean;
  onValidationError?: (req: Request, errors: ValidationError[]) => void;
}

export interface ValidationError {
  field: string;
  location: 'header' | 'query' | 'body' | 'param';
  message: string;
  value?: any;
  rule?: ValidationRule;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  sanitizedData?: {
    headers?: Record<string, any>;
    query?: Record<string, any>;
    body?: any;
    params?: Record<string, any>;
  };
}

export interface SecurityHeadersConfig {
  contentSecurityPolicy?: {
    enabled?: boolean;
    directives?: Record<string, string | string[]>;
    reportOnly?: boolean;
    reportUri?: string;
  };
  strictTransportSecurity?: {
    enabled?: boolean;
    maxAge?: number;
    includeSubDomains?: boolean;
    preload?: boolean;
  };
  xFrameOptions?: {
    enabled?: boolean;
    value?: 'DENY' | 'SAMEORIGIN' | string;
  };
  xContentTypeOptions?: {
    enabled?: boolean;
  };
  xXSSProtection?: {
    enabled?: boolean;
    mode?: 'block' | 'report';
    reportUri?: string;
  };
  referrerPolicy?: {
    enabled?: boolean;
    policy?: 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' |
            'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';
  };
  permissionsPolicy?: {
    enabled?: boolean;
    directives?: Record<string, string | string[]>;
  };
  crossOriginEmbedderPolicy?: {
    enabled?: boolean;
    value?: 'unsafe-none' | 'require-corp';
  };
  crossOriginOpenerPolicy?: {
    enabled?: boolean;
    value?: 'unsafe-none' | 'same-origin-allow-popups' | 'same-origin';
  };
  crossOriginResourcePolicy?: {
    enabled?: boolean;
    value?: 'same-site' | 'same-origin' | 'cross-origin';
  };
  customHeaders?: Record<string, string>;
  removeHeaders?: string[];
  reportUri?: string;
}

export interface SecurityHeadersStats {
  headersSet: Record<string, string>;
  headersRemoved: string[];
  reportUri?: string;
  totalRequests: number;
}

export interface LogContext {
  correlationId?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  component?: string;
  operation?: string;
  duration?: number;
  statusCode?: number;
  errorCode?: string;
  metadata?: Record<string, any>;
}

export interface LogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

export interface LogTransport {
  name: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  write(entry: LogEntry): Promise<void> | void;
}

export interface StructuredLoggerConfig {
  level?: 'error' | 'warn' | 'info' | 'debug';
  transports?: LogTransport[];
  defaultContext?: LogContext;
  enableStackTrace?: boolean;
  enableTimestamp?: boolean;
  timestampFormat?: 'iso' | 'unix' | 'custom';
  customTimestampFormatter?: () => string;
  enableColors?: boolean;
  prettyPrint?: boolean;
  maskSensitiveData?: boolean;
  sensitiveFields?: string[];
}

export interface LoggingMiddlewareConfig {
  logger?: any; // StructuredLogger
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  includeHeaders?: boolean;
  excludeHeaders?: string[];
  includeQuery?: boolean;
  includeParams?: boolean;
  logRequests?: boolean;
  logResponses?: boolean;
  logErrors?: boolean;
  logLevel?: 'info' | 'debug';
  generateRequestId?: boolean;
  requestIdHeader?: string;
  maxBodySize?: number;
  skipPaths?: (string | RegExp)[];
  skipUserAgents?: (string | RegExp)[];
  customFields?: (req: Request, res: Response) => Record<string, any>;
  sanitizeHeaders?: (headers: Record<string, any>) => Record<string, any>;
  sanitizeBody?: (body: any) => any;
}

export interface RequestContext {
  requestId: string;
  startTime: number;
  method: string;
  url: string;
  path: string;
  query?: Record<string, any>;
  params?: Record<string, any>;
  headers?: Record<string, any>;
  body?: any;
  userAgent?: string;
  ip?: string | undefined;
  userId?: string;
  sessionId?: string;
}

export interface ResponseContext {
  statusCode: number;
  headers?: Record<string, any>;
  body?: any;
  size?: number;
  duration: number;
}
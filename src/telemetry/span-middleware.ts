import type { Request, Response, NextFunction } from 'express';
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api';
import type { OpenTelemetryTracer } from './otel-tracer.js';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface SpanMiddlewareConfig {
  enabled?: boolean;
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  requestBodySizeLimit?: number;
  responseBodySizeLimit?: number;
  sensitiveHeaders?: string[];
  excludePaths?: string[];
  customSpanNamer?: (req: Request) => string;
}

export interface RequestTiming {
  startTime: [number, number];
  requestReceivedAt: number;
  rateLimiterDuration?: number;
  loadBalancerDuration?: number;
  proxyDuration?: number;
  totalDuration?: number;
}

// Extend Express Request to include tracing information
declare module 'express-serve-static-core' {
  interface Request {
    traceId?: string;
    spanId?: string;
    timing?: RequestTiming;
    flowControlMetadata?: Record<string, any>;
  }
}

export class SpanMiddleware {
  private readonly config: Required<SpanMiddlewareConfig>;
  private readonly tracer: OpenTelemetryTracer;
  private readonly logger: Logger;

  constructor(
    tracer: OpenTelemetryTracer,
    config: SpanMiddlewareConfig = {},
    logger?: Logger
  ) {
    this.tracer = tracer;
    this.logger = logger || createDefaultLogger();

    this.config = {
      enabled: config.enabled ?? true,
      includeRequestBody: config.includeRequestBody ?? false,
      includeResponseBody: config.includeResponseBody ?? false,
      requestBodySizeLimit: config.requestBodySizeLimit ?? 1024, // 1KB
      responseBodySizeLimit: config.responseBodySizeLimit ?? 1024, // 1KB
      sensitiveHeaders: config.sensitiveHeaders ?? [
        'authorization',
        'cookie',
        'x-api-key',
        'x-auth-token',
      ],
      excludePaths: config.excludePaths ?? ['/health', '/metrics', '/favicon.ico'],
      customSpanNamer: config.customSpanNamer ?? this.defaultSpanNamer,
    };

    this.logger.info('Span middleware initialized', {
      enabled: this.config.enabled,
      excludePaths: this.config.excludePaths,
    });
  }

  private defaultSpanNamer(req: Request): string {
    return `${req.method} ${req.route?.path || req.path}`;
  }

  private shouldTraceRequest(req: Request): boolean {
    if (!this.config.enabled || !this.tracer.isEnabled()) {
      return false;
    }

    // Check if path should be excluded
    const path = req.path;
    return !this.config.excludePaths.some(excludePath =>
      path.startsWith(excludePath)
    );
  }

  private sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
    const sanitized = { ...headers };

    for (const sensitiveHeader of this.config.sensitiveHeaders) {
      if (sanitized[sensitiveHeader]) {
        sanitized[sensitiveHeader] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  private truncateBody(body: any, limit: number): string {
    if (!body) return '';

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    if (bodyStr.length <= limit) {
      return bodyStr;
    }

    return bodyStr.substring(0, limit) + '...[TRUNCATED]';
  }

  private getClientIP(req: Request): string {
    return (
      (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
      (req.headers['x-real-ip'] as string) ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      'unknown'
    );
  }

  createMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!this.shouldTraceRequest(req)) {
        return next();
      }

      const startTime = process.hrtime();
      const requestReceivedAt = Date.now();

      // Initialize request timing
      req.timing = {
        startTime,
        requestReceivedAt,
      };

      const spanName = this.config.customSpanNamer(req);
      const span = this.tracer.startSpan(spanName, {
        'http.method': req.method,
        'http.url': req.url,
        'http.scheme': req.protocol,
        'http.host': req.get('host') || 'unknown',
        'http.target': req.originalUrl,
        'http.route': req.route?.path || req.path,
        'http.user_agent': req.get('user-agent') || 'unknown',
        'http.client_ip': this.getClientIP(req),
        'http.request_content_length': req.get('content-length') || '0',
        'flow_control.request.id': `${Date.now()}-${Math.random().toString(36)}`,
      }, SpanKind.SERVER);

      if (!span) {
        return next();
      }

      // Store trace information in request
      const spanContext = span.spanContext();
      req.traceId = spanContext.traceId;
      req.spanId = spanContext.spanId;

      // Add request headers (sanitized)
      const sanitizedHeaders = this.sanitizeHeaders(req.headers);
      Object.entries(sanitizedHeaders).forEach(([key, value]) => {
        span.setAttributes({ [`http.request.header.${key}`]: String(value) });
      });

      // Add request body if configured
      if (this.config.includeRequestBody && req.body) {
        const bodyStr = this.truncateBody(req.body, this.config.requestBodySizeLimit);
        span.setAttributes({ 'http.request.body': bodyStr });
      }

      // Track response details
      const originalSend = res.send;
      const originalJson = res.json;
      let responseBody: any;

      res.send = function(body: any) {
        responseBody = body;
        return originalSend.call(this, body);
      };

      res.json = function(body: any) {
        responseBody = body;
        return originalJson.call(this, body);
      };

      // Handle response completion
      const finishSpan = () => {
        const duration = process.hrtime(startTime);
        const durationMs = duration[0] * 1000 + duration[1] * 1e-6;

        // Update request timing
        req.timing!.totalDuration = durationMs;

        // Set response attributes
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_content_length': res.get('content-length') || '0',
          'http.response.duration_ms': durationMs,
        });

        // Add response headers
        Object.entries(res.getHeaders()).forEach(([key, value]) => {
          span.setAttributes({ [`http.response.header.${key}`]: String(value) });
        });

        // Add response body if configured
        if (this.config.includeResponseBody && responseBody) {
          const bodyStr = this.truncateBody(responseBody, this.config.responseBodySizeLimit);
          span.setAttributes({ 'http.response.body': bodyStr });
        }

        // Add Flow Control specific metadata if available
        if (req.flowControlMetadata) {
          Object.entries(req.flowControlMetadata).forEach(([key, value]) => {
            span.setAttributes({ [`flow_control.${key}`]: String(value) });
          });
        }

        // Add timing breakdown if available
        if (req.timing) {
          if (req.timing.rateLimiterDuration) {
            span.setAttributes({ 'flow_control.rate_limiter.duration_ms': req.timing.rateLimiterDuration });
          }
          if (req.timing.loadBalancerDuration) {
            span.setAttributes({ 'flow_control.load_balancer.duration_ms': req.timing.loadBalancerDuration });
          }
          if (req.timing.proxyDuration) {
            span.setAttributes({ 'flow_control.proxy.duration_ms': req.timing.proxyDuration });
          }
        }

        // Set span status based on HTTP status code
        if (res.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode}`,
          });

          if (res.statusCode >= 500) {
            span.setAttributes({
              'error': true,
              'error.type': 'http_error',
              'error.status_code': res.statusCode,
            });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      };

      // Listen for response events
      res.on('finish', finishSpan);
      res.on('error', (error: Error) => {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.setAttributes({
          'error': true,
          'error.type': 'response_error',
          'error.message': error.message,
        });
        finishSpan();
      });

      // Execute middleware chain within span context
      context.with(trace.setSpan(context.active(), span), () => {
        next();
      });
    };
  }

  // Utility methods for Flow Control components to add timing information
  static recordRateLimiterTiming(req: Request, duration: number): void {
    if (req.timing) {
      req.timing.rateLimiterDuration = duration;
    }
    if (req.flowControlMetadata) {
      req.flowControlMetadata['rateLimiterDuration'] = duration;
    } else {
      req.flowControlMetadata = { rateLimiterDuration: duration };
    }
  }

  static recordLoadBalancerTiming(req: Request, duration: number, selectedServer?: string): void {
    if (req.timing) {
      req.timing.loadBalancerDuration = duration;
    }
    if (req.flowControlMetadata) {
      req.flowControlMetadata.loadBalancerDuration = duration;
      if (selectedServer) {
        req.flowControlMetadata.selectedServer = selectedServer;
      }
    } else {
      req.flowControlMetadata = {
        loadBalancerDuration: duration,
        ...(selectedServer && { selectedServer }),
      };
    }
  }

  static recordProxyTiming(req: Request, duration: number, targetUrl?: string): void {
    if (req.timing) {
      req.timing.proxyDuration = duration;
    }
    if (req.flowControlMetadata) {
      req.flowControlMetadata.proxyDuration = duration;
      if (targetUrl) {
        req.flowControlMetadata.targetUrl = targetUrl;
      }
    } else {
      req.flowControlMetadata = {
        proxyDuration: duration,
        ...(targetUrl && { targetUrl }),
      };
    }
  }

  static recordSecurityEvent(
    req: Request,
    eventType: string,
    details: Record<string, any>
  ): void {
    if (req.flowControlMetadata) {
      req.flowControlMetadata[`security_${eventType}`] = details;
    } else {
      req.flowControlMetadata = { [`security_${eventType}`]: details };
    }

    // Add span event for immediate visibility
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent(`security.${eventType}`, {
        'security.event_type': eventType,
        ...details,
      });
    }
  }

  static recordCircuitBreakerEvent(
    req: Request,
    service: string,
    state: string,
    details: Record<string, any>
  ): void {
    const eventData = { service, state, ...details };

    if (req.flowControlMetadata) {
      req.flowControlMetadata.circuitBreakerEvent = eventData;
    } else {
      req.flowControlMetadata = { circuitBreakerEvent: eventData };
    }

    // Add span event
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent('circuit_breaker.state_change', {
        'circuit_breaker.service': service,
        'circuit_breaker.state': state,
        ...details,
      });
    }
  }

  static recordRateLimitResult(
    req: Request,
    allowed: boolean,
    remaining: number,
    limit: number
  ): void {
    const resultData = { allowed, remaining, limit };

    if (req.flowControlMetadata) {
      req.flowControlMetadata.rateLimitResult = resultData;
    } else {
      req.flowControlMetadata = { rateLimitResult: resultData };
    }

    // Add span attributes
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttributes({
        'rate_limiter.allowed': allowed,
        'rate_limiter.remaining': remaining,
        'rate_limiter.limit': limit,
      });

      if (!allowed) {
        span.addEvent('rate_limit.blocked', {
          'rate_limiter.reason': 'limit_exceeded',
          'rate_limiter.remaining': remaining,
          'rate_limiter.limit': limit,
        });
      }
    }
  }

  // Configuration methods
  updateConfig(newConfig: Partial<SpanMiddlewareConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Span middleware configuration updated', newConfig);
  }

  isEnabled(): boolean {
    return this.config.enabled && this.tracer.isEnabled();
  }

  disable(): void {
    this.config.enabled = false;
    this.logger.info('Span middleware disabled');
  }

  enable(): void {
    this.config.enabled = true;
    this.logger.info('Span middleware enabled');
  }
}
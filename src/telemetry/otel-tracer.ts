import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  trace,
  SpanStatusCode,
  SpanKind,
  type Tracer,
  type Span,
  type SpanAttributes,
  context,
  propagation,
} from '@opentelemetry/api';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface OpenTelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  enabled?: boolean;
  jaeger?: {
    endpoint?: string;
    agentHost?: string;
    agentPort?: number;
  };
  prometheus?: {
    endpoint?: string;
    port?: number;
  };
  sampling?: {
    ratio?: number;
  };
  resource?: {
    attributes?: Record<string, string>;
  };
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage?: Record<string, string>;
}

export class OpenTelemetryTracer {
  private readonly config: Required<OpenTelemetryConfig>;
  private readonly logger: Logger;
  private sdk?: NodeSDK;
  private tracer?: Tracer;
  private readonly serviceName: string;

  constructor(config: OpenTelemetryConfig = {}, logger?: Logger) {
    this.logger = logger || createDefaultLogger();
    this.serviceName = config.serviceName || 'flow-control';

    this.config = {
      serviceName: this.serviceName,
      serviceVersion: config.serviceVersion || '1.0.0',
      enabled: config.enabled ?? true,
      jaeger: {
        endpoint: config.jaeger?.endpoint || 'http://localhost:14268/api/traces',
        agentHost: config.jaeger?.agentHost || 'localhost',
        agentPort: config.jaeger?.agentPort || 6832,
        ...config.jaeger,
      },
      prometheus: {
        endpoint: config.prometheus?.endpoint || '/metrics',
        port: config.prometheus?.port || 9090,
        ...config.prometheus,
      },
      sampling: {
        ratio: config.sampling?.ratio || 0.1, // 10% sampling by default
        ...config.sampling,
      },
      resource: {
        attributes: config.resource?.attributes || {},
        ...config.resource,
      },
    };

    if (this.config.enabled) {
      this.initialize();
    }

    this.logger.info('OpenTelemetry tracer configured', {
      serviceName: this.config.serviceName,
      enabled: this.config.enabled,
      jaegerEndpoint: this.config.jaeger.endpoint,
    });
  }

  private initialize(): void {
    try {
      // Create resource with service information
      const resource = new Resource({
        [ATTR_SERVICE_NAME]: this.config.serviceName,
        [ATTR_SERVICE_VERSION]: this.config.serviceVersion,
        'service.namespace': 'api-gateway',
        'service.instance.id': `${this.config.serviceName}-${process.pid}`,
        ...this.config.resource.attributes,
      });

      // Configure exporters
      const exporters = [];

      // Jaeger exporter for tracing
      if (this.config.jaeger.endpoint) {
        exporters.push(
          new JaegerExporter({
            endpoint: this.config.jaeger.endpoint,
          })
        );
      }

      // Configure SDK
      this.sdk = new NodeSDK({
        resource,
        traceExporter: exporters.length > 0 ? exporters[0] : undefined,
        instrumentations: [
          getNodeAutoInstrumentations({
            // Disable some instrumentations that might be too noisy
            '@opentelemetry/instrumentation-dns': { enabled: false },
            '@opentelemetry/instrumentation-net': { enabled: false },
            '@opentelemetry/instrumentation-fs': { enabled: false },
            // Enable HTTP and Express instrumentation
            '@opentelemetry/instrumentation-http': {
              enabled: true,
              requestHook: (span, request) => {
                span.setAttributes({
                  'http.request.header.user-agent': request.headers['user-agent'],
                  'http.request.header.x-forwarded-for': request.headers['x-forwarded-for'],
                });
              },
            },
            '@opentelemetry/instrumentation-express': {
              enabled: true,
              requestHook: (span, info) => {
                span.setAttributes({
                  'express.route': info.route,
                  'express.request.method': info.request.method,
                });
              },
            },
            // Redis instrumentation for our Redis store
            '@opentelemetry/instrumentation-redis': { enabled: true },
          }),
        ],
      });

      // Start the SDK
      this.sdk.start();

      // Get tracer instance
      this.tracer = trace.getTracer(this.config.serviceName, this.config.serviceVersion);

      this.logger.info('OpenTelemetry SDK initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize OpenTelemetry SDK', error);
      throw error;
    }
  }

  getTracer(): Tracer | undefined {
    return this.tracer;
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.tracer;
  }

  // Convenience methods for creating spans
  startSpan(
    name: string,
    attributes?: SpanAttributes,
    spanKind?: SpanKind
  ): Span | undefined {
    if (!this.tracer) {
      return undefined;
    }

    return this.tracer.startSpan(name, {
      kind: spanKind || SpanKind.INTERNAL,
      attributes: {
        'service.name': this.config.serviceName,
        ...attributes,
      },
    });
  }

  // Wrapper for executing code within a span
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    attributes?: SpanAttributes,
    spanKind?: SpanKind
  ): Promise<T> {
    const span = this.startSpan(name, attributes, spanKind);

    if (!span) {
      // If tracing is disabled, just execute the function
      return await fn(span as any);
    }

    try {
      const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      if (error instanceof Error) {
        span.recordException(error);
        span.setAttributes({
          'error.name': error.name,
          'error.message': error.message,
        });
      }

      throw error;
    } finally {
      span.end();
    }
  }

  // Rate limiter specific tracing
  traceRateLimiterOperation<T>(
    operation: string,
    key: string,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      `rate_limiter.${operation}`,
      fn,
      {
        'rate_limiter.operation': operation,
        'rate_limiter.key': key,
        'rate_limiter.store_type': 'unknown', // Will be set by the calling code
      },
      SpanKind.INTERNAL
    );
  }

  // Load balancer specific tracing
  traceLoadBalancerOperation<T>(
    operation: string,
    server: string,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      `load_balancer.${operation}`,
      fn,
      {
        'load_balancer.operation': operation,
        'load_balancer.server': server,
        'load_balancer.algorithm': 'round-robin', // Default
      },
      SpanKind.CLIENT
    );
  }

  // Health check specific tracing
  traceHealthCheck<T>(
    server: string,
    checkType: string,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      'health_check.execute',
      fn,
      {
        'health_check.server': server,
        'health_check.type': checkType,
      },
      SpanKind.CLIENT
    );
  }

  // Circuit breaker specific tracing
  traceCircuitBreakerOperation<T>(
    operation: string,
    service: string,
    breakerName: string,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      `circuit_breaker.${operation}`,
      fn,
      {
        'circuit_breaker.operation': operation,
        'circuit_breaker.service': service,
        'circuit_breaker.name': breakerName,
      },
      SpanKind.INTERNAL
    );
  }

  // Security operation tracing
  traceSecurityOperation<T>(
    operation: string,
    details: Record<string, any>,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      `security.${operation}`,
      fn,
      {
        'security.operation': operation,
        ...details,
      },
      SpanKind.INTERNAL
    );
  }

  // HTTP proxy tracing
  traceProxyRequest<T>(
    targetUrl: string,
    method: string,
    fn: (span?: Span) => Promise<T> | T
  ): Promise<T> {
    return this.withSpan(
      'proxy.request',
      fn,
      {
        'http.method': method,
        'http.url': targetUrl,
        'proxy.target': targetUrl,
      },
      SpanKind.CLIENT
    );
  }

  // Context propagation utilities
  getCurrentTraceContext(): TraceContext | undefined {
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan) {
      return undefined;
    }

    const spanContext = activeSpan.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: undefined, // Would need to track parent separately
    };
  }

  injectTraceContext(headers: Record<string, string>): void {
    if (!this.tracer) {
      return;
    }

    propagation.inject(context.active(), headers);
  }

  extractTraceContext(headers: Record<string, string | string[] | undefined>): void {
    if (!this.tracer) {
      return;
    }

    const parentContext = propagation.extract(context.active(), headers);
    context.with(parentContext, () => {
      // The extracted context is now active for subsequent operations
    });
  }

  // Baggage utilities for cross-cutting concerns
  setBaggage(key: string, value: string): void {
    const activeBaggage = propagation.getActiveBaggage();
    if (activeBaggage) {
      activeBaggage.setEntry(key, { value });
    }
  }

  getBaggage(key: string): string | undefined {
    const activeBaggage = propagation.getActiveBaggage();
    return activeBaggage?.getEntry(key)?.value;
  }

  // Span manipulation utilities
  addSpanEvent(name: string, attributes?: SpanAttributes): void {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent(name, attributes);
    }
  }

  setSpanAttributes(attributes: SpanAttributes): void {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttributes(attributes);
    }
  }

  recordException(error: Error, attributes?: SpanAttributes): void {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(error, attributes);
      activeSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    }
  }

  // Metrics and tracing correlation
  getTraceMetadata(): Record<string, string> {
    const context = this.getCurrentTraceContext();
    if (!context) {
      return {};
    }

    return {
      'trace.id': context.traceId,
      'span.id': context.spanId,
    };
  }

  // Lifecycle management
  async shutdown(): Promise<void> {
    if (this.sdk) {
      try {
        await this.sdk.shutdown();
        this.logger.info('OpenTelemetry SDK shutdown completed');
      } catch (error) {
        this.logger.error('Error shutting down OpenTelemetry SDK', error);
        throw error;
      }
    }
  }

  destroy(): void {
    this.shutdown().catch(error => {
      this.logger.error('Error during OpenTelemetry tracer destruction', error);
    });
  }
}
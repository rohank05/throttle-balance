import { register, Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Request, Response } from 'express';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface PrometheusMetrics {
  // Rate Limiter Metrics
  rateLimiterRequests: Counter<string>;
  rateLimiterBlocked: Counter<string>;
  rateLimiterActiveKeys: Gauge<string>;
  rateLimiterResponseTime: Histogram<string>;

  // Load Balancer Metrics
  loadBalancerRequests: Counter<string>;
  loadBalancerErrors: Counter<string>;
  loadBalancerResponseTime: Histogram<string>;
  loadBalancerServerHealth: Gauge<string>;
  loadBalancerActiveConnections: Gauge<string>;

  // Security Metrics
  securityBlockedIPs: Counter<string>;
  securityValidationFailures: Counter<string>;
  securitySanitizedRequests: Counter<string>;

  // Circuit Breaker Metrics
  circuitBreakerState: Gauge<string>;
  circuitBreakerFailures: Counter<string>;
  circuitBreakerSuccesses: Counter<string>;

  // Health Check Metrics
  healthCheckDuration: Histogram<string>;
  healthCheckStatus: Gauge<string>;

  // System Metrics
  httpRequestsTotal: Counter<string>;
  httpRequestDuration: Histogram<string>;
  httpRequestSize: Histogram<string>;
  httpResponseSize: Histogram<string>;
}

export interface PrometheusExporterConfig {
  prefix?: string;
  collectDefaultMetrics?: boolean;
  defaultMetricsTimeout?: number;
  registry?: Registry;
}

export class PrometheusExporter {
  private readonly registry: Registry;
  private readonly metrics: PrometheusMetrics;
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(config: PrometheusExporterConfig = {}, logger?: Logger) {
    this.logger = logger || createDefaultLogger();
    this.prefix = config.prefix || 'flow_control_';
    this.registry = config.registry || register;

    // Collect default Node.js metrics
    if (config.collectDefaultMetrics !== false) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: this.prefix,
      });
    }

    this.metrics = this.createMetrics();
    this.logger.info('Prometheus exporter initialized', {
      prefix: this.prefix,
      defaultMetrics: config.collectDefaultMetrics !== false,
    });
  }

  private createMetrics(): PrometheusMetrics {
    return {
      // Rate Limiter Metrics
      rateLimiterRequests: new Counter({
        name: `${this.prefix}rate_limiter_requests_total`,
        help: 'Total number of requests processed by rate limiter',
        labelNames: ['result', 'key_type'] as const,
        registers: [this.registry],
      }),

      rateLimiterBlocked: new Counter({
        name: `${this.prefix}rate_limiter_blocked_total`,
        help: 'Total number of requests blocked by rate limiter',
        labelNames: ['reason', 'key_type'] as const,
        registers: [this.registry],
      }),

      rateLimiterActiveKeys: new Gauge({
        name: `${this.prefix}rate_limiter_active_keys`,
        help: 'Current number of active rate limiting keys',
        labelNames: ['store_type'] as const,
        registers: [this.registry],
      }),

      rateLimiterResponseTime: new Histogram({
        name: `${this.prefix}rate_limiter_response_time_seconds`,
        help: 'Rate limiter operation response time in seconds',
        labelNames: ['operation'] as const,
        buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
        registers: [this.registry],
      }),

      // Load Balancer Metrics
      loadBalancerRequests: new Counter({
        name: `${this.prefix}load_balancer_requests_total`,
        help: 'Total number of requests processed by load balancer',
        labelNames: ['server', 'method', 'status_code'] as const,
        registers: [this.registry],
      }),

      loadBalancerErrors: new Counter({
        name: `${this.prefix}load_balancer_errors_total`,
        help: 'Total number of load balancer errors',
        labelNames: ['server', 'error_type'] as const,
        registers: [this.registry],
      }),

      loadBalancerResponseTime: new Histogram({
        name: `${this.prefix}load_balancer_response_time_seconds`,
        help: 'Load balancer response time in seconds',
        labelNames: ['server', 'method'] as const,
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [this.registry],
      }),

      loadBalancerServerHealth: new Gauge({
        name: `${this.prefix}load_balancer_server_health`,
        help: 'Health status of backend servers (1 = healthy, 0 = unhealthy)',
        labelNames: ['server', 'host', 'port'] as const,
        registers: [this.registry],
      }),

      loadBalancerActiveConnections: new Gauge({
        name: `${this.prefix}load_balancer_active_connections`,
        help: 'Current number of active connections to backend servers',
        labelNames: ['server'] as const,
        registers: [this.registry],
      }),

      // Security Metrics
      securityBlockedIPs: new Counter({
        name: `${this.prefix}security_blocked_ips_total`,
        help: 'Total number of blocked IP addresses',
        labelNames: ['reason', 'ip_version'] as const,
        registers: [this.registry],
      }),

      securityValidationFailures: new Counter({
        name: `${this.prefix}security_validation_failures_total`,
        help: 'Total number of request validation failures',
        labelNames: ['validation_type', 'reason'] as const,
        registers: [this.registry],
      }),

      securitySanitizedRequests: new Counter({
        name: `${this.prefix}security_sanitized_requests_total`,
        help: 'Total number of sanitized requests',
        labelNames: ['sanitization_type'] as const,
        registers: [this.registry],
      }),

      // Circuit Breaker Metrics
      circuitBreakerState: new Gauge({
        name: `${this.prefix}circuit_breaker_state`,
        help: 'Circuit breaker state (0 = closed, 1 = open, 2 = half-open)',
        labelNames: ['service', 'breaker_name'] as const,
        registers: [this.registry],
      }),

      circuitBreakerFailures: new Counter({
        name: `${this.prefix}circuit_breaker_failures_total`,
        help: 'Total number of circuit breaker failures',
        labelNames: ['service', 'breaker_name'] as const,
        registers: [this.registry],
      }),

      circuitBreakerSuccesses: new Counter({
        name: `${this.prefix}circuit_breaker_successes_total`,
        help: 'Total number of circuit breaker successes',
        labelNames: ['service', 'breaker_name'] as const,
        registers: [this.registry],
      }),

      // Health Check Metrics
      healthCheckDuration: new Histogram({
        name: `${this.prefix}health_check_duration_seconds`,
        help: 'Health check duration in seconds',
        labelNames: ['server', 'check_type', 'result'] as const,
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
        registers: [this.registry],
      }),

      healthCheckStatus: new Gauge({
        name: `${this.prefix}health_check_status`,
        help: 'Health check status (1 = healthy, 0 = unhealthy)',
        labelNames: ['server', 'check_type'] as const,
        registers: [this.registry],
      }),

      // System Metrics
      httpRequestsTotal: new Counter({
        name: `${this.prefix}http_requests_total`,
        help: 'Total number of HTTP requests',
        labelNames: ['method', 'status_code', 'route'] as const,
        registers: [this.registry],
      }),

      httpRequestDuration: new Histogram({
        name: `${this.prefix}http_request_duration_seconds`,
        help: 'HTTP request duration in seconds',
        labelNames: ['method', 'status_code', 'route'] as const,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [this.registry],
      }),

      httpRequestSize: new Histogram({
        name: `${this.prefix}http_request_size_bytes`,
        help: 'HTTP request size in bytes',
        labelNames: ['method', 'route'] as const,
        buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
        registers: [this.registry],
      }),

      httpResponseSize: new Histogram({
        name: `${this.prefix}http_response_size_bytes`,
        help: 'HTTP response size in bytes',
        labelNames: ['method', 'status_code', 'route'] as const,
        buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
        registers: [this.registry],
      }),
    };
  }

  getMetrics(): PrometheusMetrics {
    return this.metrics;
  }

  getRegistry(): Registry {
    return this.registry;
  }

  async getMetricsString(): Promise<string> {
    return this.registry.metrics();
  }

  createMetricsEndpoint() {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        const metrics = await this.getMetricsString();
        res.set('Content-Type', this.registry.contentType);
        res.send(metrics);
      } catch (error) {
        this.logger.error('Failed to export metrics', error);
        res.status(500).send('Internal Server Error');
      }
    };
  }

  // Convenience methods for recording common metrics
  recordRateLimiterRequest(result: 'allowed' | 'blocked', keyType: string = 'ip'): void {
    this.metrics.rateLimiterRequests.inc({ result, key_type: keyType });
  }

  recordRateLimiterBlocked(reason: string, keyType: string = 'ip'): void {
    this.metrics.rateLimiterBlocked.inc({ reason, key_type: keyType });
  }

  recordLoadBalancerRequest(
    server: string,
    method: string,
    statusCode: string,
    responseTime: number
  ): void {
    this.metrics.loadBalancerRequests.inc({ server, method, status_code: statusCode });
    this.metrics.loadBalancerResponseTime.observe({ server, method }, responseTime / 1000);
  }

  recordLoadBalancerError(server: string, errorType: string): void {
    this.metrics.loadBalancerErrors.inc({ server, error_type: errorType });
  }

  recordSecurityBlocked(reason: string, ipVersion: 'ipv4' | 'ipv6'): void {
    this.metrics.securityBlockedIPs.inc({ reason, ip_version: ipVersion });
  }

  recordCircuitBreakerState(
    service: string,
    breakerName: string,
    state: 'closed' | 'open' | 'half-open'
  ): void {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.metrics.circuitBreakerState.set({ service, breaker_name: breakerName }, stateValue);
  }

  recordHealthCheck(
    server: string,
    checkType: string,
    result: 'success' | 'failure',
    duration: number
  ): void {
    this.metrics.healthCheckDuration.observe({ server, check_type: checkType, result }, duration / 1000);
    this.metrics.healthCheckStatus.set(
      { server, check_type: checkType },
      result === 'success' ? 1 : 0
    );
  }

  recordHttpRequest(
    method: string,
    statusCode: string,
    route: string,
    duration: number,
    requestSize?: number,
    responseSize?: number
  ): void {
    this.metrics.httpRequestsTotal.inc({ method, status_code: statusCode, route });
    this.metrics.httpRequestDuration.observe({ method, status_code: statusCode, route }, duration / 1000);

    if (requestSize !== undefined) {
      this.metrics.httpRequestSize.observe({ method, route }, requestSize);
    }

    if (responseSize !== undefined) {
      this.metrics.httpResponseSize.observe({ method, status_code: statusCode, route }, responseSize);
    }
  }

  reset(): void {
    this.registry.clear();
    this.logger.info('Prometheus metrics registry cleared');
  }

  destroy(): void {
    this.reset();
    this.logger.info('Prometheus exporter destroyed');
  }
}
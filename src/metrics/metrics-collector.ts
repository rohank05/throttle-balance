import { EventEmitter } from 'events';
import type { PrometheusExporter } from './prometheus-exporter.js';
import type {
  Logger,
  RateLimitResult,
  ServerConfig,
  LoadBalancerStats,
  ServerStats,
} from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface MetricsCollectorConfig {
  enabled?: boolean;
  collectInterval?: number;
  bufferSize?: number;
  flushInterval?: number;
}

export interface MetricEvent {
  type: string;
  timestamp: number;
  data: Record<string, any>;
  labels?: Record<string, string>;
}

export interface PerformanceSnapshot {
  timestamp: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  uptime: number;
  activeHandles: number;
  eventLoopDelay: number;
}

export class MetricsCollector extends EventEmitter {
  private readonly config: Required<MetricsCollectorConfig>;
  private readonly logger: Logger;
  private prometheusExporter?: PrometheusExporter;
  private metricsBuffer: MetricEvent[] = [];
  private collectTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private performanceHistory: PerformanceSnapshot[] = [];

  constructor(config: MetricsCollectorConfig = {}, logger?: Logger) {
    super();

    this.config = {
      enabled: config.enabled ?? true,
      collectInterval: config.collectInterval ?? 30000, // 30 seconds
      bufferSize: config.bufferSize ?? 1000,
      flushInterval: config.flushInterval ?? 60000, // 1 minute
    };

    this.logger = logger || createDefaultLogger();
    this.lastCpuUsage = process.cpuUsage();

    if (this.config.enabled) {
      this.startCollection();
    }

    this.logger.info('Metrics collector initialized', {
      enabled: this.config.enabled,
      collectInterval: this.config.collectInterval,
      bufferSize: this.config.bufferSize,
    });
  }

  setPrometheusExporter(exporter: PrometheusExporter): void {
    this.prometheusExporter = exporter;
    this.logger.info('Prometheus exporter attached to metrics collector');
  }

  private startCollection(): void {
    // Start periodic system metrics collection
    this.collectTimer = setInterval(() => {
      this.collectSystemMetrics();
    }, this.config.collectInterval);

    // Start periodic buffer flush
    this.flushTimer = setInterval(() => {
      this.flushMetricsBuffer();
    }, this.config.flushInterval);

    this.logger.info('Metrics collection started');
  }

  private collectSystemMetrics(): void {
    try {
      const snapshot: PerformanceSnapshot = {
        timestamp: Date.now(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(this.lastCpuUsage),
        uptime: process.uptime(),
        activeHandles: (process as any)._getActiveHandles()?.length || 0,
        eventLoopDelay: this.measureEventLoopDelay(),
      };

      this.lastCpuUsage = process.cpuUsage();
      this.performanceHistory.push(snapshot);

      // Keep only last 100 snapshots
      if (this.performanceHistory.length > 100) {
        this.performanceHistory.shift();
      }

      this.recordMetric('system.performance', snapshot);
      this.emit('performanceSnapshot', snapshot);

    } catch (error) {
      this.logger.error('Failed to collect system metrics', error);
    }
  }

  private measureEventLoopDelay(): number {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const delay = Number(process.hrtime.bigint() - start) / 1000000; // Convert to milliseconds
      this.recordMetric('system.eventLoopDelay', { delay });
    });
    return 0; // Will be updated asynchronously
  }

  private recordMetric(type: string, data: Record<string, any>, labels?: Record<string, string>): void {
    const event: MetricEvent = {
      type,
      timestamp: Date.now(),
      data,
      labels,
    };

    this.metricsBuffer.push(event);

    // Prevent buffer overflow
    if (this.metricsBuffer.length > this.config.bufferSize) {
      this.metricsBuffer.shift();
    }

    this.emit('metric', event);
  }

  private flushMetricsBuffer(): void {
    if (this.metricsBuffer.length === 0) {
      return;
    }

    const metrics = [...this.metricsBuffer];
    this.metricsBuffer = [];

    this.emit('metricsFlush', metrics);

    this.logger.debug('Flushed metrics buffer', {
      metricCount: metrics.length,
      types: [...new Set(metrics.map(m => m.type))],
    });
  }

  // Rate Limiter Metrics
  recordRateLimiterRequest(result: RateLimitResult, keyType: string = 'ip'): void {
    const allowed = result.allowed ? 'allowed' : 'blocked';

    this.recordMetric('rateLimiter.request', {
      allowed: result.allowed,
      remaining: result.info.remaining,
      limit: result.info.limit,
      resetTime: result.info.resetTime,
      windowMs: result.info.windowMs,
    }, { result: allowed, keyType });

    // Update Prometheus metrics
    if (this.prometheusExporter) {
      this.prometheusExporter.recordRateLimiterRequest(allowed, keyType);
      if (!result.allowed) {
        this.prometheusExporter.recordRateLimiterBlocked('rate_limit_exceeded', keyType);
      }
    }
  }

  recordRateLimiterStats(activeKeys: number, storeType: string): void {
    this.recordMetric('rateLimiter.stats', { activeKeys, storeType });

    if (this.prometheusExporter) {
      this.prometheusExporter.getMetrics().rateLimiterActiveKeys.set({ store_type: storeType }, activeKeys);
    }
  }

  // Load Balancer Metrics
  recordLoadBalancerRequest(
    server: ServerConfig,
    method: string,
    statusCode: number,
    responseTime: number,
    success: boolean
  ): void {
    const serverKey = `${server.host}:${server.port}`;

    this.recordMetric('loadBalancer.request', {
      server: serverKey,
      method,
      statusCode,
      responseTime,
      success,
      protocol: server.protocol || 'http',
    }, { server: serverKey, method, status: statusCode.toString() });

    if (this.prometheusExporter) {
      this.prometheusExporter.recordLoadBalancerRequest(
        serverKey,
        method,
        statusCode.toString(),
        responseTime
      );

      if (!success) {
        this.prometheusExporter.recordLoadBalancerError(serverKey, 'request_failed');
      }
    }
  }

  recordLoadBalancerStats(stats: LoadBalancerStats): void {
    this.recordMetric('loadBalancer.stats', {
      totalRequests: stats.totalRequests,
      totalErrors: stats.totalErrors,
      serverCount: stats.serverStats.size,
    });

    // Record individual server stats
    for (const [serverKey, serverStats] of stats.serverStats) {
      this.recordMetric('loadBalancer.serverStats', {
        server: serverKey,
        requests: serverStats.requests,
        errors: serverStats.errors,
        averageResponseTime: serverStats.averageResponseTime,
        lastUsed: serverStats.lastUsed.toISOString(),
      }, { server: serverKey });
    }
  }

  recordServerHealth(server: ServerConfig, healthy: boolean, responseTime?: number): void {
    const serverKey = `${server.host}:${server.port}`;

    this.recordMetric('loadBalancer.serverHealth', {
      server: serverKey,
      healthy,
      responseTime,
    }, { server: serverKey });

    if (this.prometheusExporter) {
      this.prometheusExporter.getMetrics().loadBalancerServerHealth.set(
        { server: serverKey, host: server.host, port: server.port.toString() },
        healthy ? 1 : 0
      );
    }
  }

  // Security Metrics
  recordSecurityEvent(
    eventType: 'ip_blocked' | 'validation_failed' | 'sanitized',
    details: Record<string, any>
  ): void {
    this.recordMetric('security.event', {
      eventType,
      ...details,
    }, { event_type: eventType });

    if (this.prometheusExporter) {
      switch (eventType) {
        case 'ip_blocked':
          this.prometheusExporter.recordSecurityBlocked(
            details.reason || 'unknown',
            details.ipVersion || 'ipv4'
          );
          break;
        case 'validation_failed':
          this.prometheusExporter.getMetrics().securityValidationFailures.inc({
            validation_type: details.validationType || 'unknown',
            reason: details.reason || 'unknown',
          });
          break;
        case 'sanitized':
          this.prometheusExporter.getMetrics().securitySanitizedRequests.inc({
            sanitization_type: details.sanitizationType || 'unknown',
          });
          break;
      }
    }
  }

  // Circuit Breaker Metrics
  recordCircuitBreakerEvent(
    service: string,
    breakerName: string,
    event: 'success' | 'failure' | 'state_change',
    details: Record<string, any>
  ): void {
    this.recordMetric('circuitBreaker.event', {
      service,
      breakerName,
      event,
      ...details,
    }, { service, breaker_name: breakerName, event });

    if (this.prometheusExporter && event === 'state_change') {
      this.prometheusExporter.recordCircuitBreakerState(
        service,
        breakerName,
        details.newState
      );
    }

    if (this.prometheusExporter && (event === 'success' || event === 'failure')) {
      const metric = event === 'success'
        ? this.prometheusExporter.getMetrics().circuitBreakerSuccesses
        : this.prometheusExporter.getMetrics().circuitBreakerFailures;

      metric.inc({ service, breaker_name: breakerName });
    }
  }

  // Health Check Metrics
  recordHealthCheck(
    server: string,
    checkType: string,
    success: boolean,
    duration: number,
    error?: string
  ): void {
    this.recordMetric('healthCheck.result', {
      server,
      checkType,
      success,
      duration,
      error,
    }, { server, check_type: checkType, result: success ? 'success' : 'failure' });

    if (this.prometheusExporter) {
      this.prometheusExporter.recordHealthCheck(
        server,
        checkType,
        success ? 'success' : 'failure',
        duration
      );
    }
  }

  // HTTP Request Metrics
  recordHttpRequest(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    requestSize?: number,
    responseSize?: number
  ): void {
    // Normalize path to avoid high cardinality
    const route = this.normalizePath(path);

    this.recordMetric('http.request', {
      method,
      path: route,
      statusCode,
      duration,
      requestSize,
      responseSize,
    }, { method, route, status: statusCode.toString() });

    if (this.prometheusExporter) {
      this.prometheusExporter.recordHttpRequest(
        method,
        statusCode.toString(),
        route,
        duration,
        requestSize,
        responseSize
      );
    }
  }

  private normalizePath(path: string): string {
    // Replace IDs and UUIDs with placeholders to reduce cardinality
    return path
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
      .replace(/\/[0-9a-f]{24}/gi, '/:objectid');
  }

  // Performance Analytics
  getPerformanceSnapshot(): PerformanceSnapshot | undefined {
    return this.performanceHistory[this.performanceHistory.length - 1];
  }

  getPerformanceHistory(limit?: number): PerformanceSnapshot[] {
    const history = this.performanceHistory;
    return limit ? history.slice(-limit) : history;
  }

  getPerformanceTrends(): {
    memoryTrend: 'increasing' | 'decreasing' | 'stable';
    cpuTrend: 'increasing' | 'decreasing' | 'stable';
    responseTimeTrend: 'increasing' | 'decreasing' | 'stable';
  } {
    if (this.performanceHistory.length < 5) {
      return { memoryTrend: 'stable', cpuTrend: 'stable', responseTimeTrend: 'stable' };
    }

    const recent = this.performanceHistory.slice(-5);
    const memoryValues = recent.map(s => s.memoryUsage.heapUsed);
    const cpuValues = recent.map(s => s.cpuUsage.user + s.cpuUsage.system);

    return {
      memoryTrend: this.calculateTrend(memoryValues),
      cpuTrend: this.calculateTrend(cpuValues),
      responseTimeTrend: 'stable', // Will be calculated from request metrics
    };
  }

  private calculateTrend(values: number[]): 'increasing' | 'decreasing' | 'stable' {
    if (values.length < 2) return 'stable';

    const first = values[0];
    const last = values[values.length - 1];
    const change = (last - first) / first;

    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }

  // Buffer and Export Management
  getMetricsBuffer(): MetricEvent[] {
    return [...this.metricsBuffer];
  }

  clearMetricsBuffer(): void {
    this.metricsBuffer = [];
    this.logger.debug('Metrics buffer cleared');
  }

  forceFlush(): void {
    this.flushMetricsBuffer();
  }

  // Lifecycle Management
  start(): void {
    if (!this.config.enabled) {
      this.config.enabled = true;
      this.startCollection();
      this.logger.info('Metrics collection started');
    }
  }

  stop(): void {
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = undefined;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.config.enabled = false;
    this.logger.info('Metrics collection stopped');
  }

  destroy(): void {
    this.stop();
    this.clearMetricsBuffer();
    this.performanceHistory = [];
    this.removeAllListeners();
    this.logger.info('Metrics collector destroyed');
  }
}
import { FlowControl } from '../../src/core/flow-control.js';
import { Registry } from 'prom-client';

describe('Phase 3 Basic Observability', () => {
  let flowControl: FlowControl;

  afterEach(async () => {
    if (flowControl) {
      await flowControl.destroy();
    }
  });

  // Helper function to create isolated registry for each test
  function createTestConfig(observability: any) {
    const config: any = {
      rateLimiter: {
        windowMs: 60000,
        maxRequests: 100,
      },
      observability: { ...observability },
    };

    // Always ensure isolated prometheus registry to avoid conflicts
    // Default behavior is to enable metrics, so we need to handle this
    if (!config.observability.metrics) {
      config.observability.metrics = {};
    }

    config.observability.metrics.prometheus = {
      ...config.observability.metrics.prometheus,
      registry: new Registry(), // Isolated registry for each test
      collectDefaultMetrics: false, // Disable default metrics to avoid conflicts
    };

    return config;
  }

  it('should create FlowControl with observability disabled', async () => {
    flowControl = await FlowControl.create({
      rateLimiter: {
        windowMs: 60000,
        maxRequests: 100,
      },
    });

    expect(flowControl).toBeDefined();
    expect(flowControl.getRateLimiter()).toBeDefined();
    expect(flowControl.getPrometheusExporter()).toBeUndefined();
    expect(flowControl.getMetricsCollector()).toBeUndefined();
    expect(flowControl.getOpenTelemetryTracer()).toBeUndefined();
  });

  it('should create FlowControl with basic metrics enabled', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      metrics: {
        enabled: true,
        prometheus: {
          enabled: true,
        },
        collector: {
          enabled: true,
        },
      },
    }));

    expect(flowControl).toBeDefined();
    expect(flowControl.getPrometheusExporter()).toBeDefined();
    expect(flowControl.getMetricsCollector()).toBeDefined();

    const stats = flowControl.getStats();
    expect(stats.observability).toBeDefined();
    expect(stats.observability.metrics).toBe(true);
  });

  it('should create FlowControl with performance monitoring', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      performance: {
        enabled: true,
        monitoring: true,
      },
    }));

    expect(flowControl).toBeDefined();
    expect(flowControl.getPerformanceMonitor()).toBeDefined();

    const perfMonitor = flowControl.getPerformanceMonitor();
    expect(perfMonitor).toBeDefined();

    // Wait a moment for initial metrics collection
    await new Promise(resolve => setTimeout(resolve, 100));

    const summary = perfMonitor?.getPerformanceSummary();
    expect(summary).toBeDefined();
    expect(summary?.trends).toBeDefined();
  });

  it('should create FlowControl with health aggregation', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      healthCheck: {
        enabled: true,
        aggregation: true,
      },
    }));

    expect(flowControl).toBeDefined();
    expect(flowControl.getHealthAggregator()).toBeDefined();

    const healthAggregator = flowControl.getHealthAggregator();
    expect(healthAggregator).toBeDefined();

    const health = healthAggregator?.getAggregatedHealth();
    expect(health).toBeDefined();
    expect(health?.status).toBe('healthy'); // Should be healthy with no dependencies
  });

  it('should create FlowControl with graceful shutdown', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      gracefulShutdown: {
        enabled: true,
        gracefulTimeoutMs: 5000,
      },
    }));

    expect(flowControl).toBeDefined();
    expect(flowControl.getShutdownManager()).toBeDefined();

    const shutdownManager = flowControl.getShutdownManager();
    expect(shutdownManager).toBeDefined();
    expect(shutdownManager?.getStatus().phase).toBe('idle');
  });

  it('should export Prometheus metrics endpoint', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      metrics: {
        prometheus: {
          enabled: true,
        },
      },
    }));

    const prometheusExporter = flowControl.getPrometheusExporter();
    expect(prometheusExporter).toBeDefined();

    const metricsString = await prometheusExporter?.getMetricsString();
    expect(metricsString).toBeDefined();
    expect(typeof metricsString).toBe('string');

    // Should contain some basic Node.js metrics
    expect(metricsString).toContain('flow_control_');
  });

  it('should handle comprehensive observability configuration', async () => {
    flowControl = await FlowControl.create(createTestConfig({
      metrics: {
        enabled: true,
        prometheus: { enabled: true },
        collector: { enabled: true },
      },
      performance: {
        enabled: true,
        monitoring: true,
      },
      healthCheck: {
        enabled: true,
        aggregation: true,
      },
      gracefulShutdown: {
        enabled: true,
      },
    }));

    expect(flowControl).toBeDefined();
    expect(flowControl.getPrometheusExporter()).toBeDefined();
    expect(flowControl.getMetricsCollector()).toBeDefined();
    expect(flowControl.getPerformanceMonitor()).toBeDefined();
    expect(flowControl.getHealthAggregator()).toBeDefined();
    expect(flowControl.getShutdownManager()).toBeDefined();

    const stats = flowControl.getStats();
    expect(stats.observability.metrics).toBe(true);
    expect(stats.observability.performanceMonitoring).toBe(true);
    expect(stats.observability.healthAggregation).toBe(true);
  });
});
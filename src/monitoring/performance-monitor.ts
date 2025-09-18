import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface PerformanceMonitorConfig {
  enabled?: boolean;
  collectInterval?: number;
  memoryThresholds?: {
    warning?: number; // MB
    critical?: number; // MB
  };
  cpuThresholds?: {
    warning?: number; // Percentage
    critical?: number; // Percentage
  };
  latencyThresholds?: {
    warning?: number; // ms
    critical?: number; // ms
  };
  gcMonitoring?: boolean;
  eventLoopMonitoring?: boolean;
  maxHistorySize?: number;
}

export interface PerformanceMetrics {
  timestamp: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    buffers: number;
    arrayBuffers: number;
  };
  cpu: {
    user: number;
    system: number;
    total: number;
    percentage: number;
  };
  eventLoop: {
    delay: number;
    utilization: number;
  };
  gc?: {
    count: number;
    duration: number;
    type: string;
  }[];
  system: {
    uptime: number;
    loadAverage: number[];
    freeMemory: number;
    totalMemory: number;
  };
}

export interface PerformanceAlert {
  type: 'memory' | 'cpu' | 'latency' | 'gc' | 'event_loop';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  recommendations: string[];
}

export interface PerformanceBaseline {
  memory: {
    averageHeapUsed: number;
    maxHeapUsed: number;
    p95HeapUsed: number;
  };
  cpu: {
    averageUsage: number;
    maxUsage: number;
    p95Usage: number;
  };
  eventLoop: {
    averageDelay: number;
    maxDelay: number;
    p95Delay: number;
  };
  gc: {
    averageCount: number;
    averageDuration: number;
  };
  calculatedAt: number;
  sampleCount: number;
}

export class PerformanceMonitor extends EventEmitter {
  private readonly config: Required<PerformanceMonitorConfig>;
  private readonly logger: Logger;
  private readonly metricsHistory: PerformanceMetrics[] = [];
  private readonly alerts: PerformanceAlert[] = [];
  private baseline?: PerformanceBaseline;
  private collectTimer?: NodeJS.Timeout;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private gcObserver?: PerformanceObserver;
  private gcData: { count: number; duration: number; type: string }[] = [];
  private eventLoopDelay: number = 0;
  private eventLoopUtilization: number = 0;

  constructor(config: PerformanceMonitorConfig = {}, logger?: Logger) {
    super();

    this.config = {
      enabled: config.enabled ?? true,
      collectInterval: config.collectInterval ?? 10000, // 10 seconds
      memoryThresholds: {
        warning: config.memoryThresholds?.warning ?? 500, // 500MB
        critical: config.memoryThresholds?.critical ?? 1000, // 1GB
      },
      cpuThresholds: {
        warning: config.cpuThresholds?.warning ?? 70, // 70%
        critical: config.cpuThresholds?.critical ?? 90, // 90%
      },
      latencyThresholds: {
        warning: config.latencyThresholds?.warning ?? 100, // 100ms
        critical: config.latencyThresholds?.critical ?? 500, // 500ms
      },
      gcMonitoring: config.gcMonitoring ?? true,
      eventLoopMonitoring: config.eventLoopMonitoring ?? true,
      maxHistorySize: config.maxHistorySize ?? 144, // 24 hours at 10s intervals
    };

    this.logger = logger || createDefaultLogger();
    this.lastCpuUsage = process.cpuUsage();

    if (this.config.enabled) {
      this.startMonitoring();
    }

    this.logger.info('Performance monitor initialized', {
      enabled: this.config.enabled,
      collectInterval: this.config.collectInterval,
      memoryWarning: this.config.memoryThresholds.warning,
      cpuWarning: this.config.cpuThresholds.warning,
    });
  }

  private startMonitoring(): void {
    if (this.config.gcMonitoring) {
      this.setupGCMonitoring();
    }

    if (this.config.eventLoopMonitoring) {
      this.setupEventLoopMonitoring();
    }

    this.collectTimer = setInterval(() => {
      this.collectMetrics();
    }, this.config.collectInterval);

    // Collect initial metrics
    this.collectMetrics();

    this.logger.info('Performance monitoring started');
  }

  private setupGCMonitoring(): void {
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.entryType === 'gc') {
            this.gcData.push({
              count: 1,
              duration: entry.duration,
              type: (entry as any).kind || 'unknown',
            });

            // Keep only recent GC data (last minute)
            const oneMinuteAgo = Date.now() - 60000;
            this.gcData = this.gcData.filter(gc =>
              entry.startTime > oneMinuteAgo
            );
          }
        }
      });

      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch (error) {
      this.logger.warn('GC monitoring not available', error);
    }
  }

  private setupEventLoopMonitoring(): void {
    // Measure event loop delay
    const measureEventLoopDelay = () => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const delay = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
        this.eventLoopDelay = delay;
      });
    };

    // Measure event loop utilization
    const measureEventLoopUtilization = () => {
      try {
        const elu = (performance as any).eventLoopUtilization?.();
        if (elu) {
          this.eventLoopUtilization = elu.utilization;
        }
      } catch (error) {
        // Event loop utilization not available in older Node.js versions
      }
    };

    // Measure every second
    setInterval(() => {
      measureEventLoopDelay();
      measureEventLoopUtilization();
    }, 1000);
  }

  private collectMetrics(): void {
    try {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      const osInfo = this.getSystemInfo();

      // Calculate CPU percentage
      const totalCpuTime = cpuUsage.user + cpuUsage.system;
      const cpuPercentage = (totalCpuTime / (this.config.collectInterval * 1000)) * 100;

      const metrics: PerformanceMetrics = {
        timestamp: Date.now(),
        memory: {
          rss: memoryUsage.rss,
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          buffers: (memoryUsage as any).buffers || 0,
          arrayBuffers: memoryUsage.arrayBuffers,
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system,
          total: totalCpuTime,
          percentage: cpuPercentage,
        },
        eventLoop: {
          delay: this.eventLoopDelay,
          utilization: this.eventLoopUtilization,
        },
        gc: this.gcData.length > 0 ? [...this.gcData] : undefined,
        system: osInfo,
      };

      this.lastCpuUsage = process.cpuUsage();
      this.gcData = []; // Reset GC data after collection

      this.addMetrics(metrics);
      this.checkThresholds(metrics);

      this.emit('metrics', metrics);

    } catch (error) {
      this.logger.error('Error collecting performance metrics', error);
    }
  }

  private getSystemInfo() {
    const os = require('os');
    return {
      uptime: process.uptime(),
      loadAverage: os.loadavg(),
      freeMemory: os.freemem(),
      totalMemory: os.totalmem(),
    };
  }

  private addMetrics(metrics: PerformanceMetrics): void {
    this.metricsHistory.push(metrics);

    // Maintain history size limit
    if (this.metricsHistory.length > this.config.maxHistorySize) {
      this.metricsHistory.shift();
    }

    // Update baseline every hour (360 samples at 10s intervals)
    if (this.metricsHistory.length % 360 === 0) {
      this.updateBaseline();
    }
  }

  private checkThresholds(metrics: PerformanceMetrics): void {
    const alerts: PerformanceAlert[] = [];

    // Memory threshold checks
    const heapUsedMB = metrics.memory.heapUsed / 1024 / 1024;
    if (heapUsedMB > this.config.memoryThresholds.critical) {
      alerts.push({
        type: 'memory',
        severity: 'critical',
        message: `Heap memory usage is critically high: ${heapUsedMB.toFixed(2)}MB`,
        value: heapUsedMB,
        threshold: this.config.memoryThresholds.critical,
        timestamp: metrics.timestamp,
        recommendations: [
          'Investigate memory leaks',
          'Consider increasing heap size',
          'Optimize memory-intensive operations',
          'Enable heap snapshots for analysis',
        ],
      });
    } else if (heapUsedMB > this.config.memoryThresholds.warning) {
      alerts.push({
        type: 'memory',
        severity: 'warning',
        message: `Heap memory usage is high: ${heapUsedMB.toFixed(2)}MB`,
        value: heapUsedMB,
        threshold: this.config.memoryThresholds.warning,
        timestamp: metrics.timestamp,
        recommendations: [
          'Monitor memory usage trends',
          'Review recent code changes',
          'Consider memory optimization',
        ],
      });
    }

    // CPU threshold checks
    if (metrics.cpu.percentage > this.config.cpuThresholds.critical) {
      alerts.push({
        type: 'cpu',
        severity: 'critical',
        message: `CPU usage is critically high: ${metrics.cpu.percentage.toFixed(2)}%`,
        value: metrics.cpu.percentage,
        threshold: this.config.cpuThresholds.critical,
        timestamp: metrics.timestamp,
        recommendations: [
          'Identify CPU-intensive operations',
          'Consider horizontal scaling',
          'Optimize hot code paths',
          'Enable profiling for analysis',
        ],
      });
    } else if (metrics.cpu.percentage > this.config.cpuThresholds.warning) {
      alerts.push({
        type: 'cpu',
        severity: 'warning',
        message: `CPU usage is high: ${metrics.cpu.percentage.toFixed(2)}%`,
        value: metrics.cpu.percentage,
        threshold: this.config.cpuThresholds.warning,
        timestamp: metrics.timestamp,
        recommendations: [
          'Monitor CPU usage patterns',
          'Review performance-sensitive code',
          'Consider load balancing',
        ],
      });
    }

    // Event loop delay checks
    if (metrics.eventLoop.delay > this.config.latencyThresholds.critical) {
      alerts.push({
        type: 'event_loop',
        severity: 'critical',
        message: `Event loop delay is critically high: ${metrics.eventLoop.delay.toFixed(2)}ms`,
        value: metrics.eventLoop.delay,
        threshold: this.config.latencyThresholds.critical,
        timestamp: metrics.timestamp,
        recommendations: [
          'Identify blocking operations',
          'Use worker threads for CPU-intensive tasks',
          'Optimize database queries',
          'Review synchronous code paths',
        ],
      });
    } else if (metrics.eventLoop.delay > this.config.latencyThresholds.warning) {
      alerts.push({
        type: 'event_loop',
        severity: 'warning',
        message: `Event loop delay is high: ${metrics.eventLoop.delay.toFixed(2)}ms`,
        value: metrics.eventLoop.delay,
        threshold: this.config.latencyThresholds.warning,
        timestamp: metrics.timestamp,
        recommendations: [
          'Monitor event loop performance',
          'Review async operation patterns',
          'Consider breaking up large operations',
        ],
      });
    }

    // GC frequency checks
    if (metrics.gc && metrics.gc.length > 10) {
      alerts.push({
        type: 'gc',
        severity: 'warning',
        message: `High garbage collection frequency: ${metrics.gc.length} collections in last minute`,
        value: metrics.gc.length,
        threshold: 10,
        timestamp: metrics.timestamp,
        recommendations: [
          'Reduce object allocation rate',
          'Reuse objects where possible',
          'Optimize memory allocation patterns',
          'Consider object pooling',
        ],
      });
    }

    // Process alerts
    for (const alert of alerts) {
      this.addAlert(alert);
      this.emit('alert', alert);

      if (alert.severity === 'critical') {
        this.logger.error(alert.message, {
          type: alert.type,
          value: alert.value,
          threshold: alert.threshold,
        });
      } else {
        this.logger.warn(alert.message, {
          type: alert.type,
          value: alert.value,
          threshold: alert.threshold,
        });
      }
    }
  }

  private addAlert(alert: PerformanceAlert): void {
    this.alerts.push(alert);

    // Keep only recent alerts (last hour)
    const oneHourAgo = Date.now() - 3600000;
    while (this.alerts.length > 0 && this.alerts[0]!.timestamp < oneHourAgo) {
      this.alerts.shift();
    }
  }

  private updateBaseline(): void {
    if (this.metricsHistory.length < 10) {
      return; // Need at least 10 samples
    }

    const recent = this.metricsHistory.slice(-360); // Last hour

    // Memory statistics
    const heapUsedValues = recent.map(m => m.memory.heapUsed);
    heapUsedValues.sort((a, b) => a - b);

    // CPU statistics
    const cpuValues = recent.map(m => m.cpu.percentage);
    cpuValues.sort((a, b) => a - b);

    // Event loop delay statistics
    const eventLoopValues = recent.map(m => m.eventLoop.delay);
    eventLoopValues.sort((a, b) => a - b);

    // GC statistics
    const gcCounts = recent.map(m => m.gc?.length || 0);
    const gcDurations = recent.flatMap(m => m.gc?.map(gc => gc.duration) || []);

    this.baseline = {
      memory: {
        averageHeapUsed: this.average(heapUsedValues),
        maxHeapUsed: Math.max(...heapUsedValues),
        p95HeapUsed: this.percentile(heapUsedValues, 0.95),
      },
      cpu: {
        averageUsage: this.average(cpuValues),
        maxUsage: Math.max(...cpuValues),
        p95Usage: this.percentile(cpuValues, 0.95),
      },
      eventLoop: {
        averageDelay: this.average(eventLoopValues),
        maxDelay: Math.max(...eventLoopValues),
        p95Delay: this.percentile(eventLoopValues, 0.95),
      },
      gc: {
        averageCount: this.average(gcCounts),
        averageDuration: gcDurations.length > 0 ? this.average(gcDurations) : 0,
      },
      calculatedAt: Date.now(),
      sampleCount: recent.length,
    };

    this.emit('baselineUpdated', this.baseline);
    this.logger.info('Performance baseline updated', {
      sampleCount: this.baseline.sampleCount,
      averageHeapUsed: Math.round(this.baseline.memory.averageHeapUsed / 1024 / 1024),
      averageCpuUsage: this.baseline.cpu.averageUsage.toFixed(2),
    });
  }

  private average(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
  }

  private percentile(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil(sortedValues.length * percentile) - 1;
    return sortedValues[Math.max(0, index)] || 0;
  }

  // Public API methods
  getCurrentMetrics(): PerformanceMetrics | undefined {
    return this.metricsHistory[this.metricsHistory.length - 1];
  }

  getMetricsHistory(limit?: number): PerformanceMetrics[] {
    return limit ? this.metricsHistory.slice(-limit) : [...this.metricsHistory];
  }

  getRecentAlerts(limit?: number): PerformanceAlert[] {
    return limit ? this.alerts.slice(-limit) : [...this.alerts];
  }

  getBaseline(): PerformanceBaseline | undefined {
    return this.baseline;
  }

  getPerformanceSummary(): {
    current: PerformanceMetrics | undefined;
    baseline: PerformanceBaseline | undefined;
    recentAlerts: PerformanceAlert[];
    trends: {
      memory: 'improving' | 'degrading' | 'stable';
      cpu: 'improving' | 'degrading' | 'stable';
      eventLoop: 'improving' | 'degrading' | 'stable';
    };
  } {
    return {
      current: this.getCurrentMetrics(),
      baseline: this.getBaseline(),
      recentAlerts: this.getRecentAlerts(10),
      trends: this.calculateTrends(),
    };
  }

  private calculateTrends(): {
    memory: 'improving' | 'degrading' | 'stable';
    cpu: 'improving' | 'degrading' | 'stable';
    eventLoop: 'improving' | 'degrading' | 'stable';
  } {
    if (this.metricsHistory.length < 20) {
      return { memory: 'stable', cpu: 'stable', eventLoop: 'stable' };
    }

    const recent = this.metricsHistory.slice(-10);
    const previous = this.metricsHistory.slice(-20, -10);

    const recentMemory = this.average(recent.map(m => m.memory.heapUsed));
    const previousMemory = this.average(previous.map(m => m.memory.heapUsed));

    const recentCpu = this.average(recent.map(m => m.cpu.percentage));
    const previousCpu = this.average(previous.map(m => m.cpu.percentage));

    const recentEventLoop = this.average(recent.map(m => m.eventLoop.delay));
    const previousEventLoop = this.average(previous.map(m => m.eventLoop.delay));

    return {
      memory: this.getTrend(recentMemory, previousMemory),
      cpu: this.getTrend(recentCpu, previousCpu),
      eventLoop: this.getTrend(recentEventLoop, previousEventLoop),
    };
  }

  private getTrend(recent: number, previous: number): 'improving' | 'degrading' | 'stable' {
    const change = (recent - previous) / previous;
    if (change > 0.1) return 'degrading';
    if (change < -0.1) return 'improving';
    return 'stable';
  }

  // Configuration and lifecycle
  updateConfig(newConfig: Partial<PerformanceMonitorConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Performance monitor configuration updated', newConfig);
  }

  stop(): void {
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = undefined;
    }

    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = undefined;
    }

    this.logger.info('Performance monitoring stopped');
  }

  start(): void {
    if (!this.collectTimer && this.config.enabled) {
      this.startMonitoring();
      this.logger.info('Performance monitoring started');
    }
  }

  destroy(): void {
    this.stop();
    this.metricsHistory.length = 0;
    this.alerts.length = 0;
    this.removeAllListeners();
    this.logger.info('Performance monitor destroyed');
  }
}
import { EventEmitter } from 'events';
import type { ServerConfig, ServerHealth, Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface HealthAggregatorConfig {
  checkInterval?: number;
  unhealthyThreshold?: number;
  degradedThreshold?: number;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export interface DependencyCheck {
  name: string;
  type: 'database' | 'redis' | 'external_api' | 'service' | 'custom';
  checkFn: () => Promise<DependencyHealth>;
  critical?: boolean;
  timeout?: number;
  metadata?: Record<string, any>;
}

export interface DependencyHealth {
  healthy: boolean;
  responseTime: number;
  error?: string;
  details?: Record<string, any>;
  lastCheck: Date;
}

export interface AggregatedHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  uptime: number;
  version: string;
  dependencies: Record<string, DependencyHealth>;
  servers: Record<string, ServerHealth>;
  metrics: {
    totalDependencies: number;
    healthyDependencies: number;
    criticalDependenciesDown: number;
    totalServers: number;
    healthyServers: number;
    averageResponseTime: number;
  };
  issues: string[];
  recommendations: string[];
}

export interface HealthTrend {
  timestamp: Date;
  status: 'healthy' | 'degraded' | 'unhealthy';
  healthScore: number; // 0-100
  responseTime: number;
  errorRate: number;
}

export class HealthAggregator extends EventEmitter {
  private readonly config: Required<HealthAggregatorConfig>;
  private readonly logger: Logger;
  private readonly dependencies: Map<string, DependencyCheck> = new Map();
  private readonly dependencyHealth: Map<string, DependencyHealth> = new Map();
  private readonly serverHealth: Map<string, ServerHealth> = new Map();
  private readonly healthHistory: HealthTrend[] = [];
  private checkInterval?: NodeJS.Timeout;
  private startTime: Date = new Date();

  constructor(config: HealthAggregatorConfig = {}, logger?: Logger) {
    super();

    this.config = {
      checkInterval: config.checkInterval ?? 30000, // 30 seconds
      unhealthyThreshold: config.unhealthyThreshold ?? 0.5, // 50% unhealthy = unhealthy
      degradedThreshold: config.degradedThreshold ?? 0.8, // 80% healthy = degraded
      timeoutMs: config.timeoutMs ?? 5000, // 5 seconds
      retryAttempts: config.retryAttempts ?? 2,
      retryDelayMs: config.retryDelayMs ?? 1000, // 1 second
    };

    this.logger = logger || createDefaultLogger();

    this.startHealthChecks();

    this.logger.info('Health aggregator initialized', {
      checkInterval: this.config.checkInterval,
      unhealthyThreshold: this.config.unhealthyThreshold,
      degradedThreshold: this.config.degradedThreshold,
    });
  }

  addDependency(dependency: DependencyCheck): void {
    this.dependencies.set(dependency.name, dependency);
    this.logger.info('Health dependency added', {
      name: dependency.name,
      type: dependency.type,
      critical: dependency.critical ?? false,
    });
  }

  removeDependency(name: string): boolean {
    const removed = this.dependencies.delete(name);
    if (removed) {
      this.dependencyHealth.delete(name);
      this.logger.info('Health dependency removed', { name });
    }
    return removed;
  }

  updateServerHealth(servers: Map<string, ServerHealth>): void {
    this.serverHealth.clear();
    for (const [key, health] of servers) {
      this.serverHealth.set(key, health);
    }
  }

  private startHealthChecks(): void {
    this.checkInterval = setInterval(() => {
      this.performHealthChecks().catch(error => {
        this.logger.error('Error during health checks', error);
      });
    }, this.config.checkInterval);

    // Perform initial check
    this.performHealthChecks().catch(error => {
      this.logger.error('Error during initial health check', error);
    });
  }

  private async performHealthChecks(): Promise<void> {
    const checkPromises = Array.from(this.dependencies.values()).map(dependency =>
      this.checkDependency(dependency)
    );

    const results = await Promise.allSettled(checkPromises);

    results.forEach((result, index) => {
      const dependency = Array.from(this.dependencies.values())[index];
      if (!dependency) return;

      if (result.status === 'fulfilled') {
        this.dependencyHealth.set(dependency.name, result.value);
      } else {
        // Create unhealthy result for failed checks
        this.dependencyHealth.set(dependency.name, {
          healthy: false,
          responseTime: 0,
          error: result.reason?.message || 'Health check failed',
          lastCheck: new Date(),
        });
      }
    });

    const aggregatedHealth = this.getAggregatedHealth();
    this.updateHealthHistory(aggregatedHealth);

    this.emit('healthCheck', aggregatedHealth);
  }

  private async checkDependency(dependency: DependencyCheck): Promise<DependencyHealth> {
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const timeout = dependency.timeout || this.config.timeoutMs;
        const healthResult = await Promise.race([
          dependency.checkFn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), timeout)
          ),
        ]);

        const responseTime = Date.now() - startTime;
        return {
          ...healthResult,
          responseTime,
          lastCheck: new Date(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (attempt < this.config.retryAttempts) {
          this.logger.debug(`Health check retry ${attempt + 1}/${this.config.retryAttempts}`, {
            dependency: dependency.name,
            error: lastError.message,
          });
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
        }
      }
    }

    const responseTime = Date.now() - startTime;
    return {
      healthy: false,
      responseTime,
      error: lastError?.message || 'Health check failed after retries',
      lastCheck: new Date(),
    };
  }

  getAggregatedHealth(): AggregatedHealth {
    const dependencies = Object.fromEntries(this.dependencyHealth);
    const servers = Object.fromEntries(this.serverHealth);

    const dependencyList = Array.from(this.dependencyHealth.values());
    const serverList = Array.from(this.serverHealth.values());

    // Calculate metrics
    const totalDependencies = dependencyList.length;
    const healthyDependencies = dependencyList.filter(d => d.healthy).length;
    const criticalDependenciesDown = Array.from(this.dependencies.values())
      .filter(dep => dep.critical && !this.dependencyHealth.get(dep.name)?.healthy)
      .length;

    const totalServers = serverList.length;
    const healthyServers = serverList.filter(s => s.healthy).length;

    const allResponseTimes = [
      ...dependencyList.map(d => d.responseTime),
      ...serverList.map(s => s.responseTime || 0),
    ];
    const averageResponseTime = allResponseTimes.length > 0
      ? allResponseTimes.reduce((sum, time) => sum + time, 0) / allResponseTimes.length
      : 0;

    // Determine overall status
    const status = this.calculateOverallStatus(
      healthyDependencies,
      totalDependencies,
      healthyServers,
      totalServers,
      criticalDependenciesDown
    );

    // Generate issues and recommendations
    const { issues, recommendations } = this.generateIssuesAndRecommendations(
      dependencies,
      servers,
      status
    );

    return {
      status,
      timestamp: new Date(),
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      version: process.env.npm_package_version || '1.0.0',
      dependencies,
      servers,
      metrics: {
        totalDependencies,
        healthyDependencies,
        criticalDependenciesDown,
        totalServers,
        healthyServers,
        averageResponseTime,
      },
      issues,
      recommendations,
    };
  }

  private calculateOverallStatus(
    healthyDependencies: number,
    totalDependencies: number,
    healthyServers: number,
    totalServers: number,
    criticalDependenciesDown: number
  ): 'healthy' | 'degraded' | 'unhealthy' {
    // If any critical dependencies are down, system is unhealthy
    if (criticalDependenciesDown > 0) {
      return 'unhealthy';
    }

    // Calculate health percentages
    const dependencyHealthRatio = totalDependencies > 0 ? healthyDependencies / totalDependencies : 1;
    const serverHealthRatio = totalServers > 0 ? healthyServers / totalServers : 1;

    // Overall health is the minimum of dependency and server health
    const overallHealthRatio = Math.min(dependencyHealthRatio, serverHealthRatio);

    if (overallHealthRatio < this.config.unhealthyThreshold) {
      return 'unhealthy';
    } else if (overallHealthRatio < this.config.degradedThreshold) {
      return 'degraded';
    } else {
      return 'healthy';
    }
  }

  private generateIssuesAndRecommendations(
    dependencies: Record<string, DependencyHealth>,
    servers: Record<string, ServerHealth>,
    status: 'healthy' | 'degraded' | 'unhealthy'
  ): { issues: string[]; recommendations: string[] } {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for unhealthy dependencies
    for (const [name, health] of Object.entries(dependencies)) {
      if (!health.healthy) {
        const dependency = this.dependencies.get(name);
        const critical = dependency?.critical ? ' (CRITICAL)' : '';
        issues.push(`Dependency ${name} is unhealthy${critical}: ${health.error}`);

        if (dependency?.critical) {
          recommendations.push(`Immediately investigate ${name} dependency failure`);
        }
      }

      // Check for slow response times
      if (health.responseTime > 5000) {
        issues.push(`Dependency ${name} has slow response time: ${health.responseTime}ms`);
        recommendations.push(`Optimize ${name} dependency or increase timeout`);
      }
    }

    // Check for unhealthy servers
    for (const [name, health] of Object.entries(servers)) {
      if (!health.healthy) {
        issues.push(`Server ${name} is unhealthy: ${health.error || 'Unknown error'}`);
        recommendations.push(`Check server ${name} logs and connectivity`);
      }

      // Check for high error rates
      if (health.consecutiveFailures > 3) {
        issues.push(`Server ${name} has ${health.consecutiveFailures} consecutive failures`);
        recommendations.push(`Consider removing ${name} from rotation temporarily`);
      }
    }

    // General recommendations based on status
    if (status === 'unhealthy') {
      recommendations.push('System is unhealthy - immediate action required');
      recommendations.push('Consider enabling maintenance mode');
    } else if (status === 'degraded') {
      recommendations.push('System performance is degraded - monitor closely');
      recommendations.push('Consider scaling up resources');
    }

    return { issues, recommendations };
  }

  private updateHealthHistory(health: AggregatedHealth): void {
    const healthScore = this.calculateHealthScore(health);
    const errorRate = this.calculateErrorRate(health);

    const trend: HealthTrend = {
      timestamp: health.timestamp,
      status: health.status,
      healthScore,
      responseTime: health.metrics.averageResponseTime,
      errorRate,
    };

    this.healthHistory.push(trend);

    // Keep only last 100 entries (about 50 minutes at 30s intervals)
    if (this.healthHistory.length > 100) {
      this.healthHistory.shift();
    }
  }

  private calculateHealthScore(health: AggregatedHealth): number {
    const total = health.metrics.totalDependencies + health.metrics.totalServers;
    const healthy = health.metrics.healthyDependencies + health.metrics.healthyServers;

    if (total === 0) return 100;

    // Base score from health ratio
    let score = (healthy / total) * 100;

    // Penalize for critical dependencies down
    if (health.metrics.criticalDependenciesDown > 0) {
      score = Math.max(0, score - (health.metrics.criticalDependenciesDown * 50));
    }

    // Penalize for slow response times
    if (health.metrics.averageResponseTime > 1000) {
      const penalty = Math.min(20, (health.metrics.averageResponseTime - 1000) / 100);
      score = Math.max(0, score - penalty);
    }

    return Math.round(score);
  }

  private calculateErrorRate(health: AggregatedHealth): number {
    const total = health.metrics.totalDependencies + health.metrics.totalServers;
    const unhealthy = total - (health.metrics.healthyDependencies + health.metrics.healthyServers);

    return total > 0 ? (unhealthy / total) * 100 : 0;
  }

  // Convenience methods for common dependency types
  addDatabaseCheck(
    name: string,
    checkFn: () => Promise<boolean>,
    critical: boolean = true
  ): void {
    this.addDependency({
      name,
      type: 'database',
      critical,
      checkFn: async () => {
        const startTime = Date.now();
        try {
          const healthy = await checkFn();
          return {
            healthy,
            responseTime: Date.now() - startTime,
            lastCheck: new Date(),
          };
        } catch (error) {
          return {
            healthy: false,
            responseTime: Date.now() - startTime,
            error: error instanceof Error ? error.message : 'Database check failed',
            lastCheck: new Date(),
          };
        }
      },
    });
  }

  addRedisCheck(
    name: string,
    checkFn: () => Promise<boolean>,
    critical: boolean = false
  ): void {
    this.addDependency({
      name,
      type: 'redis',
      critical,
      checkFn: async () => {
        const startTime = Date.now();
        try {
          const healthy = await checkFn();
          return {
            healthy,
            responseTime: Date.now() - startTime,
            lastCheck: new Date(),
          };
        } catch (error) {
          return {
            healthy: false,
            responseTime: Date.now() - startTime,
            error: error instanceof Error ? error.message : 'Redis check failed',
            lastCheck: new Date(),
          };
        }
      },
    });
  }

  addExternalApiCheck(
    name: string,
    url: string,
    critical: boolean = false
  ): void {
    this.addDependency({
      name,
      type: 'external_api',
      critical,
      metadata: { url },
      checkFn: async () => {
        const startTime = Date.now();
        try {
          const response = await fetch(url, {
            method: 'HEAD',
            timeout: this.config.timeoutMs,
          });

          return {
            healthy: response.ok,
            responseTime: Date.now() - startTime,
            details: {
              status: response.status,
              statusText: response.statusText,
            },
            lastCheck: new Date(),
          };
        } catch (error) {
          return {
            healthy: false,
            responseTime: Date.now() - startTime,
            error: error instanceof Error ? error.message : 'API check failed',
            lastCheck: new Date(),
          };
        }
      },
    });
  }

  // Health history and trends
  getHealthHistory(limit?: number): HealthTrend[] {
    return limit ? this.healthHistory.slice(-limit) : [...this.healthHistory];
  }

  getHealthTrend(): 'improving' | 'degrading' | 'stable' {
    if (this.healthHistory.length < 5) {
      return 'stable';
    }

    const recent = this.healthHistory.slice(-5);
    const scores = recent.map(h => h.healthScore);

    const firstScore = scores[0];
    const lastScore = scores[scores.length - 1];
    const change = lastScore - firstScore;

    if (change > 10) return 'improving';
    if (change < -10) return 'degrading';
    return 'stable';
  }

  // Lifecycle management
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    this.logger.info('Health aggregator stopped');
  }

  start(): void {
    if (!this.checkInterval) {
      this.startHealthChecks();
      this.logger.info('Health aggregator started');
    }
  }

  destroy(): void {
    this.stop();
    this.dependencies.clear();
    this.dependencyHealth.clear();
    this.serverHealth.clear();
    this.removeAllListeners();
    this.logger.info('Health aggregator destroyed');
  }
}
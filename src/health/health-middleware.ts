import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface HealthCheckInfo {
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  uptime: number;
  checks: Record<string, HealthCheckDetail>;
}

export interface HealthCheckDetail {
  status: 'pass' | 'fail' | 'warn';
  timestamp: string;
  output?: string;
  responseTime?: number;
  details?: Record<string, any>;
}

export interface HealthMiddlewareConfig {
  endpoint?: string;
  service?: string;
  version?: string;
  environment?: string;
  includeDetails?: boolean;
  checks?: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  check: () => Promise<HealthCheckDetail> | HealthCheckDetail;
}

export class HealthMiddleware {
  private readonly config: Required<Omit<HealthMiddlewareConfig, 'checks'>> & { checks: HealthCheck[] };
  private readonly logger: Logger;
  private readonly startTime: number;

  constructor(config: HealthMiddlewareConfig = {}, logger?: Logger) {
    this.config = {
      endpoint: config.endpoint || '/health',
      service: config.service || 'flow-control',
      version: config.version || '1.0.0',
      environment: config.environment || process.env['NODE_ENV'] || 'development',
      includeDetails: config.includeDetails ?? true,
      checks: config.checks || [],
    };
    this.logger = logger || createDefaultLogger();
    this.startTime = Date.now();
  }

  getMiddleware() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (req.path !== this.config.endpoint) {
        return next();
      }

      try {
        const healthInfo = await this.performHealthChecks();
        const overallStatus = this.determineOverallStatus(healthInfo.checks);

        res.status(overallStatus === 'pass' ? 200 : 503);
        res.json(healthInfo);

        this.logger.debug('Health check request completed', {
          status: overallStatus,
          endpoint: this.config.endpoint,
          checks: Object.keys(healthInfo.checks).length,
        });
      } catch (error) {
        this.logger.error('Health check middleware error', error);
        res.status(500).json({
          service: this.config.service,
          status: 'fail',
          timestamp: new Date().toISOString(),
          error: 'Internal health check error',
        });
      }
    };
  }

  private async performHealthChecks(): Promise<HealthCheckInfo> {
    const checks: Record<string, HealthCheckDetail> = {};

    // Add basic system checks
    checks['system'] = await this.performSystemCheck();

    // Add custom checks
    const customCheckPromises = this.config.checks.map(async (healthCheck) => {
      try {
        const result = await healthCheck.check();
        checks[healthCheck.name] = result;
      } catch (error) {
        checks[healthCheck.name] = {
          status: 'fail',
          timestamp: new Date().toISOString(),
          output: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    await Promise.allSettled(customCheckPromises);

    return {
      service: this.config.service,
      version: this.config.version,
      environment: this.config.environment,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      checks,
    };
  }

  private async performSystemCheck(): Promise<HealthCheckDetail> {
    const startTime = Date.now();

    try {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();

      const result: HealthCheckDetail = {
        status: 'pass',
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime,
        output: 'System is healthy',
      };

      if (this.config.includeDetails) {
        result.details = {
          memory: {
            rss: this.formatBytes(memoryUsage.rss),
            heapTotal: this.formatBytes(memoryUsage.heapTotal),
            heapUsed: this.formatBytes(memoryUsage.heapUsed),
            external: this.formatBytes(memoryUsage.external),
          },
          cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system,
          },
          uptime: Math.floor(process.uptime()),
          pid: process.pid,
          platform: process.platform,
          nodeVersion: process.version,
        };
      }

      return result;
    } catch (error) {
      return {
        status: 'fail',
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime,
        output: error instanceof Error ? error.message : 'System check failed',
      };
    }
  }

  private determineOverallStatus(checks: Record<string, HealthCheckDetail>): 'pass' | 'fail' | 'warn' {
    const statuses = Object.values(checks).map(check => check.status);

    if (statuses.includes('fail')) {
      return 'fail';
    }

    if (statuses.includes('warn')) {
      return 'warn';
    }

    return 'pass';
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  addHealthCheck(name: string, check: () => Promise<HealthCheckDetail> | HealthCheckDetail): void {
    this.config.checks.push({ name, check });
    this.logger.debug(`Added health check: ${name}`);
  }

  removeHealthCheck(name: string): boolean {
    const index = this.config.checks.findIndex(check => check.name === name);
    if (index !== -1) {
      this.config.checks.splice(index, 1);
      this.logger.debug(`Removed health check: ${name}`);
      return true;
    }
    return false;
  }

  getHealthCheckNames(): string[] {
    return this.config.checks.map(check => check.name);
  }
}
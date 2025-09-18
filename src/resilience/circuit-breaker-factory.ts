import { CircuitBreaker, type CircuitBreakerConfig, type CircuitBreakerStats } from './circuit-breaker.js';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export class CircuitBreakerFactory {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || createDefaultLogger();
  }

  getBreaker(
    name: string,
    config: CircuitBreakerConfig = {}
  ): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(config, this.logger));
      this.logger.debug(`Created circuit breaker: ${name}`);
    }
    return this.breakers.get(name)!;
  }

  async executeWithBreaker<T>(
    name: string,
    operation: () => Promise<T>,
    config?: CircuitBreakerConfig
  ): Promise<T> {
    const breaker = this.getBreaker(name, config);
    return breaker.execute(operation);
  }

  getBreakerStats(name: string): CircuitBreakerStats | undefined {
    const breaker = this.breakers.get(name);
    return breaker?.getStats();
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  resetBreaker(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.reset();
      this.logger.info(`Reset circuit breaker: ${name}`);
    }
  }

  resetAllBreakers(): void {
    for (const [, breaker] of this.breakers) {
      breaker.reset();
    }
    this.logger.info('Reset all circuit breakers');
  }

  forceOpenBreaker(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.forceOpen();
      this.logger.warn(`Forced open circuit breaker: ${name}`);
    }
  }

  forceCloseBreaker(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.forceClose();
      this.logger.info(`Forced close circuit breaker: ${name}`);
    }
  }

  removeBreaker(name: string): boolean {
    return this.breakers.delete(name);
  }

  getBreakerNames(): string[] {
    return Array.from(this.breakers.keys());
  }

  destroy(): void {
    this.breakers.clear();
    this.logger.info('Circuit breaker factory destroyed');
  }
}
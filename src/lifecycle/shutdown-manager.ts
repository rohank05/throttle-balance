import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface ShutdownManagerConfig {
  gracefulTimeoutMs?: number;
  forceExitTimeoutMs?: number;
  signals?: string[];
  drainDelay?: number;
  logShutdownProgress?: boolean;
}

export interface ShutdownTask {
  name: string;
  priority: number; // Lower numbers execute first
  timeout?: number;
  task: () => Promise<void> | void;
}

export interface ShutdownStatus {
  phase: 'idle' | 'draining' | 'shutting_down' | 'force_exit' | 'completed';
  startTime?: number;
  tasksCompleted: number;
  totalTasks: number;
  activeConnections: number;
  errors: string[];
}

export class ShutdownManager extends EventEmitter {
  private readonly config: Required<ShutdownManagerConfig>;
  private readonly logger: Logger;
  private readonly shutdownTasks: Map<string, ShutdownTask> = new Map();
  private status: ShutdownStatus = {
    phase: 'idle',
    tasksCompleted: 0,
    totalTasks: 0,
    activeConnections: 0,
    errors: [],
  };
  private server?: Server;
  private shutdownPromise?: Promise<void>;
  private shutdownResolve?: () => void;
  private shutdownReject?: (error: Error) => void;
  private signalHandlers: Map<string, () => void> = new Map();

  constructor(config: ShutdownManagerConfig = {}, logger?: Logger) {
    super();

    this.config = {
      gracefulTimeoutMs: config.gracefulTimeoutMs ?? 30000, // 30 seconds
      forceExitTimeoutMs: config.forceExitTimeoutMs ?? 5000, // 5 seconds
      signals: config.signals ?? ['SIGTERM', 'SIGINT'],
      drainDelay: config.drainDelay ?? 1000, // 1 second
      logShutdownProgress: config.logShutdownProgress ?? true,
    };

    this.logger = logger || createDefaultLogger();

    this.setupSignalHandlers();

    this.logger.info('Shutdown manager initialized', {
      gracefulTimeout: this.config.gracefulTimeoutMs,
      forceExitTimeout: this.config.forceExitTimeoutMs,
      signals: this.config.signals,
    });
  }

  private setupSignalHandlers(): void {
    for (const signal of this.config.signals) {
      const handler = () => {
        this.logger.info(`Received ${signal} signal, initiating graceful shutdown`);
        this.initiateShutdown().catch(error => {
          this.logger.error(`Error during shutdown from ${signal}`, error);
          process.exit(1);
        });
      };

      this.signalHandlers.set(signal, handler);
      process.on(signal as NodeJS.Signals, handler);
    }
  }

  setServer(server: Server): void {
    this.server = server;
    this.trackActiveConnections();
    this.logger.info('HTTP server attached to shutdown manager');
  }

  private trackActiveConnections(): void {
    if (!this.server) return;

    this.server.on('connection', (socket) => {
      this.status.activeConnections++;
      socket.on('close', () => {
        this.status.activeConnections--;
      });
    });
  }

  addShutdownTask(task: ShutdownTask): void {
    this.shutdownTasks.set(task.name, task);
    this.status.totalTasks = this.shutdownTasks.size;

    this.logger.debug('Shutdown task added', {
      name: task.name,
      priority: task.priority,
      totalTasks: this.status.totalTasks,
    });
  }

  removeShutdownTask(name: string): boolean {
    const removed = this.shutdownTasks.delete(name);
    if (removed) {
      this.status.totalTasks = this.shutdownTasks.size;
      this.logger.debug('Shutdown task removed', { name, totalTasks: this.status.totalTasks });
    }
    return removed;
  }

  getShutdownTasks(): ShutdownTask[] {
    return Array.from(this.shutdownTasks.values()).sort((a, b) => a.priority - b.priority);
  }

  getStatus(): ShutdownStatus {
    return { ...this.status };
  }

  isShuttingDown(): boolean {
    return this.status.phase !== 'idle';
  }

  async initiateShutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      this.shutdownResolve = resolve;
      this.shutdownReject = reject;
    });

    this.status.phase = 'draining';
    this.status.startTime = Date.now();
    this.status.errors = [];

    this.emit('shutdownStarted', this.status);

    try {
      await this.executeShutdownSequence();
      this.status.phase = 'completed';
      this.emit('shutdownCompleted', this.status);
      this.shutdownResolve?.();
    } catch (error) {
      this.status.phase = 'force_exit';
      this.status.errors.push(error instanceof Error ? error.message : 'Unknown error');
      this.emit('shutdownFailed', this.status);
      this.shutdownReject?.(error instanceof Error ? error : new Error('Shutdown failed'));
    }

    return this.shutdownPromise;
  }

  private async executeShutdownSequence(): Promise<void> {
    // Phase 1: Drain new connections
    await this.drainConnections();

    // Phase 2: Execute shutdown tasks
    await this.executeShutdownTasks();

    // Phase 3: Force close remaining connections
    await this.forceCloseConnections();
  }

  private async drainConnections(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.logger.info('Starting connection draining');

    // Stop accepting new connections
    this.server.close();

    // Wait for the drain delay to allow existing requests to complete
    if (this.config.drainDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.drainDelay));
    }

    this.emit('connectionsDrained', {
      activeConnections: this.status.activeConnections,
    });

    if (this.config.logShutdownProgress) {
      this.logger.info('Connection draining completed', {
        activeConnections: this.status.activeConnections,
      });
    }
  }

  private async executeShutdownTasks(): Promise<void> {
    this.status.phase = 'shutting_down';

    const tasks = this.getShutdownTasks();
    this.logger.info(`Executing ${tasks.length} shutdown tasks`);

    const gracefulTimeout = setTimeout(() => {
      const error = new Error(`Graceful shutdown timeout after ${this.config.gracefulTimeoutMs}ms`);
      this.logger.error(error.message);
      throw error;
    }, this.config.gracefulTimeoutMs);

    try {
      for (const task of tasks) {
        const taskStartTime = Date.now();

        try {
          if (this.config.logShutdownProgress) {
            this.logger.info(`Executing shutdown task: ${task.name}`);
          }

          // Execute task with optional timeout
          if (task.timeout) {
            await Promise.race([
              Promise.resolve(task.task()),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Task ${task.name} timeout`)), task.timeout)
              ),
            ]);
          } else {
            await Promise.resolve(task.task());
          }

          const taskDuration = Date.now() - taskStartTime;
          this.status.tasksCompleted++;

          this.emit('taskCompleted', {
            taskName: task.name,
            duration: taskDuration,
            completed: this.status.tasksCompleted,
            total: this.status.totalTasks,
          });

          if (this.config.logShutdownProgress) {
            this.logger.info(`Shutdown task completed: ${task.name}`, {
              duration: taskDuration,
              progress: `${this.status.tasksCompleted}/${this.status.totalTasks}`,
            });
          }
        } catch (error) {
          const errorMessage = `Task ${task.name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          this.status.errors.push(errorMessage);

          this.emit('taskFailed', {
            taskName: task.name,
            error: errorMessage,
          });

          this.logger.error(`Shutdown task failed: ${task.name}`, error);

          // Continue with other tasks even if one fails
        }
      }
    } finally {
      clearTimeout(gracefulTimeout);
    }
  }

  private async forceCloseConnections(): Promise<void> {
    if (!this.server || this.status.activeConnections === 0) {
      return;
    }

    this.logger.warn(`Force closing ${this.status.activeConnections} remaining connections`);

    const forceTimeout = setTimeout(() => {
      this.logger.error(`Force exit timeout after ${this.config.forceExitTimeoutMs}ms`);
      process.exit(1);
    }, this.config.forceExitTimeoutMs);

    try {
      // Destroy all remaining connections
      if (this.server.listening) {
        await new Promise<void>((resolve, reject) => {
          this.server!.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    } finally {
      clearTimeout(forceTimeout);
    }

    this.emit('forcedShutdown', {
      forcedConnections: this.status.activeConnections,
    });
  }

  // Convenience methods for common shutdown tasks
  addDatabaseShutdown(name: string, closeConnection: () => Promise<void>): void {
    this.addShutdownTask({
      name: `database:${name}`,
      priority: 100, // High priority for databases
      timeout: 5000,
      task: async () => {
        this.logger.info(`Closing database connection: ${name}`);
        await closeConnection();
      },
    });
  }

  addRedisShutdown(name: string, closeConnection: () => Promise<void>): void {
    this.addShutdownTask({
      name: `redis:${name}`,
      priority: 150, // After databases
      timeout: 3000,
      task: async () => {
        this.logger.info(`Closing Redis connection: ${name}`);
        await closeConnection();
      },
    });
  }

  addMetricsShutdown(name: string, flushMetrics: () => Promise<void>): void {
    this.addShutdownTask({
      name: `metrics:${name}`,
      priority: 200, // After data stores
      timeout: 2000,
      task: async () => {
        this.logger.info(`Flushing metrics: ${name}`);
        await flushMetrics();
      },
    });
  }

  addTracingShutdown(name: string, shutdownTracing: () => Promise<void>): void {
    this.addShutdownTask({
      name: `tracing:${name}`,
      priority: 250, // After metrics
      timeout: 2000,
      task: async () => {
        this.logger.info(`Shutting down tracing: ${name}`);
        await shutdownTracing();
      },
    });
  }

  addLoggingShutdown(name: string, flushLogs: () => Promise<void>): void {
    this.addShutdownTask({
      name: `logging:${name}`,
      priority: 900, // Near the end
      timeout: 1000,
      task: async () => {
        this.logger.info(`Flushing logs: ${name}`);
        await flushLogs();
      },
    });
  }

  // Health check endpoint for shutdown status
  getHealthStatus(): {
    status: 'healthy' | 'draining' | 'shutting_down';
    activeConnections: number;
    shutdownProgress?: number;
  } {
    let status: 'healthy' | 'draining' | 'shutting_down';

    switch (this.status.phase) {
      case 'idle':
        status = 'healthy';
        break;
      case 'draining':
        status = 'draining';
        break;
      default:
        status = 'shutting_down';
        break;
    }

    const result: any = {
      status,
      activeConnections: this.status.activeConnections,
    };

    if (this.status.phase !== 'idle' && this.status.totalTasks > 0) {
      result.shutdownProgress = this.status.tasksCompleted / this.status.totalTasks;
    }

    return result;
  }

  // Force shutdown (should only be used in extreme cases)
  forceShutdown(): void {
    this.logger.warn('Force shutdown initiated');
    this.cleanup();
    process.exit(1);
  }

  private cleanup(): void {
    // Remove signal handlers
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal as NodeJS.Signals, handler);
    }
    this.signalHandlers.clear();

    // Clear all listeners
    this.removeAllListeners();
  }

  destroy(): void {
    this.cleanup();
    this.logger.info('Shutdown manager destroyed');
  }
}
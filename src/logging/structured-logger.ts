import type { Logger } from '../types/index.js';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export interface LogContext {
  correlationId?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  component?: string;
  operation?: string;
  duration?: number;
  statusCode?: number;
  errorCode?: string;
  metadata?: Record<string, any>;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

export interface LogTransport {
  name: string;
  level: LogLevel;
  write(entry: LogEntry): Promise<void> | void;
}

export interface StructuredLoggerConfig {
  level?: LogLevel;
  transports?: LogTransport[];
  defaultContext?: LogContext;
  enableStackTrace?: boolean;
  enableTimestamp?: boolean;
  timestampFormat?: 'iso' | 'unix' | 'custom';
  customTimestampFormatter?: () => string;
  enableColors?: boolean;
  prettyPrint?: boolean;
  maskSensitiveData?: boolean;
  sensitiveFields?: string[];
}

export class ConsoleTransport implements LogTransport {
  name = 'console';
  level: LogLevel;
  private enableColors: boolean;
  private prettyPrint: boolean;

  constructor(level: LogLevel = LogLevel.INFO, options: { enableColors?: boolean; prettyPrint?: boolean } = {}) {
    this.level = level;
    this.enableColors = options.enableColors ?? true;
    this.prettyPrint = options.prettyPrint ?? true;
  }

  write(entry: LogEntry): void {
    const output = this.prettyPrint ? this.formatPretty(entry) : JSON.stringify(entry);
    const finalOutput = this.prettyPrint ? this.colorize(output, this.getColorForLevel(entry.level)) : output;

    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(finalOutput);
        break;
      case LogLevel.WARN:
        console.warn(finalOutput);
        break;
      case LogLevel.INFO:
        console.info(finalOutput);
        break;
      case LogLevel.DEBUG:
        console.debug(finalOutput);
        break;
      default:
        console.log(finalOutput);
    }
  }

  private formatPretty(entry: LogEntry): string {
    const parts = [
      entry.timestamp,
      `[${entry.level.toUpperCase()}]`,
      entry.message,
    ];

    if (entry.context) {
      const contextStr = Object.entries(entry.context)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      if (contextStr) {
        parts.push(`{${contextStr}}`);
      }
    }

    if (entry.error) {
      parts.push(`ERROR: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push('\n' + entry.error.stack);
      }
    }

    return parts.join(' ');
  }

  private getColorForLevel(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return 'red';
      case LogLevel.WARN:
        return 'yellow';
      case LogLevel.INFO:
        return 'green';
      case LogLevel.DEBUG:
        return 'blue';
      default:
        return '';
    }
  }

  private colorize(text: string, color: string): string {
    if (!this.enableColors) {
      return text;
    }

    const colors: Record<string, string> = {
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      reset: '\x1b[0m',
    };

    return `${colors[color] || ''}${text}${colors['reset']}`;
  }
}

export class FileTransport implements LogTransport {
  name = 'file';
  level: LogLevel;
  private filePath: string;

  constructor(filePath: string, level: LogLevel = LogLevel.INFO) {
    this.filePath = filePath;
    this.level = level;
  }

  async write(entry: LogEntry): Promise<void> {
    const fs = await import('fs/promises');
    const logLine = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.filePath, logLine, 'utf8');
  }
}

export class StructuredLogger implements Logger {
  private config: {
    level: LogLevel;
    enableStackTrace: boolean;
    enableTimestamp: boolean;
    timestampFormat: 'iso' | 'unix' | 'custom';
    enableColors: boolean;
    prettyPrint: boolean;
    maskSensitiveData: boolean;
    sensitiveFields: string[];
    transports: LogTransport[];
    defaultContext?: LogContext;
    customTimestampFormatter?: () => string;
  };

  constructor(config: StructuredLoggerConfig = {}) {
    this.config = {
      level: config.level ?? LogLevel.INFO,
      transports: config.transports ?? [new ConsoleTransport()],
      enableStackTrace: config.enableStackTrace ?? true,
      enableTimestamp: config.enableTimestamp ?? true,
      timestampFormat: config.timestampFormat ?? 'iso',
      enableColors: config.enableColors ?? true,
      prettyPrint: config.prettyPrint ?? true,
      maskSensitiveData: config.maskSensitiveData ?? true,
      sensitiveFields: config.sensitiveFields ?? [
        'password', 'token', 'authorization', 'secret', 'key', 'apiKey',
        'accessToken', 'refreshToken', 'sessionId', 'cookie'
      ],
    };

    if (config.defaultContext) {
      this.config.defaultContext = config.defaultContext;
    }
    if (config.customTimestampFormatter) {
      this.config.customTimestampFormatter = config.customTimestampFormatter;
    }
  }

  error(message: string, meta?: any): void {
    this.log(LogLevel.ERROR, message, meta);
  }

  warn(message: string, meta?: any): void {
    this.log(LogLevel.WARN, message, meta);
  }

  info(message: string, meta?: any): void {
    this.log(LogLevel.INFO, message, meta);
  }

  debug(message: string, meta?: any): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  private log(level: LogLevel, message: string, meta?: any): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = this.createLogEntry(level, message, meta);
    this.writeToTransports(entry);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
    const currentLevelIndex = levels.indexOf(this.config.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex <= currentLevelIndex;
  }

  private shouldTransportLog(entryLevel: LogLevel, transportLevel: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
    const transportLevelIndex = levels.indexOf(transportLevel);
    const entryLevelIndex = levels.indexOf(entryLevel);
    return entryLevelIndex <= transportLevelIndex;
  }

  private createLogEntry(level: LogLevel, message: string, meta?: any): LogEntry {
    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      message,
    };

    // Process metadata
    if (meta) {
      if (meta instanceof Error) {
        entry.error = this.serializeError(meta);
      } else if (typeof meta === 'object') {
        const processedMeta = this.config.maskSensitiveData
          ? this.maskSensitiveData(meta)
          : meta;

        // Extract context and metadata
        const context: LogContext = {};
        const metadata: Record<string, any> = {};

        Object.entries(processedMeta).forEach(([key, value]) => {
          if (this.isContextField(key)) {
            (context as any)[key] = value;
          } else {
            metadata[key] = value;
          }
        });

        if (Object.keys(context).length > 0) {
          entry.context = { ...this.config.defaultContext, ...context };
        }

        if (Object.keys(metadata).length > 0) {
          if (!entry.context) {
            entry.context = { ...this.config.defaultContext };
          }
          entry.context.metadata = metadata;
        }
      }
    } else if (this.config.defaultContext) {
      entry.context = { ...this.config.defaultContext };
    }

    return entry;
  }

  private isContextField(key: string): boolean {
    const contextFields = [
      'correlationId', 'userId', 'sessionId', 'requestId', 'component',
      'operation', 'duration', 'statusCode', 'errorCode'
    ];
    return contextFields.includes(key);
  }

  private serializeError(error: Error): { name: string; message: string; stack?: string; code?: string } {
    const serialized: any = {
      name: error.name,
      message: error.message,
    };

    if (this.config.enableStackTrace && error.stack) {
      serialized.stack = error.stack;
    }

    if ('code' in error) {
      serialized.code = (error as any).code;
    }

    return serialized;
  }

  private maskSensitiveData(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    const masked = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const [key, value] of Object.entries(masked)) {
      const lowerKey = key.toLowerCase();

      if (this.config.sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()))) {
        masked[key] = '[MASKED]';
      } else if (typeof value === 'object' && value !== null) {
        masked[key] = this.maskSensitiveData(value);
      }
    }

    return masked;
  }

  private formatTimestamp(): string {
    const now = new Date();

    switch (this.config.timestampFormat) {
      case 'unix':
        return Math.floor(now.getTime() / 1000).toString();
      case 'custom':
        return this.config.customTimestampFormatter?.() ?? now.toISOString();
      case 'iso':
      default:
        return now.toISOString();
    }
  }

  private writeToTransports(entry: LogEntry): void {
    for (const transport of this.config.transports) {
      if (this.shouldTransportLog(entry.level, transport.level)) {
        try {
          const result = transport.write(entry);
          if (result instanceof Promise) {
            result.catch(error => {
              console.error(`Transport ${transport.name} failed to write log:`, error);
            });
          }
        } catch (error) {
          console.error(`Transport ${transport.name} failed to write log:`, error);
        }
      }
    }
  }

  child(context: LogContext): StructuredLogger {
    const childConfig = {
      ...this.config,
      defaultContext: {
        ...this.config.defaultContext,
        ...context,
      },
    };
    return new StructuredLogger(childConfig);
  }

  addTransport(transport: LogTransport): void {
    this.config.transports.push(transport);
  }

  removeTransport(name: string): boolean {
    const index = this.config.transports.findIndex(t => t.name === name);
    if (index > -1) {
      this.config.transports.splice(index, 1);
      return true;
    }
    return false;
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  getLevel(): LogLevel {
    return this.config.level;
  }

  getConfig(): StructuredLoggerConfig {
    const config: StructuredLoggerConfig = {
      level: this.config.level,
      transports: [...this.config.transports],
      enableStackTrace: this.config.enableStackTrace,
      enableTimestamp: this.config.enableTimestamp,
      timestampFormat: this.config.timestampFormat,
      enableColors: this.config.enableColors,
      prettyPrint: this.config.prettyPrint,
      maskSensitiveData: this.config.maskSensitiveData,
      sensitiveFields: [...this.config.sensitiveFields],
    };

    if (this.config.defaultContext) {
      config.defaultContext = { ...this.config.defaultContext };
    }
    if (this.config.customTimestampFormatter) {
      config.customTimestampFormatter = this.config.customTimestampFormatter;
    }

    return config;
  }

  getStats(): {
    level: LogLevel;
    transportsCount: number;
    transports: Array<{ name: string; level: LogLevel }>;
    hasSensitiveDataMasking: boolean;
    hasDefaultContext: boolean;
  } {
    return {
      level: this.config.level,
      transportsCount: this.config.transports.length,
      transports: this.config.transports.map(t => ({
        name: t.name,
        level: t.level,
      })),
      hasSensitiveDataMasking: this.config.maskSensitiveData,
      hasDefaultContext: !!this.config.defaultContext,
    };
  }
}
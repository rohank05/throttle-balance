import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface SecurityHeadersConfig {
  contentSecurityPolicy?: {
    enabled?: boolean;
    directives?: Record<string, string | string[]>;
    reportOnly?: boolean;
    reportUri?: string;
  };
  strictTransportSecurity?: {
    enabled?: boolean;
    maxAge?: number;
    includeSubDomains?: boolean;
    preload?: boolean;
  };
  xFrameOptions?: {
    enabled?: boolean;
    value?: 'DENY' | 'SAMEORIGIN' | string;
  };
  xContentTypeOptions?: {
    enabled?: boolean;
  };
  xXSSProtection?: {
    enabled?: boolean;
    mode?: 'block' | 'report';
    reportUri?: string;
  };
  referrerPolicy?: {
    enabled?: boolean;
    policy?: 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' |
            'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';
  };
  permissionsPolicy?: {
    enabled?: boolean;
    directives?: Record<string, string | string[]>;
  };
  crossOriginEmbedderPolicy?: {
    enabled?: boolean;
    value?: 'unsafe-none' | 'require-corp';
  };
  crossOriginOpenerPolicy?: {
    enabled?: boolean;
    value?: 'unsafe-none' | 'same-origin-allow-popups' | 'same-origin';
  };
  crossOriginResourcePolicy?: {
    enabled?: boolean;
    value?: 'same-site' | 'same-origin' | 'cross-origin';
  };
  customHeaders?: Record<string, string>;
  removeHeaders?: string[];
  reportUri?: string;
}

export interface SecurityHeadersStats {
  headersSet: Record<string, string>;
  headersRemoved: string[];
  reportUri?: string;
  totalRequests: number;
}

export class SecurityHeaders {
  private readonly config: SecurityHeadersConfig;
  private readonly logger: Logger;
  private stats: SecurityHeadersStats;

  constructor(config: SecurityHeadersConfig = {}, logger?: Logger) {
    this.config = this.createDefaultConfig(config);
    this.logger = logger || createDefaultLogger();
    this.stats = {
      headersSet: {},
      headersRemoved: [],
      totalRequests: 0,
    };
  }

  private createDefaultConfig(config: SecurityHeadersConfig): SecurityHeadersConfig {
    return {
      contentSecurityPolicy: {
        enabled: config.contentSecurityPolicy?.enabled ?? true,
        directives: config.contentSecurityPolicy?.directives ?? {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'media-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-src': ["'none'"],
          'worker-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'base-uri': ["'self'"],
          'manifest-src': ["'self'"],
        },
        reportOnly: config.contentSecurityPolicy?.reportOnly ?? false,
        ...(config.contentSecurityPolicy?.reportUri && { reportUri: config.contentSecurityPolicy.reportUri }),
      },
      strictTransportSecurity: {
        enabled: config.strictTransportSecurity?.enabled ?? true,
        maxAge: config.strictTransportSecurity?.maxAge ?? 31536000, // 1 year
        includeSubDomains: config.strictTransportSecurity?.includeSubDomains ?? true,
        preload: config.strictTransportSecurity?.preload ?? false,
      },
      xFrameOptions: {
        enabled: config.xFrameOptions?.enabled ?? true,
        value: config.xFrameOptions?.value ?? 'DENY',
      },
      xContentTypeOptions: {
        enabled: config.xContentTypeOptions?.enabled ?? true,
      },
      xXSSProtection: {
        enabled: config.xXSSProtection?.enabled ?? true,
        mode: config.xXSSProtection?.mode ?? 'block',
        ...(config.xXSSProtection?.reportUri && { reportUri: config.xXSSProtection.reportUri }),
      },
      referrerPolicy: {
        enabled: config.referrerPolicy?.enabled ?? true,
        policy: config.referrerPolicy?.policy ?? 'strict-origin-when-cross-origin',
      },
      permissionsPolicy: {
        enabled: config.permissionsPolicy?.enabled ?? true,
        directives: config.permissionsPolicy?.directives ?? {
          'camera': ['()'],
          'microphone': ['()'],
          'geolocation': ['()'],
          'interest-cohort': ['()'],
        },
      },
      crossOriginEmbedderPolicy: {
        enabled: config.crossOriginEmbedderPolicy?.enabled ?? false,
        value: config.crossOriginEmbedderPolicy?.value ?? 'unsafe-none',
      },
      crossOriginOpenerPolicy: {
        enabled: config.crossOriginOpenerPolicy?.enabled ?? true,
        value: config.crossOriginOpenerPolicy?.value ?? 'same-origin',
      },
      crossOriginResourcePolicy: {
        enabled: config.crossOriginResourcePolicy?.enabled ?? true,
        value: config.crossOriginResourcePolicy?.value ?? 'same-origin',
      },
      customHeaders: config.customHeaders ?? {},
      removeHeaders: config.removeHeaders ?? [
        'X-Powered-By',
        'Server',
        'X-AspNet-Version',
        'X-AspNetMvc-Version',
      ],
      ...(config.reportUri && { reportUri: config.reportUri }),
    };
  }

  applyHeaders(req: Request, res: Response): void {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Content Security Policy
    if (this.config.contentSecurityPolicy?.enabled) {
      const cspValue = this.buildCSPHeader();
      const headerName = this.config.contentSecurityPolicy.reportOnly
        ? 'Content-Security-Policy-Report-Only'
        : 'Content-Security-Policy';
      res.setHeader(headerName, cspValue);
      this.stats.headersSet[headerName] = cspValue;
    }

    // Strict Transport Security (only for HTTPS)
    if (this.config.strictTransportSecurity?.enabled && isHttps) {
      const hstsValue = this.buildHSTSHeader();
      res.setHeader('Strict-Transport-Security', hstsValue);
      this.stats.headersSet['Strict-Transport-Security'] = hstsValue;
    }

    // X-Frame-Options
    if (this.config.xFrameOptions?.enabled) {
      const value = this.config.xFrameOptions.value!;
      res.setHeader('X-Frame-Options', value);
      this.stats.headersSet['X-Frame-Options'] = value;
    }

    // X-Content-Type-Options
    if (this.config.xContentTypeOptions?.enabled) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      this.stats.headersSet['X-Content-Type-Options'] = 'nosniff';
    }

    // X-XSS-Protection
    if (this.config.xXSSProtection?.enabled) {
      const xssValue = this.buildXSSProtectionHeader();
      res.setHeader('X-XSS-Protection', xssValue);
      this.stats.headersSet['X-XSS-Protection'] = xssValue;
    }

    // Referrer Policy
    if (this.config.referrerPolicy?.enabled) {
      const value = this.config.referrerPolicy.policy!;
      res.setHeader('Referrer-Policy', value);
      this.stats.headersSet['Referrer-Policy'] = value;
    }

    // Permissions Policy
    if (this.config.permissionsPolicy?.enabled) {
      const permissionsValue = this.buildPermissionsPolicyHeader();
      res.setHeader('Permissions-Policy', permissionsValue);
      this.stats.headersSet['Permissions-Policy'] = permissionsValue;
    }

    // Cross-Origin-Embedder-Policy
    if (this.config.crossOriginEmbedderPolicy?.enabled) {
      const value = this.config.crossOriginEmbedderPolicy.value!;
      res.setHeader('Cross-Origin-Embedder-Policy', value);
      this.stats.headersSet['Cross-Origin-Embedder-Policy'] = value;
    }

    // Cross-Origin-Opener-Policy
    if (this.config.crossOriginOpenerPolicy?.enabled) {
      const value = this.config.crossOriginOpenerPolicy.value!;
      res.setHeader('Cross-Origin-Opener-Policy', value);
      this.stats.headersSet['Cross-Origin-Opener-Policy'] = value;
    }

    // Cross-Origin-Resource-Policy
    if (this.config.crossOriginResourcePolicy?.enabled) {
      const value = this.config.crossOriginResourcePolicy.value!;
      res.setHeader('Cross-Origin-Resource-Policy', value);
      this.stats.headersSet['Cross-Origin-Resource-Policy'] = value;
    }

    // Custom headers
    if (this.config.customHeaders) {
      Object.entries(this.config.customHeaders).forEach(([name, value]) => {
        res.setHeader(name, value);
        this.stats.headersSet[name] = value;
      });
    }

    // Remove unwanted headers
    if (this.config.removeHeaders) {
      this.config.removeHeaders.forEach(headerName => {
        res.removeHeader(headerName);
        if (!this.stats.headersRemoved.includes(headerName)) {
          this.stats.headersRemoved.push(headerName);
        }
      });
    }

    this.stats.totalRequests++;

    this.logger.debug('Security headers applied', {
      path: req.path,
      method: req.method,
      isHttps,
      headersCount: Object.keys(this.stats.headersSet).length,
    });
  }

  private buildCSPHeader(): string {
    const directives = this.config.contentSecurityPolicy!.directives!;
    const parts: string[] = [];

    Object.entries(directives).forEach(([directive, sources]) => {
      const sourceList = Array.isArray(sources) ? sources.join(' ') : sources;
      parts.push(`${directive} ${sourceList}`);
    });

    // Add report-uri if specified
    if (this.config.contentSecurityPolicy!.reportUri) {
      parts.push(`report-uri ${this.config.contentSecurityPolicy!.reportUri}`);
    } else if (this.config.reportUri) {
      parts.push(`report-uri ${this.config.reportUri}`);
    }

    return parts.join('; ');
  }

  private buildHSTSHeader(): string {
    const hsts = this.config.strictTransportSecurity!;
    let value = `max-age=${hsts.maxAge}`;

    if (hsts.includeSubDomains) {
      value += '; includeSubDomains';
    }

    if (hsts.preload) {
      value += '; preload';
    }

    return value;
  }

  private buildXSSProtectionHeader(): string {
    const xss = this.config.xXSSProtection!;
    let value = '1';

    if (xss.mode === 'block') {
      value += '; mode=block';
    }

    if (xss.reportUri) {
      value += `; report=${xss.reportUri}`;
    }

    return value;
  }

  private buildPermissionsPolicyHeader(): string {
    const directives = this.config.permissionsPolicy!.directives!;
    const parts: string[] = [];

    Object.entries(directives).forEach(([feature, allowlist]) => {
      const sources = Array.isArray(allowlist) ? allowlist.join(' ') : allowlist;
      parts.push(`${feature}=(${sources})`);
    });

    return parts.join(', ');
  }

  getMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      try {
        this.applyHeaders(req, res);
        next();
      } catch (error) {
        this.logger.error('Security headers middleware error', error);
        next();
      }
    };
  }

  updateConfig(newConfig: Partial<SecurityHeadersConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Security headers configuration updated');
  }

  addCustomHeader(name: string, value: string): void {
    if (!this.config.customHeaders) {
      this.config.customHeaders = {};
    }
    this.config.customHeaders[name] = value;
    this.logger.info(`Added custom security header: ${name}`);
  }

  removeCustomHeader(name: string): boolean {
    if (this.config.customHeaders && this.config.customHeaders[name]) {
      delete this.config.customHeaders[name];
      this.logger.info(`Removed custom security header: ${name}`);
      return true;
    }
    return false;
  }

  addHeaderToRemove(headerName: string): void {
    if (!this.config.removeHeaders) {
      this.config.removeHeaders = [];
    }
    if (!this.config.removeHeaders.includes(headerName)) {
      this.config.removeHeaders.push(headerName);
      this.logger.info(`Added header to removal list: ${headerName}`);
    }
  }

  removeHeaderFromRemovalList(headerName: string): boolean {
    if (this.config.removeHeaders) {
      const index = this.config.removeHeaders.indexOf(headerName);
      if (index > -1) {
        this.config.removeHeaders.splice(index, 1);
        this.logger.info(`Removed header from removal list: ${headerName}`);
        return true;
      }
    }
    return false;
  }

  getStats(): SecurityHeadersStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      headersSet: {},
      headersRemoved: [],
      totalRequests: 0,
    };
    this.logger.info('Security headers stats reset');
  }

  getConfig(): SecurityHeadersConfig {
    return JSON.parse(JSON.stringify(this.config));
  }
}
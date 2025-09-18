import type { Request, Response, NextFunction } from 'express';
import * as ipaddr from 'ipaddr.js';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export enum IPFilterAction {
  ALLOW = 'allow',
  BLOCK = 'block',
  LOG = 'log',
}

export interface IPRule {
  ip: string;
  action: IPFilterAction;
  description?: string;
  priority?: number;
}

export interface IPFilterConfig {
  mode?: 'whitelist' | 'blacklist' | 'hybrid';
  defaultAction?: IPFilterAction;
  whitelist?: string[];
  blacklist?: string[];
  rules?: IPRule[];
  trustProxy?: boolean;
  logActions?: boolean;
  onBlocked?: (req: Request, ip: string, rule?: IPRule) => void;
  onAllowed?: (req: Request, ip: string, rule?: IPRule) => void;
}

export interface IPFilterResult {
  allowed: boolean;
  action: IPFilterAction;
  ip: string;
  rule?: IPRule;
  reason: string;
}

export class IPFilterError extends Error {
  public readonly statusCode: number;
  public readonly ip: string;

  constructor(message: string, ip: string, statusCode: number = 403) {
    super(message);
    this.name = 'IPFilterError';
    this.ip = ip;
    this.statusCode = statusCode;
  }
}

export class IPFilter {
  private readonly config: {
    mode: 'whitelist' | 'blacklist' | 'hybrid';
    defaultAction: IPFilterAction;
    trustProxy: boolean;
    logActions: boolean;
    whitelist: string[];
    blacklist: string[];
    rules: IPRule[];
    onBlocked?: (req: Request, ip: string, rule?: IPRule) => void;
    onAllowed?: (req: Request, ip: string, rule?: IPRule) => void;
  };
  private readonly logger: Logger;
  private readonly compiledRules: Map<string, IPRule> = new Map();
  private readonly cidrRanges: Array<{ range: any; rule: IPRule }> = [];

  constructor(config: IPFilterConfig = {}, logger?: Logger) {
    this.config = {
      mode: config.mode || 'hybrid',
      defaultAction: config.defaultAction || IPFilterAction.ALLOW,
      whitelist: config.whitelist || [],
      blacklist: config.blacklist || [],
      rules: config.rules || [],
      trustProxy: config.trustProxy ?? true,
      logActions: config.logActions ?? true,
    };

    if (config.onBlocked) {
      this.config.onBlocked = config.onBlocked;
    }
    if (config.onAllowed) {
      this.config.onAllowed = config.onAllowed;
    }

    this.logger = logger || createDefaultLogger();
    this.compileRules();
  }

  private compileRules(): void {
    // Clear existing rules
    this.compiledRules.clear();
    this.cidrRanges.length = 0;

    // Process whitelist
    for (const ip of this.config.whitelist) {
      this.addCompiledRule({
        ip,
        action: IPFilterAction.ALLOW,
        description: 'Whitelist entry',
        priority: 100,
      });
    }

    // Process blacklist
    for (const ip of this.config.blacklist) {
      this.addCompiledRule({
        ip,
        action: IPFilterAction.BLOCK,
        description: 'Blacklist entry',
        priority: 90,
      });
    }

    // Process custom rules
    for (const rule of this.config.rules) {
      this.addCompiledRule(rule);
    }

    // Sort CIDR ranges by priority (higher priority first)
    this.cidrRanges.sort((a, b) => (b.rule.priority || 50) - (a.rule.priority || 50));

    this.logger.info('IP filter rules compiled', {
      exactRules: this.compiledRules.size,
      cidrRanges: this.cidrRanges.length,
      mode: this.config.mode,
    });
  }

  private addCompiledRule(rule: IPRule): void {
    const normalizedRule = {
      ...rule,
      priority: rule.priority || 50,
    };

    if (this.isCIDR(rule.ip)) {
      // Handle CIDR notation
      try {
        const range = this.parseCIDR(rule.ip);
        this.cidrRanges.push({ range, rule: normalizedRule });
      } catch (error) {
        this.logger.warn(`Invalid CIDR range: ${rule.ip}`, error);
      }
    } else {
      // Handle exact IP addresses
      const normalizedIP = this.normalizeIP(rule.ip);
      if (normalizedIP) {
        this.compiledRules.set(normalizedIP, normalizedRule);
      } else {
        this.logger.warn(`Invalid IP address: ${rule.ip}`);
      }
    }
  }

  private isCIDR(ip: string): boolean {
    return ip.includes('/');
  }

  private parseCIDR(cidr: string): any {
    try {
      if (cidr.includes(':')) {
        // IPv6
        return ipaddr.IPv6.parseCIDR(cidr);
      } else {
        // IPv4
        return ipaddr.IPv4.parseCIDR(cidr);
      }
    } catch (error) {
      throw new Error(`Invalid CIDR notation: ${cidr}`);
    }
  }

  private normalizeIP(ip: string): string | null {
    try {
      if (ip.includes(':')) {
        // IPv6
        const addr = ipaddr.IPv6.parse(ip);
        return addr.toString();
      } else {
        // IPv4
        const addr = ipaddr.IPv4.parse(ip);
        return addr.toString();
      }
    } catch (error) {
      return null;
    }
  }

  private extractClientIP(req: Request): string {
    if (this.config.trustProxy) {
      // Check X-Forwarded-For header
      const xForwardedFor = req.headers['x-forwarded-for'];
      if (xForwardedFor) {
        const ips = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
        if (ips) {
          const firstIP = ips.split(',')[0]?.trim();
          if (firstIP) return firstIP;
        }
      }

      // Check X-Real-IP header
      const xRealIP = req.headers['x-real-ip'];
      if (xRealIP && typeof xRealIP === 'string') {
        return xRealIP.trim();
      }
    }

    // Fall back to connection remote address
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
  }

  private matchesRule(ip: string): IPRule | null {
    const normalizedIP = this.normalizeIP(ip);
    if (!normalizedIP) return null;

    // Check exact matches first
    const exactRule = this.compiledRules.get(normalizedIP);
    if (exactRule) return exactRule;

    // Check CIDR ranges
    for (const { range, rule } of this.cidrRanges) {
      try {
        if (this.ipInRange(normalizedIP, range)) {
          return rule;
        }
      } catch (error) {
        this.logger.debug(`Error checking IP range for ${normalizedIP}`, error);
      }
    }

    return null;
  }

  private ipInRange(ip: string, range: any): boolean {
    try {
      if (ip.includes(':')) {
        // IPv6
        const addr = ipaddr.IPv6.parse(ip);
        return addr.match(range);
      } else {
        // IPv4
        const addr = ipaddr.IPv4.parse(ip);
        return addr.match(range);
      }
    } catch (error) {
      return false;
    }
  }

  checkIP(ip: string): IPFilterResult {
    const matchedRule = this.matchesRule(ip);

    if (matchedRule) {
      const allowed = matchedRule.action === IPFilterAction.ALLOW;
      return {
        allowed,
        action: matchedRule.action,
        ip,
        rule: matchedRule,
        reason: `Matched rule: ${matchedRule.description || 'Custom rule'}`,
      };
    }

    // No rule matched, apply default action based on mode
    let defaultAllowed: boolean;
    let reason: string;

    switch (this.config.mode) {
      case 'whitelist':
        defaultAllowed = false;
        reason = 'IP not in whitelist';
        break;
      case 'blacklist':
        defaultAllowed = true;
        reason = 'IP not in blacklist';
        break;
      case 'hybrid':
      default:
        defaultAllowed = this.config.defaultAction === IPFilterAction.ALLOW;
        reason = `Default action: ${this.config.defaultAction}`;
        break;
    }

    return {
      allowed: defaultAllowed,
      action: defaultAllowed ? IPFilterAction.ALLOW : IPFilterAction.BLOCK,
      ip,
      reason,
    };
  }

  getMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      try {
        const clientIP = this.extractClientIP(req);
        const result = this.checkIP(clientIP);

        if (this.config.logActions) {
          const logLevel = result.allowed ? 'debug' : 'warn';
          this.logger[logLevel](`IP ${result.action}: ${clientIP}`, {
            ip: clientIP,
            action: result.action,
            allowed: result.allowed,
            reason: result.reason,
            userAgent: req.headers['user-agent'],
            path: req.path,
            method: req.method,
          });
        }

        if (result.allowed) {
          if (this.config.onAllowed) {
            this.config.onAllowed(req, clientIP, result.rule);
          }
          next();
        } else {
          if (this.config.onBlocked) {
            this.config.onBlocked(req, clientIP, result.rule);
          }

          // Set security headers
          res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
          });

          res.status(403).json({
            error: 'Access Denied',
            message: 'Your IP address is not allowed to access this resource',
            code: 'IP_BLOCKED',
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        this.logger.error('IP filter middleware error', error);
        next(error);
      }
    };
  }

  addToWhitelist(ip: string, description?: string): void {
    this.config.whitelist.push(ip);
    this.addRule({
      ip,
      action: IPFilterAction.ALLOW,
      description: description || 'Runtime whitelist entry',
      priority: 100,
    });
    this.logger.info(`Added IP to whitelist: ${ip}`);
  }

  addToBlacklist(ip: string, description?: string): void {
    this.config.blacklist.push(ip);
    this.addRule({
      ip,
      action: IPFilterAction.BLOCK,
      description: description || 'Runtime blacklist entry',
      priority: 90,
    });
    this.logger.info(`Added IP to blacklist: ${ip}`);
  }

  removeFromWhitelist(ip: string): boolean {
    const index = this.config.whitelist.indexOf(ip);
    if (index > -1) {
      this.config.whitelist.splice(index, 1);
      this.compileRules();
      this.logger.info(`Removed IP from whitelist: ${ip}`);
      return true;
    }
    return false;
  }

  removeFromBlacklist(ip: string): boolean {
    const index = this.config.blacklist.indexOf(ip);
    if (index > -1) {
      this.config.blacklist.splice(index, 1);
      this.compileRules();
      this.logger.info(`Removed IP from blacklist: ${ip}`);
      return true;
    }
    return false;
  }

  addRule(rule: IPRule): void {
    this.config.rules.push(rule);
    this.compileRules();
    this.logger.info(`Added IP filter rule: ${rule.ip} -> ${rule.action}`);
  }

  removeRule(ip: string): boolean {
    const index = this.config.rules.findIndex(rule => rule.ip === ip);
    if (index > -1) {
      this.config.rules.splice(index, 1);
      this.compileRules();
      this.logger.info(`Removed IP filter rule: ${ip}`);
      return true;
    }
    return false;
  }

  getStats(): {
    mode: string;
    exactRules: number;
    cidrRanges: number;
    whitelistCount: number;
    blacklistCount: number;
    customRules: number;
  } {
    return {
      mode: this.config.mode,
      exactRules: this.compiledRules.size,
      cidrRanges: this.cidrRanges.length,
      whitelistCount: this.config.whitelist.length,
      blacklistCount: this.config.blacklist.length,
      customRules: this.config.rules.length,
    };
  }

  isIPAllowed(ip: string): boolean {
    return this.checkIP(ip).allowed;
  }

  getRules(): IPRule[] {
    return [...this.config.rules];
  }

  getWhitelist(): string[] {
    return [...this.config.whitelist];
  }

  getBlacklist(): string[] {
    return [...this.config.blacklist];
  }

  clear(): void {
    this.config.whitelist.length = 0;
    this.config.blacklist.length = 0;
    this.config.rules.length = 0;
    this.compileRules();
    this.logger.info('IP filter rules cleared');
  }
}
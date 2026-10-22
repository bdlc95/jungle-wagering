import type { LoggerService } from '@nestjs/common';

export class JsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: string, message: unknown, params: unknown[]): void {
    const context = params.findLast(
      (value): value is string => typeof value === 'string',
    );
    const safeMessage =
      level === 'error' || level === 'fatal'
        ? message instanceof Error
          ? message.name
          : 'REDACTED_ERROR'
        : typeof message === 'string'
          ? message
          : message instanceof Error
            ? message.name
            : 'FRAMEWORK_EVENT';
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: 'framework',
        context: context ?? null,
        message: safeMessage,
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
      })}\n`,
    );
  }
}

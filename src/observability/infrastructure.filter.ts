import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { DriverException } from '@mikro-orm/core';
import type { Response } from 'express';

@Catch()
export class InfrastructureFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const statusCode = this.isInfrastructureFailure(exception)
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.INTERNAL_SERVER_ERROR;
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'request_error',
        statusCode,
        errorType: exception instanceof Error ? exception.name : 'Unknown',
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
      })}\n`,
    );
    response.status(statusCode).json({
      statusCode,
      code:
        statusCode === HttpStatus.SERVICE_UNAVAILABLE
          ? 'INFRASTRUCTURE_UNAVAILABLE'
          : 'INTERNAL_ERROR',
    });
  }

  private isInfrastructureFailure(exception: unknown): boolean {
    if (exception instanceof DriverException) return true;
    if (!exception || typeof exception !== 'object') return false;
    const code = 'code' in exception ? exception.code : undefined;
    return (
      typeof code === 'string' &&
      (/^08/.test(code) ||
        /^57P/.test(code) ||
        [
          '55000',
          '53300',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'ENOTFOUND',
        ].includes(code))
    );
  }
}

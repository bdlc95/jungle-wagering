import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { WageringService, type WagerInput } from './wagering.service';
import type { MoneyProps } from '../domain/money';
import { ProviderIdentityGuard } from '../auth/provider-identity.guard';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  constructor(private readonly wagering: WageringService) {}

  @Post()
  open(@Body() body: { playerId: string; initialBalance: MoneyProps }) {
    return this.wagering.openWallet(body?.playerId, body?.initialBalance);
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wagering.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('INVALID_LIMIT');
    return this.wagering.getLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.wagering.reconcile(walletId);
  }
}

@Controller('wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post()
  async submit(
    @Body() body: WagerInput,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.wagering.process(body, key);
    response.status(
      result.status === 'PENDING_REFERENCE'
        ? 202
        : result.status === 'REJECTED'
          ? 422
          : result.idempotentReplay
            ? 200
            : 201,
    );
    return result;
  }

  @Get(':transactionId')
  get(@Param('transactionId') id: string) {
    return this.wagering.getTransaction(id);
  }
}

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class ProviderTransactionsController {
  constructor(private readonly wagering: WageringService) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wagering.getProviderTransaction(
      providerId,
      externalTransactionId,
    );
  }
}

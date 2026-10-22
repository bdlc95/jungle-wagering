import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('UNCANONICALIZABLE_PAYLOAD');
  return serialized;
}

function businessFields(input: WagerPayload, money: Money) {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: money.toJSON(),
    referenceExternalTransactionId:
      input.referenceExternalTransactionId ?? null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashWagerPayload(input: WagerPayload, money: Money): string {
  return sha256(canonicalJson(businessFields(input, money)));
}

export function matchesWagerPayloadHash(
  stored: string,
  input: WagerPayload,
  money: Money,
): boolean {
  const fields = businessFields(input, money);
  // Existing local records used fixed insertion order before canonical sorting was added.
  return (
    stored === sha256(canonicalJson(fields)) ||
    stored === sha256(JSON.stringify(fields))
  );
}

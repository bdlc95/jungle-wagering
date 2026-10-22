import { Injectable } from '@nestjs/common';

type CounterName =
  'duplicate' | 'retry' | 'dlq' | 'lock_conflict' | 'reconciliation_divergence';

@Injectable()
export class MetricsService {
  private readonly counters: Record<CounterName, number> = {
    duplicate: 0,
    retry: 0,
    dlq: 0,
    lock_conflict: 0,
    reconciliation_divergence: 0,
  };
  private readonly statuses = new Map<string, number>();
  private readonly buckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
  ];
  private readonly durations = this.buckets.map(() => 0);
  private durationCount = 0;
  private durationSum = 0;

  increment(name: CounterName): void {
    this.counters[name] += 1;
  }

  transaction(status: string, seconds: number): void {
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
    this.durationCount += 1;
    this.durationSum += seconds;
    this.buckets.forEach((bucket, index) => {
      if (seconds <= bucket) this.durations[index] += 1;
    });
  }

  render(outboxLagSeconds: number, dlqDepth = 0): string {
    const lines = [
      '# TYPE wagering_transactions_total counter',
      ...[...this.statuses].map(
        ([status, count]) =>
          `wagering_transactions_total{status="${status}"} ${count}`,
      ),
      '# TYPE wagering_duplicates_total counter',
      `wagering_duplicates_total ${this.counters.duplicate}`,
      '# TYPE wagering_retries_total counter',
      `wagering_retries_total ${this.counters.retry}`,
      '# TYPE wagering_dlq_total counter',
      `wagering_dlq_total ${this.counters.dlq}`,
      '# TYPE wagering_dlq_messages gauge',
      `wagering_dlq_messages ${dlqDepth}`,
      '# TYPE wagering_lock_conflicts_total counter',
      `wagering_lock_conflicts_total ${this.counters.lock_conflict}`,
      '# TYPE wagering_reconciliation_divergences_total counter',
      `wagering_reconciliation_divergences_total ${this.counters.reconciliation_divergence}`,
      '# TYPE wagering_outbox_lag_seconds gauge',
      `wagering_outbox_lag_seconds ${outboxLagSeconds}`,
      '# TYPE wagering_processing_duration_seconds histogram',
      ...this.buckets.map(
        (bucket, index) =>
          `wagering_processing_duration_seconds_bucket{le="${bucket}"} ${this.durations[index]}`,
      ),
      `wagering_processing_duration_seconds_bucket{le="+Inf"} ${this.durationCount}`,
      `wagering_processing_duration_seconds_sum ${this.durationSum}`,
      `wagering_processing_duration_seconds_count ${this.durationCount}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}

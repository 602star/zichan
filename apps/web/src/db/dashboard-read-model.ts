import { useEffect, useState } from 'react';
import type { DateRange } from '@zichan/core';
import type { DashboardTransactionReadModel } from '@zichan/db';
import { useStore } from './store.js';

interface LoadedDashboardTransactions {
  key: string;
  value: DashboardTransactionReadModel;
}

interface DashboardReadFailure {
  key: string;
  error: Error;
}

/** SQL-backed, transaction-only dashboard slice.
 *
 * The regular dashboard snapshot deliberately omits the unbounded transaction,
 * split and refund collections. This hook refreshes only when one of those
 * aggregates changes (or an account changes its equity classification) and
 * discards results from superseded date ranges.
 */
export function useDashboardTransactionReadModel(
  range: DateRange,
): DashboardTransactionReadModel | null {
  const { store } = useStore();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadedDashboardTransactions | null>(null);
  const [failure, setFailure] = useState<DashboardReadFailure | null>(null);
  const key = `${range.from ?? ''}\0${range.to ?? ''}\0${revision}`;

  useEffect(() => store.subscribe((change) => {
    if (
      change.entityTypes.includes('*')
      || change.entityTypes.some((type) => (
        type === 'transaction'
        || type === 'transaction_split'
        || type === 'refund_allocation'
        || type === 'account'
      ))
    ) {
      setRevision((value) => value + 1);
    }
  }), [store]);

  useEffect(() => {
    let cancelled = false;
    void store.dashboardTransactionReadModel({
      from: range.from,
      to: range.to,
      activityLimit: 6,
    }).then((value) => {
      if (cancelled) return;
      setFailure(null);
      setLoaded({ key, value });
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setFailure({ key, error });
    });
    return () => {
      cancelled = true;
    };
  }, [key, range.from, range.to, store]);

  if (failure?.key === key) throw failure.error;
  return loaded?.key === key ? loaded.value : null;
}

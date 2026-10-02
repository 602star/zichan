/**
 * DCA reporting (§30.1). Turns a series of executions into per-row and cumulative
 * figures: unit cost, running holdings, running cost, and average cost.
 */
import { D, safeDiv, sum } from './decimal.js';
import type { DcaExecution } from './types.js';

export interface DcaReportRow {
  executionId: string;
  date: string;
  investedBase: string | null; // actualBaseCost this execution
  acquiredAmount: string; // finalAmount this execution
  feeBase: string;
  unitCost: string | null; // investedBase / acquiredAmount
  cumulativeAmount: string;
  cumulativeCost: string | null;
  averageCost: string | null; // cumulativeCost / cumulativeAmount
}

export interface DcaReport {
  rows: DcaReportRow[];
  totalInvested: string | null;
  knownInvested: string;
  unknownExecutionCount: number;
  totalAcquired: string;
  totalFees: string;
  averageCost: string | null;
}

export function buildDcaReport(executions: DcaExecution[]): DcaReport {
  const rows: DcaReportRow[] = [];
  const sorted = [...executions]
    .filter((e) => !e.isDeleted)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const first = sorted[0];
  if (first && sorted.some((execution) => execution.planId !== first.planId
    || execution.baseCurrencyAssetId !== first.baseCurrencyAssetId
    || execution.finalAssetId !== first.finalAssetId)) {
    throw new Error('定投报表必须按计划、本位币和目标资产分别汇总');
  }

  let cumAmount = D(0);
  let cumCost = D(0);
  let incomplete = false;

  for (const e of sorted) {
    incomplete ||= e.actualBaseCost === null;
    const invested = D(e.actualBaseCost);
    const acquired = D(e.finalAmount);
    cumAmount = cumAmount.plus(acquired);
    cumCost = cumCost.plus(invested);

    rows.push({
      executionId: e.id,
      date: e.date,
      investedBase: e.actualBaseCost === null ? null : invested.toString(),
      acquiredAmount: acquired.toString(),
      feeBase: D(e.totalFeeInBase).toString(),
      unitCost: e.actualBaseCost === null ? null : safeDiv(invested, acquired).toString(),
      cumulativeAmount: cumAmount.toString(),
      cumulativeCost: incomplete ? null : cumCost.toString(),
      averageCost: incomplete ? null : safeDiv(cumCost, cumAmount).toString(),
    });
  }

  const totalInvested = sum(sorted.map((e) => e.actualBaseCost ?? '0'));
  const totalAcquired = sum(sorted.map((e) => e.finalAmount));
  const totalFees = sum(sorted.map((e) => e.totalFeeInBase));

  return {
    rows,
    totalInvested: incomplete ? null : totalInvested.toString(),
    knownInvested: totalInvested.toString(),
    unknownExecutionCount: sorted.filter((e) => e.actualBaseCost === null).length,
    totalAcquired: totalAcquired.toString(),
    totalFees: totalFees.toString(),
    averageCost: incomplete ? null : safeDiv(totalInvested, totalAcquired).toString(),
  };
}

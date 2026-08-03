/**
 * DCA reporting (§30.1). Turns a series of executions into per-row and cumulative
 * figures: unit cost, running holdings, running cost, and average cost.
 */
import { D, safeDiv, sum } from './decimal.js';
import type { DcaExecution } from './types.js';

export interface DcaReportRow {
  executionId: string;
  date: string;
  investedBase: string; // actualBaseCost this execution
  acquiredAmount: string; // finalAmount this execution
  feeBase: string;
  unitCost: string; // investedBase / acquiredAmount
  cumulativeAmount: string;
  cumulativeCost: string;
  averageCost: string; // cumulativeCost / cumulativeAmount
}

export interface DcaReport {
  rows: DcaReportRow[];
  totalInvested: string;
  totalAcquired: string;
  totalFees: string;
  averageCost: string;
}

export function buildDcaReport(executions: DcaExecution[]): DcaReport {
  const rows: DcaReportRow[] = [];
  const sorted = [...executions]
    .filter((e) => !e.isDeleted)
    .sort((a, b) => a.date.localeCompare(b.date));

  let cumAmount = D(0);
  let cumCost = D(0);

  for (const e of sorted) {
    const invested = D(e.actualBaseCost);
    const acquired = D(e.finalAmount);
    cumAmount = cumAmount.plus(acquired);
    cumCost = cumCost.plus(invested);

    rows.push({
      executionId: e.id,
      date: e.date,
      investedBase: invested.toString(),
      acquiredAmount: acquired.toString(),
      feeBase: D(e.totalFeeInBase).toString(),
      unitCost: safeDiv(invested, acquired).toString(),
      cumulativeAmount: cumAmount.toString(),
      cumulativeCost: cumCost.toString(),
      averageCost: safeDiv(cumCost, cumAmount).toString(),
    });
  }

  const totalInvested = sum(sorted.map((e) => e.actualBaseCost));
  const totalAcquired = sum(sorted.map((e) => e.finalAmount));
  const totalFees = sum(sorted.map((e) => e.totalFeeInBase));

  return {
    rows,
    totalInvested: totalInvested.toString(),
    totalAcquired: totalAcquired.toString(),
    totalFees: totalFees.toString(),
    averageCost: safeDiv(totalInvested, totalAcquired).toString(),
  };
}

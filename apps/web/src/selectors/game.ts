/** Game-season view-model — pure selector over a Snapshot (unit-tested). */
import {
  D, daysBetween, isDateInRange, safeDiv, seasonActivitySummary, sum, gameRecordReportingPostings,
  type DateRange,
  type Decimal, type GameRecord, type GameRecordType, type GameSeason,
} from '@zichan/core';
import type { Snapshot } from '../db/snapshot.js';
import { createReportCurrency } from '../reportCurrency.js';

const STATUS: Record<string, string> = { active: '进行中', ended: '已结束', upcoming: '未开始' };

export interface GameRecordVM {
  raw: GameRecord;
  date: string;
  type: GameRecordType;
  item: string;
  acc: string;
  amt: number;
  nativeAmount: string;
}
export interface GameEfficiencyVM {
  id: string;
  label: string;
  income: number;
  expense: number;
  net: number;
  records: number;
}
export interface GameSeasonVM {
  gameName: string;
  gameTags: string;
  accountNames: string;
  tabs: { id: string; name: string; status: string }[];
  activeId: string;
  season: GameSeason;
  range: string;
  net: number;
  income: string;
  expense: string;
  perHour: string;
  perDay: string;
  hours: string;
  refBalance: string;
  refCurrencyLabel: string;
  reportCurrencyCode: string;
  missingRateAssetCodes: string[];
  byAccount: GameEfficiencyVM[];
  byType: GameEfficiencyVM[];
  records: GameRecordVM[];
  filtered: boolean;
}

export interface GameSeasonFilters {
  dateRange?: DateRange;
  accountId?: string;
  recordType?: GameRecordType | 'all';
}

export function buildGameSeason(snap: Snapshot, gameId: string | null, selectedId: string | null, filters: GameSeasonFilters = {}): GameSeasonVM | null {
  const report = createReportCurrency(snap);
  const games = snap.games.filter((g) => !g.isDeleted);
  const game = games.find((g) => g.id === gameId) ?? games[0];
  const seasons = snap.seasons
    .filter((s) => !s.isDeleted && (!game || s.gameId === game.id))
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  const season = seasons.find((s) => s.id === (selectedId ?? seasons[0]?.id ?? '')) ?? seasons[0];
  if (!season) return null;

  const gAccounts = snap.gameAccounts.filter((a) => !a.isDeleted && (!game || a.gameId === game.id));
  const dateRange = filters.dateRange ?? {};
  const records = snap.gameRecords
    .filter((r) => !r.isDeleted && r.seasonId === season.id)
    .filter((r) => isDateInRange(r.date, dateRange))
    .filter((r) => !filters.accountId || r.gameAccountId === filters.accountId)
    .filter((r) => !filters.recordType || filters.recordType === 'all' || r.recordType === filters.recordType)
    .sort((a, b) => a.date.localeCompare(b.date));
  const summary = seasonActivitySummary(records, season, snap.setting?.asOfDate ?? new Date().toLocaleDateString('en-CA'));
  const filtered = Boolean(dateRange.from || dateRange.to || filters.accountId || (filters.recordType && filters.recordType !== 'all'));
  const filteredDays = dateRange.from && dateRange.to ? Math.max(1, daysBetween(dateRange.from, dateRange.to) + 1) : summary.days;

  const accName = (id?: string) => {
    const a = gAccounts.find((x) => x.id === id);
    return a ? a.accountName.split(' ')[0]! : '—';
  };

  const financial = (record: GameRecord): { income: Decimal; expense: Decimal; net: Decimal } => {
    let income = D(0);
    let expense = D(0);
    for (const posting of gameRecordReportingPostings(record)) {
      const converted = report.toReportAt(posting.amount, posting.assetId, record.date) ?? D(0);
      if (converted.gt(0)) income = income.plus(converted);
      if (converted.lt(0)) expense = expense.plus(converted.abs());
    }
    return { income, expense, net: income.minus(expense) };
  };
  const efficiency = (items: { id: string; label: string; records: GameRecord[] }[]): GameEfficiencyVM[] =>
    items.map((item) => {
      const amounts = item.records.map(financial);
      return {
        id: item.id,
        label: item.label,
        income: sum(amounts.map((row) => row.income)).toNumber(),
        expense: sum(amounts.map((row) => row.expense)).toNumber(),
        net: sum(amounts.map((row) => row.net)).toNumber(),
        records: item.records.length,
      };
    }).sort((a, b) => b.net - a.net);
  const accountItems = gAccounts.map((a) => ({
    id: a.id,
    label: a.accountName,
    records: records.filter((r) => r.gameAccountId === a.id),
  }));
  const byTypeRaw = [...new Set(records.map((r) => r.recordType))].map((type) => ({
    id: type,
    label: type,
    records: records.filter((r) => r.recordType === type),
  }));
  const totals = records.map(financial);
  const income = sum(totals.map((row) => row.income));
  const expense = sum(totals.map((row) => row.expense));
  const net = income.minus(expense);
  const hours = D(summary.hours);
  const refCurrencyNames = [...new Set(records.map((record) => record.gameCurrencyName?.trim()).filter(Boolean))];

  return {
    gameName: game?.name ?? '游戏',
    gameTags: `${game?.platform ?? ''} · ${game?.serverName ?? ''}`.replace(/^ · | · $/g, ''),
    accountNames: gAccounts.map((a) => a.accountName).join(' / ') || '—',
    tabs: seasons.map((s) => ({ id: s.id, name: s.name, status: STATUS[s.status] ?? '' })),
    activeId: season.id,
    season,
    range: `${season.startDate ?? ''} ~ ${season.endDate ?? '至今'} · ${summary.days} 天`,
    net: net.toNumber(),
    income: income.toString(),
    expense: expense.toString(),
    perHour: safeDiv(net, hours).toString(),
    perDay: safeDiv(net, filteredDays).toString(),
    hours: summary.hours,
    refBalance: summary.referenceBalance,
    refCurrencyLabel: refCurrencyNames.length === 1 ? refCurrencyNames[0]! : '游戏币',
    reportCurrencyCode: report.code,
    missingRateAssetCodes: report.missingCodes(),
    byAccount: efficiency(accountItems),
    byType: efficiency(byTypeRaw),
    records: records.map((r) => ({
      raw: r,
      date: r.date, type: r.recordType, item: r.note ?? '',
      acc: accName(r.gameAccountId),
      amt: financial(r).net.toNumber(),
      nativeAmount: r.settlementAssetId && r.settlementAmount
        ? report.formatNative(r.settlementAmount, r.settlementAssetId)
        : '—',
    })),
    filtered,
  };
}

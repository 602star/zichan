import { D, round } from './decimal.js';
import { isValidDay } from './dates.js';
import type { FixedAssetEvent } from './types.js';

export type FixedOperatingMode = 'fee' | 'quantity' | 'estimate' | 'start' | 'reading' | 'pause' | 'resume' | 'reset';
export interface FixedOperatingCost {
  version: 1;
  mode: FixedOperatingMode;
  name: string;
  unit: string;
  source: 'manual' | 'device' | 'meter' | 'receipt';
  meterId?: string;
  sequence?: number;
  previousEventId?: string;
  previousReading?: string;
  reading?: string;
  quantity?: string;
  unitPrice?: string;
  serviceFee?: string;
  /** An actual bill replaces quantity × price + service fee; it is not added to it. */
  billedAmount?: string;
  costKnown?: boolean;
  fromDate?: string;
  toDate?: string;
  gapFromDate?: string;
  gapToDate?: string;
}

const modes = new Set<FixedOperatingMode>(['fee', 'quantity', 'estimate', 'start', 'reading', 'pause', 'resume', 'reset']);
export const isFixedMeterMode = (mode: FixedOperatingMode): boolean => ['start', 'reading', 'pause', 'resume', 'reset'].includes(mode);
export const FIXED_OPERATING_LABELS: Record<FixedOperatingMode, string> = {
  fee: '直接记费用', quantity: '按用量记录', estimate: '估算参考费用', start: '开始计量', reading: '抄表计费',
  pause: '暂停计量', resume: '恢复计量', reset: '换表／读数归零',
};

export function parseFixedOperatingCost(json: string | undefined): FixedOperatingCost | undefined {
  if (!json) return undefined;
  const value = JSON.parse(json) as FixedOperatingCost;
  if (!value || value.version !== 1 || !modes.has(value.mode) || !value.name?.trim() || !value.unit?.trim()
    || !['manual', 'device', 'meter', 'receipt'].includes(value.source)) throw new Error('使用费用记录格式无效');
  for (const field of ['reading', 'quantity', 'unitPrice', 'serviceFee', 'billedAmount'] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field]!.trim()
      || !D(value[field]).isFinite() || D(value[field]).lt(0))) throw new Error('读数、用量、单价和费用必须为非负数');
  }
  if (isFixedMeterMode(value.mode) && (!value.meterId?.trim() || !Number.isSafeInteger(value.sequence) || value.sequence! < 1)) {
    throw new Error('计量记录缺少计量项目或顺序');
  }
  return value;
}

export interface FixedMeterState {
  id: string;
  name: string;
  unit: string;
  active: boolean;
  last: FixedAssetEvent;
  reading: string;
  quantity: string;
  unpriced: number;
}

export function fixedMeterStates(events: FixedAssetEvent[]): FixedMeterState[] {
  const states = new Map<string, FixedMeterState>();
  const rows = events.filter((event) => !event.isDeleted && event.type === 'operating_cost')
    .map((event) => ({ event, data: parseFixedOperatingCost(event.operatingCostJson)! }))
    .filter(({ data }) => data && isFixedMeterMode(data.mode))
    .sort((a, b) => a.data.sequence! - b.data.sequence!);
  for (const { event, data } of rows) {
    const previous = states.get(data.meterId!);
    states.set(data.meterId!, { id: data.meterId!, name: data.name, unit: data.unit, active: data.mode !== 'pause', last: event,
      reading: data.reading ?? previous?.reading ?? '0', quantity: D(previous?.quantity).plus(data.quantity ?? '0').toString(),
      unpriced: (previous?.unpriced ?? 0) + (data.quantity && D(data.quantity).gt(0) && !data.costKnown ? 1 : 0) });
  }
  return [...states.values()];
}

/** Freeze the billed segment. Pauses never bridge into the next baseline. */
export function prepareFixedOperatingEvent(event: FixedAssetEvent, events: FixedAssetEvent[], decimals = 2): FixedAssetEvent {
  const raw = JSON.parse(event.operatingCostJson || '{}') as FixedOperatingCost;
  const others = events.filter((row) => !row.isDeleted && row.fixedAssetId === event.fixedAssetId && row.id !== event.id);
  const previousVersion = events.find((row) => row.id === event.id);
  if (previousVersion && previousVersion.type !== 'operating_cost') throw new Error('不能将其他生命周期事件改为使用费用');
  const previousData = previousVersion ? parseFixedOperatingCost(previousVersion.operatingCostJson) : undefined;
  if (previousData && (previousData.meterId !== raw.meterId || previousData.mode !== raw.mode)) throw new Error('已有记录不能改变计量项目或记录方式，请删除后重新登记');
  const data: FixedOperatingCost = { ...raw, version: 1, name: raw.name?.trim(), unit: raw.unit?.trim(),
    sequence: previousData?.sequence ?? events.filter((row) => row.fixedAssetId === event.fixedAssetId)
      .reduce((latest, row) => Math.max(latest, parseFixedOperatingCost(row.operatingCostJson)?.sequence ?? 0), 0) + 1 };
  parseFixedOperatingCost(JSON.stringify(data));
  if (others.some((row) => parseFixedOperatingCost(row.operatingCostJson)?.sequence === data.sequence)) throw new Error('使用费用记录顺序冲突，请刷新并检查计量历史');
  if (!isValidDay(event.date)) throw new Error('请选择有效的记录日期');
  if (isFixedMeterMode(data.mode)) {
    const later = others.some((row) => {
      const record = parseFixedOperatingCost(row.operatingCostJson);
      return record && record.meterId === data.meterId && record.sequence! > data.sequence!;
    });
    if (later && previousData && (event.date !== previousVersion!.date || data.name !== previousData.name
      || data.unit !== previousData.unit || data.reading !== previousData.reading)) throw new Error('后续读数依赖这条记录，历史记录只能补充单价、金额或备注；改读数请从最新一条开始');
    const state = fixedMeterStates(others.filter((row) => (parseFixedOperatingCost(row.operatingCostJson)?.sequence ?? 0) < data.sequence!)).find((row) => row.id === data.meterId);
    if (!previousVersion && raw.previousEventId !== undefined && (raw.previousEventId !== state?.last.id || raw.previousReading !== state?.reading)) throw new Error('计量记录已在其他窗口变更，请刷新后核对本段用量再保存');
    data.previousEventId = state?.last.id;
    data.previousReading = state?.reading;
    if (state && event.date < state.last.date) throw new Error('计量日期不能早于上一条记录；同一天可按先后顺序登记');
    if (state && (state.name !== data.name || state.unit !== data.unit)) throw new Error('同一计量项目的名称和单位必须保持一致');
    if (data.mode === 'start' ? !!state : !state) throw new Error(data.mode === 'start' ? '该计量项目已经开始，请选择抄表或恢复' : '请先登记起始读数');
    if (data.mode === 'resume' && state?.active) throw new Error('当前仍在计量，请先暂停');
    if (['reading', 'pause'].includes(data.mode) && !state?.active) throw new Error('当前已暂停，请设置新起点后恢复计量');
    if (data.mode !== 'pause' && data.reading === undefined) throw new Error('请填写累计读数');
    if (['start', 'resume', 'reset'].includes(data.mode)) {
      data.quantity = undefined;
      data.unitPrice = undefined;
      data.billedAmount = undefined;
      data.serviceFee = undefined;
      data.fromDate = undefined;
      data.toDate = undefined;
      data.gapFromDate = data.mode === 'resume' ? parseFixedOperatingCost(state!.last.operatingCostJson)?.gapFromDate ?? state!.last.date
        : data.mode === 'reset' ? state!.last.date : undefined;
      data.gapToDate = data.mode === 'start' ? undefined : event.date;
    } else if (data.reading !== undefined) {
      const delta = D(data.reading).minus(state!.reading);
      if (delta.lt(0)) throw new Error('读数小于上次读数，请使用“换表／读数归零”设置新起点');
      data.quantity = delta.toString();
      data.fromDate = state!.last.date;
      data.toDate = event.date;
      data.gapFromDate = data.mode === 'pause' ? event.date : undefined;
      data.gapToDate = undefined;
    } else {
      // A pause without a closing reading records a coverage gap, not zero use.
      data.quantity = undefined;
      data.unitPrice = undefined;
      data.billedAmount = undefined;
      data.serviceFee = undefined;
      data.fromDate = undefined;
      data.toDate = undefined;
      data.gapFromDate = state!.last.date;
      data.gapToDate = undefined;
    }
  } else if (data.meterId) throw new Error('直接费用、单次用量和估算不能关联累计电表，避免重复计费');
  if (['quantity', 'estimate'].includes(data.mode) && data.quantity === undefined) throw new Error('请填写用量');
  if (data.mode === 'fee' && data.billedAmount === undefined) throw new Error('请填写实际费用');
  if (data.mode === 'estimate') {
    if (!isValidDay(data.fromDate ?? '') || !isValidDay(data.toDate ?? '') || data.fromDate! > data.toDate!) throw new Error('请填写有效的估算起止日期');
    const overlap = others.some((row) => {
      const other = parseFixedOperatingCost(row.operatingCostJson);
      return other?.name === data.name && other.unit === data.unit && other.fromDate && other.toDate
        && data.fromDate! <= other.toDate && data.toDate! >= other.fromDate;
    });
    if (overlap) throw new Error('该费用项目在此期间已有计量或估算，请先处理重叠记录');
  } else if (data.fromDate && data.toDate && others.some((row) => {
    const other = parseFixedOperatingCost(row.operatingCostJson);
    return other?.mode === 'estimate' && other.name === data.name && other.unit === data.unit
      && data.fromDate! <= other.toDate! && data.toDate! >= other.fromDate!;
  })) throw new Error('本段与估算期间重叠，请先删除对应估算');
  data.costKnown = data.billedAmount !== undefined || (data.quantity !== undefined && data.unitPrice !== undefined);
  if (data.mode === 'estimate' && !data.costKnown) throw new Error('估算需要填写单价或估算金额');
  if (data.serviceFee !== undefined && !data.costKnown && D(data.serviceFee).gt(0)) throw new Error('请先填写单价或实际总费用，服务费不能单独代替总费用');
  const amount = data.costKnown ? data.billedAmount ?? D(data.quantity).mul(data.unitPrice!).plus(data.serviceFee ?? '0').toString() : '0';
  return { ...event, amountBase: round(amount, decimals), operatingCostJson: JSON.stringify(data) };
}

export function assertFixedOperatingLatest(event: FixedAssetEvent, events: FixedAssetEvent[]): void {
  const data = parseFixedOperatingCost(event.operatingCostJson);
  if (data && isFixedMeterMode(data.mode) && events.some((row) => !row.isDeleted && row.fixedAssetId === event.fixedAssetId
    && row.id !== event.id && parseFixedOperatingCost(row.operatingCostJson)?.meterId === data.meterId
    && parseFixedOperatingCost(row.operatingCostJson)!.sequence! > data.sequence!)) {
    throw new Error('后续读数依赖这条记录，请从最新一条开始修改或删除');
  }
}

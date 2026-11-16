import { D, FIXED_OPERATING_LABELS, fixedMeterStates, isFixedMeterMode, parseFixedOperatingCost, prepareFixedOperatingEvent, todayIn, type FixedOperatingCost, type FixedOperatingMode } from '@zichan/core';
import { fixedEventForm, type FixedAssetEventFormValue } from './forms.js';
import type { Snapshot } from './db/snapshot.js';
import type { EntityFormSpec, FieldDef } from './ui/EntityFormModal.js';

export interface FixedOperatingPreset { mode?: FixedOperatingMode; meterId?: string; service?: boolean; name?: string }
type Values = Record<string, string>;
const optional = (value: string | undefined) => value?.trim() || undefined;

export function fixedOperatingCostForm(snap: Snapshot, assetId: string, preset: FixedOperatingPreset = {}, existing?: FixedAssetEventFormValue): EntityFormSpec<FixedAssetEventFormValue> {
  const legacy = fixedEventForm(snap, assetId);
  const events = snap.fixedEvents.filter((row) => row.fixedAssetId === assetId);
  const meters = fixedMeterStates(events);
  const old = parseFixedOperatingCost(existing?.operatingCostJson);
  const selected = meters.find((row) => row.id === (old?.meterId ?? preset.meterId));
  const asset = snap.fixedAssets.find((row) => row.id === assetId)!;
  const currency = snap.assets.find((row) => row.id === asset.baseCurrencyAssetId);
  const meterMode = (v: Values) => isFixedMeterMode(v.mode as FixedOperatingMode);
  const billing = (v: Values) => ['fee', 'quantity', 'estimate', 'reading', 'pause'].includes(v.mode ?? '');
  const actual = (v: Values) => billing(v) && v.mode !== 'estimate' && (!!optional(v.billedAmount) || (!!optional(v.unitPrice) && (v.mode !== 'pause' || !!optional(v.reading))));
  const taskFields = (fields: FieldDef[]): FieldDef[] => fields.map((field) => ({ ...field,
    taskGroup: ['date', 'fromDate', 'toDate', 'serviceFrom', 'serviceTo'].includes(field.key) ? '日期与期间'
      : ['unitPrice', 'serviceFee', 'billedAmount'].includes(field.key) || field.key.startsWith('cashflow') ? '费用与资金'
        : field.key === 'note' ? '备注' : '记录方式与用量',
  }));
  const makeEvent = (v: Values, current = existing): FixedAssetEventFormValue => {
    const event = legacy.fromValues({ ...v, type: 'repair', amountBase: '0' }, current);
    const data: FixedOperatingCost = {
      version: 1, mode: v.mode as FixedOperatingMode, name: v.name ?? '', unit: v.unit ?? '',
      source: v.source as FixedOperatingCost['source'], meterId: meterMode(v) ? (v.mode === 'start' ? old?.meterId ?? event.id : v.meterId) : undefined,
      reading: meterMode(v) ? optional(v.reading) : undefined,
      quantity: ['quantity', 'estimate'].includes(v.mode ?? '') ? optional(v.quantity) : undefined,
      unitPrice: billing(v) ? optional(v.unitPrice) : undefined,
      billedAmount: billing(v) ? optional(v.billedAmount) : undefined,
      serviceFee: billing(v) ? optional(v.serviceFee) : undefined,
      fromDate: v.mode === 'estimate' ? v.fromDate : undefined, toDate: v.mode === 'estimate' ? v.toDate : undefined,
      service: v.mode === 'fee' && v.service === 'true' ? { provider: optional(v.provider), fromDate: optional(v.serviceFrom), toDate: optional(v.serviceTo) } : undefined,
    };
    return prepareFixedOperatingEvent({ ...event, type: 'operating_cost', operatingCostJson: JSON.stringify(data),
      cashflowMode: actual(v) ? event.cashflowMode : 'record_only' }, events, currency?.decimals ?? 2);
  };
  return {
    title: '使用费用记录', draftKey: `fixed-operating:${assetId}:${preset.mode ?? 'new'}:${preset.meterId ?? ''}`, modalWidth: 760,
    progressiveFields: false,
    summary: (v) => {
      const message = v.mode === 'start' ? '填写起点即可，起点之前的读数不收费。'
        : v.mode === 'pause' ? '暂停后设备可能仍在耗电。可填末次读数结清已测部分；留空表示末段未计量。'
          : v.mode === 'resume' ? '用当前读数重新设起点，暂停期间不跨段计费。空档可另记实际账单或估算。'
            : v.mode === 'reset' ? '新读数作为起点。请先抄旧表结清，未结清部分保留为未计量。'
              : v.mode === 'estimate' ? '只作参考，不计入净投入、不生成资金流水。填此期间合计的估算用量。'
                : v.mode === 'fee' && v.service === 'true' ? '记录本次已支付的软件、云服务、保险或延保费用，可填写服务期间。全部金额计入付款日的净投入；续费时再登记或关联对应账单。'
                  : '用量、单价及服务费计算本次费用；实际总费用填写后以该金额为准。单记度数可留空费用，稍后补价。';
      try {
        const event = makeEvent(v);
        const data = parseFixedOperatingCost(event.operatingCostJson)!;
        return `${message}${data.quantity !== undefined ? ` 本段 ${data.quantity} ${data.unit}。` : ''}${data.costKnown ? ` 本次${v.mode === 'estimate' ? '参考' : '登记'} ${event.amountBase} ${currency?.code ?? ''}。` : ''}`;
      } catch { return message; }
    },
    onFieldChange: (v, key) => {
      const meter = meters.find((row) => row.id === v.meterId);
      if (key === 'meterId' && meter) return { ...v, name: meter.name, unit: meter.unit, reading: '', unitPrice: '', billedAmount: '', serviceFee: '' };
      if (key === 'mode') return { ...v, service: v.mode === 'fee' ? v.service ?? 'false' : 'false', cashflowMode: 'record_only', reading: '', quantity: '', billedAmount: '', serviceFee: '', unitPrice: '' };
      if (key === 'service' && v.service === 'true') return { ...v, unit: '期', source: 'receipt', name: v.name === '电费' ? '云服务订阅' : v.name ?? '云服务订阅' };
      return v;
    },
    fields: taskFields([
      { key: 'mode', label: '记录方式', type: 'select', required: true, defaultValue: preset.mode ?? 'quantity', options: Object.entries(FIXED_OPERATING_LABELS)
        .filter(([mode]) => !old || mode === old.mode).map(([value, label]) => ({ value, label })) },
      { key: 'meterId', label: '计量项目', type: 'select', required: true, defaultValue: preset.meterId, allowEmpty: true,
        options: meters.filter((row) => !old || row.id === old.meterId).map((row) => ({ value: row.id, label: `${row.name} · ${row.active ? '计量中' : '已暂停'} · ${row.reading} ${row.unit}` })), visibleWhen: (v) => meterMode(v) && v.mode !== 'start' },
      { key: 'service', label: '费用内容', type: 'select', defaultValue: preset.service ? 'true' : 'false', visibleWhen: (v) => v.mode === 'fee', options: [{ value: 'false', label: '一般费用' }, { value: 'true', label: '订阅与服务（软件／云服务／保险延保）' }] },
      { key: 'name', label: '费用项目', type: 'text', defaultValue: preset.name ?? (preset.service ? '云服务订阅' : selected?.name ?? '电费'), required: true, half: true, placeholder: '电费 / 公共充电 / 监控云存储 / 软件订阅' },
      { key: 'unit', label: '用量单位', type: 'text', defaultValue: preset.service ? '期' : selected?.unit ?? 'kWh', required: true, half: true, visibleWhen: (v) => v.mode !== 'fee', hint: '电量填 kWh（度），也可记录升、立方米等。' },
      { key: 'provider', label: '服务商', type: 'text', half: true, visibleWhen: (v) => v.mode === 'fee' && v.service === 'true' },
      { key: 'serviceFrom', label: '服务开始日期', type: 'date', half: true, visibleWhen: (v) => v.mode === 'fee' && v.service === 'true', hint: '服务期间可不填；填写时请同时填写起止日期。' },
      { key: 'serviceTo', label: '服务截止日期', type: 'date', half: true, visibleWhen: (v) => v.mode === 'fee' && v.service === 'true' },
      { key: 'date', label: '记录日期', type: 'date', defaultValue: todayIn(snap.setting?.timezone), required: true, half: true },
      { key: 'source', label: '数据来源', type: 'select', defaultValue: 'manual', half: true, options: [
        { value: 'manual', label: '手动记录' }, { value: 'device', label: '设备自带统计' }, { value: 'meter', label: '外接电能表' }, { value: 'receipt', label: '账单／订单' },
      ] },
      { key: 'reading', label: '当前累计读数', type: 'number', half: true, required: false, visibleWhen: meterMode,
        hint: '填写电能表的累计电量（kWh），不是瞬时功率（W）；暂停时可留空。' },
      { key: 'quantity', label: '本次用量', type: 'number', half: true, required: true, visibleWhen: (v) => ['quantity', 'estimate'].includes(v.mode ?? '') },
      { key: 'fromDate', label: '估算开始日期', type: 'date', half: true, required: true, visibleWhen: (v) => v.mode === 'estimate' },
      { key: 'toDate', label: '估算结束日期', type: 'date', half: true, required: true, visibleWhen: (v) => v.mode === 'estimate' },
      { key: 'unitPrice', label: '本段单价', type: 'number', half: true, visibleWhen: (v) => billing(v) && v.mode !== 'fee', hint: '使用这段用量对应的单价。电价变化时先抄表分段，每段价格独立保存。' },
      { key: 'serviceFee', label: '本次服务费', type: 'number', half: true, visibleWhen: (v) => billing(v) && v.mode !== 'fee' },
      { key: 'billedAmount', label: '实际总费用／金额', type: 'number', half: true, visibleWhen: billing,
        hint: '填充电订单或账单的总金额（含服务费）。填写后替代计算金额；估算模式填写参考金额。' },
      ...legacy.fields.filter((field) => field.key.startsWith('cashflow') && field.key !== 'cashflowReportingTreatment').map((field) => ({ ...field,
        visibleWhen: (v: Values) => actual(v) && (!field.visibleWhen || field.visibleWhen({ ...v, type: 'repair' })),
      })),
      { key: 'note', label: '备注', type: 'text', placeholder: '计量范围、充电地点或未计量原因' },
    ]),
    toValues: (event) => {
      const data = parseFixedOperatingCost(event.operatingCostJson)!;
      return { ...legacy.toValues(event), mode: data.mode, name: data.name, unit: data.unit, source: data.source,
        service: data.service ? 'true' : 'false', provider: data.service?.provider ?? '', serviceFrom: data.service?.fromDate ?? '', serviceTo: data.service?.toDate ?? '',
        meterId: data.meterId ?? '', reading: data.reading ?? '', quantity: data.quantity ?? '', unitPrice: data.unitPrice ?? '',
        serviceFee: data.serviceFee ?? '', billedAmount: data.billedAmount ?? '', fromDate: data.fromDate ?? '', toDate: data.toDate ?? '' };
    },
    fromValues: makeEvent,
    validate: (v) => {
      try {
        const event = makeEvent(v);
        const data = parseFixedOperatingCost(event.operatingCostJson)!;
        if (v.cashflowMode !== 'record_only' && actual(v) && !D(event.amountBase).gt(0)) return '关联资金时金额必须大于 0';
        if (!data.costKnown && v.mode === 'fee') return '请填写费用';
        return legacy.validate?.({ ...v, type: actual(v) ? 'repair' : 'activate', amountBase: event.amountBase });
      } catch (error) { return error instanceof Error ? error.message : '请检查使用费用记录'; }
    },
  };
}

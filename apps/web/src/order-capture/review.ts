import { D, isValidDay } from '@zichan/core';
import { timeMinutes } from '../category-defaults.js';
import type { ParsedOrder, ReviewedOrderFields } from './types.js';

export function reviewedOrderFields(order: ParsedOrder, selection: { amount?: string; date?: string; time?: string; confirmed: boolean }): ReviewedOrderFields {
  if (!selection.confirmed || !['paid', 'unknown'].includes(order.paymentState)) throw new Error('请先核对付款状态、币种和字段。');
  const result: ReviewedOrderFields = {};
  if (selection.amount !== undefined) {
    if (!order.fields.amount.candidates.some((row) => row.value === selection.amount)) throw new Error('金额候选已失效，请重新识别。');
    const amount = D(selection.amount);
    if (!amount.isFinite() || !amount.gt(0)) throw new Error('识别金额无效。');
    result.amount = amount.toString();
  }
  if (selection.date !== undefined) {
    if (!isValidDay(selection.date) || !order.fields.paymentDate.candidates.some((row) => row.value === selection.date)) throw new Error('付款日期候选无效。');
    result.date = selection.date;
    // A date-only source must not inherit the form's current clock time.
    result.time = '';
    if (selection.time !== undefined) {
      if (timeMinutes(selection.time) === null || !order.fields.paymentTime.candidates.some((row) => row.value === selection.time)) throw new Error('付款时间候选无效。');
      result.time = selection.time;
    }
  }
  return result;
}

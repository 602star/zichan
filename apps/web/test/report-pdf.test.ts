import { describe, expect, it } from 'vitest';
import { paginateReportRows } from '../src/report-pdf.js';

describe('PDF report pagination', () => {
  it('keeps every row in order and uses a smaller first page', () => {
    const rows = Array.from({ length: 11 }, (_, index) => index + 1);
    expect(paginateReportRows(rows, 3, 4)).toEqual([
      [1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
    ]);
  });

  it('still creates one page for an empty report', () => {
    expect(paginateReportRows([], 3, 4)).toEqual([[]]);
  });
});

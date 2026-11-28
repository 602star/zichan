import { describe, expect, it } from 'vitest';
import { buildPdfDocument, paginateReportRows, PDF_PIXEL_HEIGHT, PDF_PIXEL_WIDTH } from '../src/report-pdf.js';

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

  it('builds 300-DPI lossless FlateDecode PDF image objects and supports DCTDecode fallback', () => {
    expect(PDF_PIXEL_WIDTH).toBe(2480);
    expect(PDF_PIXEL_HEIGHT).toBe(3508);

    const lossless = new TextDecoder('latin1').decode(buildPdfDocument([
      { data: new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]), width: PDF_PIXEL_WIDTH, height: PDF_PIXEL_HEIGHT, filter: 'FlateDecode' },
    ]));
    expect(lossless).toContain('/Width 2480 /Height 3508');
    expect(lossless).toContain('/Filter /FlateDecode');
    expect(lossless).toContain('%%EOF');

    const fallback = new TextDecoder('latin1').decode(buildPdfDocument([
      { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: PDF_PIXEL_WIDTH, height: PDF_PIXEL_HEIGHT, filter: 'DCTDecode' },
    ]));
    expect(fallback).toContain('/Filter /DCTDecode');
  });
});

import type { Table } from './selectors/reports.js';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const MARGIN = 60;
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 50;
const FIRST_TABLE_TOP = 212;
const NEXT_TABLE_TOP = 128;
const encoder = new TextEncoder();

// 大福帳 · 纸本清册 palette — matches DESIGN.md light archival paper, sumi ink,
// vermilion seal, income indigo, expense crimson, and warning ochre.
const PDF_PAPER = '#faf8f3';
const PDF_SURFACE_ALT = '#f4f1e9';
const PDF_INK = '#211d18';
const PDF_INK_SECONDARY = '#565048';
const PDF_INK_TERTIARY = '#615b52';
const PDF_RULE = '#d2cbbd';
const PDF_RULE_STRONG = '#3a342c';
const PDF_VERMILION = '#b63226';
const PDF_VERMILION_SOFT = '#f2ded9';
const PDF_POSITIVE = '#2b6079';
const PDF_NEGATIVE = '#a72f24';
const PDF_WARNING = '#76531c';

const FONT_TEXT = '"LXGW WenKai Screen", "PingFang SC", "Microsoft YaHei", sans-serif';
const FONT_NUM = '"DIN Alternate", "Bahnschrift", "Segoe UI", "Helvetica Neue", sans-serif';

export interface ReportPdfInput {
  title: string;
  range: string;
  table: Table;
  generatedAt?: Date;
}

export function paginateReportRows<T>(
  rows: T[],
  firstCapacity = 30,
  nextCapacity = 32,
): T[][] {
  const pages: T[][] = [];
  let offset = 0;
  let capacity = Math.max(1, firstCapacity);
  while (offset < rows.length || pages.length === 0) {
    pages.push(rows.slice(offset, offset + capacity));
    offset += capacity;
    capacity = Math.max(1, nextCapacity);
  }
  return pages;
}

function fitText(context: CanvasRenderingContext2D, value: string, width: number): string {
  const clean = value.replace(/\s+/g, ' ').trim() || '—';
  if (context.measureText(clean).width <= width) return clean;
  let left = 0;
  let right = clean.length;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (context.measureText(`${clean.slice(0, middle)}…`).width <= width) left = middle;
    else right = middle - 1;
  }
  return `${clean.slice(0, Math.max(0, left))}…`;
}

function looksNumeric(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return false;
  return /^[+\-−¥$€£]?\s*\d[\d,.\s]*(%|(?:\s*[A-Z]{2,6}))?$/.test(trimmed);
}

function columnWidths(table: Table): number[] {
  const available = PAGE_WIDTH - MARGIN * 2;
  const scores = table.headers.map((header, index) => {
    const longest = Math.max(
      header.length,
      ...table.rows.slice(0, 100).map((row) => row[index]?.v.length ?? 0),
    );
    return Math.min(24, Math.max(6, longest));
  });
  const total = scores.reduce((sum, score) => sum + score, 0);
  return scores.map((score) => available * score / total);
}

function drawDoubleRule(context: CanvasRenderingContext2D, left: number, right: number, y: number): void {
  context.strokeStyle = PDF_RULE_STRONG;
  context.lineWidth = 2.2;
  context.beginPath();
  context.moveTo(left, y);
  context.lineTo(right, y);
  context.stroke();

  context.strokeStyle = PDF_RULE;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left, y + 4.5);
  context.lineTo(right, y + 4.5);
  context.stroke();
}

function drawFolioSeal(context: CanvasRenderingContext2D, rightX: number, topY: number): void {
  const width = 104;
  const height = 34;
  const x = rightX - width;
  context.save();
  context.translate(x + width / 2, topY + height / 2);
  context.rotate(-0.025);
  context.fillStyle = PDF_VERMILION_SOFT;
  context.fillRect(-width / 2, -height / 2, width, height);
  context.strokeStyle = PDF_VERMILION;
  context.lineWidth = 2;
  context.strokeRect(-width / 2, -height / 2, width, height);
  context.lineWidth = 0.8;
  context.strokeRect(-width / 2 + 3.5, -height / 2 + 3.5, width - 7, height - 7);
  context.fillStyle = PDF_VERMILION;
  context.font = `700 17px ${FONT_TEXT}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('有本清册', 0, 1);
  context.restore();
}

function drawTable(
  context: CanvasRenderingContext2D,
  table: Table,
  rows: Table['rows'],
  top: number,
  widths: number[],
): void {
  const tableWidth = PAGE_WIDTH - MARGIN * 2;
  const numericColumn = table.headers.map((_, colIdx) => {
    const sample = rows.slice(0, 20).map((row) => row[colIdx]?.v ?? '').filter((v) => v && v !== '—');
    return sample.length > 0 && sample.every(looksNumeric);
  });

  // Open ledger header: light tinted band framed by double hairline ink rules.
  context.fillStyle = PDF_SURFACE_ALT;
  context.fillRect(MARGIN, top, tableWidth, HEADER_HEIGHT);
  drawDoubleRule(context, MARGIN, MARGIN + tableWidth, top);

  context.textBaseline = 'middle';
  context.font = `700 18px ${FONT_TEXT}`;
  context.fillStyle = PDF_INK;
  let x = MARGIN;
  for (let index = 0; index < table.headers.length; index += 1) {
    const width = widths[index]!;
    const alignRight = numericColumn[index];
    context.textAlign = alignRight ? 'right' : 'left';
    const textX = alignRight ? x + width - 12 : x + 12;
    context.fillText(fitText(context, table.headers[index]!, width - 24), textX, top + HEADER_HEIGHT / 2 + 2);
    x += width;
  }

  context.strokeStyle = PDF_RULE_STRONG;
  context.lineWidth = 1.4;
  context.beginPath();
  context.moveTo(MARGIN, top + HEADER_HEIGHT);
  context.lineTo(MARGIN + tableWidth, top + HEADER_HEIGHT);
  context.stroke();

  // Ledger rows: open paper surface separated by crisp horizontal ink hairlines.
  rows.forEach((row, rowIndex) => {
    const y = top + HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
    let cellX = MARGIN;
    row.forEach((cell, columnIndex) => {
      const width = widths[columnIndex]!;
      const isNum = numericColumn[columnIndex] || looksNumeric(cell.v);
      context.fillStyle = cell.color?.includes('positive') ? PDF_POSITIVE
        : cell.color?.includes('negative') ? PDF_NEGATIVE
          : cell.color?.includes('warning') ? PDF_WARNING
            : PDF_INK;
      context.font = `${cell.bold ? '700' : '400'} 17px ${isNum ? FONT_NUM : FONT_TEXT}`;
      context.textAlign = isNum ? 'right' : 'left';
      const textX = isNum ? cellX + width - 12 : cellX + 12;
      context.fillText(fitText(context, cell.v, width - 24), textX, y + ROW_HEIGHT / 2);
      cellX += width;
    });

    context.strokeStyle = PDF_RULE;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(MARGIN, y + ROW_HEIGHT);
    context.lineTo(MARGIN + tableWidth, y + ROW_HEIGHT);
    context.stroke();
  });

  // Closing bottom rule.
  const bottomY = top + HEADER_HEIGHT + rows.length * ROW_HEIGHT;
  context.strokeStyle = PDF_RULE_STRONG;
  context.lineWidth = 1.8;
  context.beginPath();
  context.moveTo(MARGIN, bottomY);
  context.lineTo(MARGIN + tableWidth, bottomY);
  context.stroke();
  context.textAlign = 'left';
}

function jpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  const encoded = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  if (!encoded) throw new Error('PDF 页面图像编码失败');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function renderPages(input: ReportPdfInput): Uint8Array[] {
  const generatedAt = input.generatedAt ?? new Date();
  const firstCapacity = Math.max(1, Math.floor((PAGE_HEIGHT - FIRST_TABLE_TOP - HEADER_HEIGHT - 100) / ROW_HEIGHT));
  const nextCapacity = Math.max(1, Math.floor((PAGE_HEIGHT - NEXT_TABLE_TOP - HEADER_HEIGHT - 100) / ROW_HEIGHT));
  const pages = paginateReportRows(input.table.rows, firstCapacity, nextCapacity);
  const widths = columnWidths(input.table);
  const rightEdge = PAGE_WIDTH - MARGIN;

  return pages.map((rows, pageIndex) => {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不能创建 PDF 绘图画布');

    // Warm archival ledger paper canvas.
    context.fillStyle = PDF_PAPER;
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

    // Top folio double hairline rule.
    drawDoubleRule(context, MARGIN, rightEdge, 44);

    if (pageIndex === 0) {
      context.textBaseline = 'alphabetic';
      context.textAlign = 'left';
      context.fillStyle = PDF_INK;
      context.font = `700 36px ${FONT_TEXT}`;
      context.fillText(input.title, MARGIN, 102);

      context.font = `18px ${FONT_TEXT}`;
      context.fillStyle = PDF_INK_SECONDARY;
      context.fillText(`统计范围：${input.range}`, MARGIN, 140);
      context.fillText(`立册时间：${generatedAt.toLocaleString('zh-CN')} · 本位币：${input.table.reportCurrencyCode ?? '未设置'}`, MARGIN, 170);

      if (input.table.valuationComplete === false) {
        context.fillStyle = PDF_WARNING;
        context.fillText(`估值提示：缺少 ${(input.table.missingRateAssetCodes ?? []).join('、')} 的汇率标记`, MARGIN, 198);
      }
      drawFolioSeal(context, rightEdge, 68);
    } else {
      context.textBaseline = 'alphabetic';
      context.textAlign = 'left';
      context.fillStyle = PDF_INK_SECONDARY;
      context.font = `700 20px ${FONT_TEXT}`;
      context.fillText(`${input.title}（续页）`, MARGIN, 92);
      context.textAlign = 'right';
      context.font = `17px ${FONT_TEXT}`;
      context.fillStyle = PDF_INK_TERTIARY;
      context.fillText(`${input.range} · ${input.table.reportCurrencyCode ?? ''}`.trim(), rightEdge, 92);
      context.textAlign = 'left';
    }

    drawTable(context, input.table, rows, pageIndex === 0 ? FIRST_TABLE_TOP : NEXT_TABLE_TOP, widths);

    // Ledger footer rule & colophon pagination.
    const footerRuleY = PAGE_HEIGHT - 74;
    context.strokeStyle = PDF_RULE;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(MARGIN, footerRuleY);
    context.lineTo(rightEdge, footerRuleY);
    context.stroke();

    context.fillStyle = PDF_INK_TERTIARY;
    context.font = `16px ${FONT_TEXT}`;
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    context.fillText('有本 · 大福帳 · 个人收支与多资产总账', MARGIN, PAGE_HEIGHT - 44);
    context.font = `16px ${FONT_NUM}`;
    context.textAlign = 'right';
    context.fillText(`第 ${pageIndex + 1} / ${pages.length} 页`, rightEdge, PAGE_HEIGHT - 44);
    context.textAlign = 'left';
    return jpegBytes(canvas);
  });
}

function ascii(value: string): Uint8Array {
  return encoder.encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function pdfFromJpegs(images: Uint8Array[]): Uint8Array {
  const objectCount = 2 + images.length * 3;
  const objects = new Map<number, Uint8Array>();
  objects.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));
  const pageIds = images.map((_, index) => 3 + index * 3);
  objects.set(2, ascii(`<< /Type /Pages /Count ${images.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  images.forEach((image, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const imageName = `Im${index + 1}`;
    objects.set(pageId, ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_WIDTH} ${PDF_HEIGHT}] `
      + `/Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    objects.set(imageId, concat([
      ascii(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.byteLength} >>\nstream\n`),
      image,
      ascii('\nendstream'),
    ]));
    const content = `q\n${PDF_WIDTH} 0 0 ${PDF_HEIGHT} 0 0 cm\n/${imageName} Do\nQ\n`;
    objects.set(contentId, ascii(`<< /Length ${ascii(content).byteLength} >>\nstream\n${content}endstream`));
  });

  const parts: Uint8Array[] = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a])];
  const offsets = new Array<number>(objectCount + 1).fill(0);
  let cursor = parts[0]!.byteLength;
  for (let id = 1; id <= objectCount; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`PDF 对象 ${id} 缺失`);
    const prefix = ascii(`${id} 0 obj\n`);
    const suffix = ascii('\nendobj\n');
    offsets[id] = cursor;
    parts.push(prefix, body, suffix);
    cursor += prefix.byteLength + body.byteLength + suffix.byteLength;
  }
  const xrefOffset = cursor;
  const xref = [
    `xref\n0 ${objectCount + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  parts.push(ascii(xref));
  return concat(parts);
}

export function createReportPdf(input: ReportPdfInput): Blob {
  const bytes = pdfFromJpegs(renderPages(input));
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' });
}

export function downloadReportPdf(fileName: string, input: ReportPdfInput): void {
  const blob = createReportPdf(input);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

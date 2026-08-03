import type { Table } from './selectors/reports.js';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const MARGIN = 58;
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 52;
const FIRST_TABLE_TOP = 190;
const NEXT_TABLE_TOP = 105;
const encoder = new TextEncoder();

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

function drawTable(
  context: CanvasRenderingContext2D,
  table: Table,
  rows: Table['rows'],
  top: number,
  widths: number[],
): void {
  context.textBaseline = 'middle';
  context.font = '700 19px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillStyle = '#f1f5f9';
  context.fillRect(MARGIN, top, PAGE_WIDTH - MARGIN * 2, HEADER_HEIGHT);
  context.strokeStyle = '#cbd5e1';
  context.lineWidth = 1;
  let x = MARGIN;
  for (let index = 0; index < table.headers.length; index += 1) {
    const width = widths[index]!;
    context.strokeRect(x, top, width, HEADER_HEIGHT);
    context.fillStyle = '#0f172a';
    context.fillText(fitText(context, table.headers[index]!, width - 20), x + 10, top + HEADER_HEIGHT / 2);
    x += width;
  }

  context.font = '17px "Microsoft YaHei", "PingFang SC", sans-serif';
  rows.forEach((row, rowIndex) => {
    const y = top + HEADER_HEIGHT + rowIndex * ROW_HEIGHT;
    context.fillStyle = rowIndex % 2 ? '#f8fafc' : '#ffffff';
    context.fillRect(MARGIN, y, PAGE_WIDTH - MARGIN * 2, ROW_HEIGHT);
    let cellX = MARGIN;
    row.forEach((cell, columnIndex) => {
      const width = widths[columnIndex]!;
      context.strokeStyle = '#e2e8f0';
      context.strokeRect(cellX, y, width, ROW_HEIGHT);
      context.fillStyle = cell.color?.includes('positive') ? '#047857'
        : cell.color?.includes('negative') ? '#b91c1c'
          : '#1e293b';
      context.font = `${cell.bold ? '700' : '400'} 17px "Microsoft YaHei", "PingFang SC", sans-serif`;
      context.fillText(fitText(context, cell.v, width - 20), cellX + 10, y + ROW_HEIGHT / 2);
      cellX += width;
    });
  });
}

function jpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  const encoded = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  if (!encoded) throw new Error('PDF 页面图像编码失败');
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function renderPages(input: ReportPdfInput): Uint8Array[] {
  const generatedAt = input.generatedAt ?? new Date();
  const firstCapacity = Math.max(1, Math.floor((PAGE_HEIGHT - FIRST_TABLE_TOP - HEADER_HEIGHT - 95) / ROW_HEIGHT));
  const nextCapacity = Math.max(1, Math.floor((PAGE_HEIGHT - NEXT_TABLE_TOP - HEADER_HEIGHT - 95) / ROW_HEIGHT));
  const pages = paginateReportRows(input.table.rows, firstCapacity, nextCapacity);
  const widths = columnWidths(input.table);
  return pages.map((rows, pageIndex) => {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不能创建 PDF 绘图画布');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.fillStyle = '#0f172a';
    context.font = '700 38px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.fillText(input.title, MARGIN, 72);
    context.font = '19px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.fillStyle = '#475569';
    context.fillText(`范围：${input.range}`, MARGIN, 113);
    context.fillText(`生成：${generatedAt.toLocaleString('zh-CN')} · 报表币种：${input.table.reportCurrencyCode ?? '未设置'}`, MARGIN, 145);
    if (input.table.valuationComplete === false) {
      context.fillStyle = '#b45309';
      context.fillText(`估值不完整：缺少 ${(input.table.missingRateAssetCodes ?? []).join('、')} 的汇率`, MARGIN, 174);
    }
    drawTable(context, input.table, rows, pageIndex === 0 ? FIRST_TABLE_TOP : NEXT_TABLE_TOP, widths);
    context.fillStyle = '#64748b';
    context.font = '17px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.textAlign = 'right';
    context.fillText(`第 ${pageIndex + 1} / ${pages.length} 页`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 45);
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

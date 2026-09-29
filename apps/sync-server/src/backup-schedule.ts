/** Calendar windows use the server's local timezone, shown explicitly in the console. */
export interface BackupWindow { day?: number; start: number; end: number }
const DAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function parseBackupWindow(value: string): BackupWindow {
  const match = /^(?:(每天|每日|Daily|(?:每?周|星期)[一二三四五六日天]|Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+)?(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('维护窗口格式应为 每天 03:00-04:00 或 周日 03:00-04:00（服务器本地时区）');
  const numbers = match.slice(2).map(Number);
  if (numbers[0]! > 23 || numbers[2]! > 23 || numbers[1]! > 59 || numbers[3]! > 59) throw new Error('维护窗口时间无效');
  const start = numbers[0]! * 60 + numbers[1]!;
  const end = numbers[2]! * 60 + numbers[3]!;
  if (start === end) throw new Error('维护窗口起止时间不能相同');
  const label = match[1] ?? '每天';
  const day = ['每天', '每日', 'Daily'].includes(label) ? undefined : DAYS[label] ?? DAYS[label.slice(-1)];
  return { ...(day === undefined ? {} : { day }), start, end };
}

export function backupSlot(window: BackupWindow, now: Date, lastSlot?: string): { due?: string; nextAt: string } {
  for (let offset = -1; offset <= 8; offset++) {
    const start = new Date(now); start.setDate(start.getDate() + offset); start.setHours(Math.floor(window.start / 60), window.start % 60, 0, 0);
    if (window.day !== undefined && start.getDay() !== window.day) continue;
    const end = new Date(start);
    if (window.end < window.start) end.setDate(end.getDate() + 1);
    end.setHours(Math.floor(window.end / 60), window.end % 60, 0, 0);
    const key = start.toISOString();
    // A high-water mark also prevents a wall-clock rollback from replaying older windows.
    if (lastSlot && key <= lastSlot) continue;
    if (start <= now && now < end) return { due: key, nextAt: key };
    if (start > now) return { nextAt: key };
  }
  throw new Error('无法计算下一次备份窗口');
}

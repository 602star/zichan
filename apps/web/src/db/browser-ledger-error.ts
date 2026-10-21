export class BrowserLedgerAlreadyOpenError extends Error {
  constructor(message = '账本已在另一个标签页打开。为防止本地数据互相覆盖，请关闭其他标签页后重试。') {
    super(message);
    this.name = 'BrowserLedgerAlreadyOpenError';
  }
}

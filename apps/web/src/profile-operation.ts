export interface ProfileOperation {
  signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
}

/** A response may commit only to the exact configuration and credential revision it started with. */
export class ProfileOperations {
  private pending = new Map<string, { controller: AbortController; current: () => boolean }>();

  start(id: string, revision: () => string): ProfileOperation {
    this.cancel(id);
    const controller = new AbortController();
    const initial = revision();
    const current = () => !controller.signal.aborted && revision() === initial;
    this.pending.set(id, { controller, current });
    return {
      signal: controller.signal,
      current,
      assertCurrent: () => { if (!current()) throw new Error('连接或登录会话已改变，已忽略旧请求结果'); },
    };
  }

  finish(id: string, operation: ProfileOperation): void {
    if (this.pending.get(id)?.controller.signal === operation.signal) this.pending.delete(id);
  }

  cancel(id: string): void { this.pending.get(id)?.controller.abort(); this.pending.delete(id); }
  cancelStale(): void { for (const [id, pending] of this.pending) if (!pending.current()) this.cancel(id); }
  cancelAll(): void { for (const id of this.pending.keys()) this.cancel(id); }
}

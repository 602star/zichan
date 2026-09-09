/** Serializes pages within a query and invalidates every result on query change. */
export class QueryGeneration {
  private generation = 0;
  private sequence = 0;
  private busy = false;

  reset(): void {
    this.generation += 1;
    this.busy = false;
  }

  start(): { generation: number; sequence: number } | undefined {
    if (this.busy) return undefined;
    this.busy = true;
    this.sequence += 1;
    return { generation: this.generation, sequence: this.sequence };
  }

  current(token: { generation: number; sequence: number }): boolean {
    return token.generation === this.generation && token.sequence === this.sequence;
  }

  finish(token: { generation: number; sequence: number }): void {
    if (this.current(token)) this.busy = false;
  }
}

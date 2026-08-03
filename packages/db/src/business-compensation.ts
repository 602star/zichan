export type BusinessCompensationStatus = 'pending' | 'applied' | 'blocked';

export interface CompensationEntityState {
  entityType: string;
  entityId: string;
  sequence: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface BusinessCompensationPayload {
  version: 1;
  states: CompensationEntityState[];
}

export interface BusinessCompensationRecord {
  id: string;
  sourceBatchId: string;
  label: string;
  createdAt: string;
  status: BusinessCompensationStatus;
  payload: BusinessCompensationPayload;
  affectedEntities: { entityType: string; entityId: string }[];
  appliedAt?: string;
  appliedBatchId?: string;
  error?: string;
}

export interface BusinessCompensationQuery {
  status?: BusinessCompensationStatus;
  limit?: number;
}

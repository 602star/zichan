import { isSchemaResetRequiredError } from '@zichan/db';
import { isDeviceStorageResetRequiredError } from '../device-storage-error.js';

export function isInitializationResetRequiredError(error: unknown): boolean {
  return isSchemaResetRequiredError(error) || isDeviceStorageResetRequiredError(error);
}

export const DEVICE_STORAGE_RESET_REQUIRED_CODE = 'DEVICE_STORAGE_RESET_REQUIRED';

/**
 * The persisted device data cannot be opened safely with the current storage
 * envelope. Callers may offer an explicit, confirmed local reset, but must not
 * delete or rewrite the data automatically.
 */
export class DeviceStorageResetRequiredError extends Error {
  readonly code = DEVICE_STORAGE_RESET_REQUIRED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceStorageResetRequiredError';
  }
}

export function isDeviceStorageResetRequiredError(
  error: unknown,
): error is DeviceStorageResetRequiredError {
  return error instanceof DeviceStorageResetRequiredError
    || (!!error && typeof error === 'object'
      && (error as { code?: unknown }).code === DEVICE_STORAGE_RESET_REQUIRED_CODE);
}

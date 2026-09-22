/** Small, self-contained images travel with the entity in encrypted commits/backups. */
export const MAX_ENTITY_ICON_LENGTH = 32768;

export function isEntityIconImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ENTITY_ICON_LENGTH
    && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function isValidEntityIcon(value: unknown): boolean {
  return value == null || value === '' || isEntityIconImage(value)
    || (typeof value === 'string' && (
      /^lucide:[a-z0-9-]{1,64}$/.test(value)
      // Existing ledgers may contain emoji or opaque icon names. Keep those inert
      // values editable; unknown keys render the fallback rather than markup/URLs.
      || /^[^<>:/\\\u0000-\u001f]{1,64}$/u.test(value)
    ));
}

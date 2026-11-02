/**
 * Form required-field rules shared by the entity form modal and its tests.
 *
 * Two invariants this module owns:
 * 1. A field may only block saving when the user can actually see and edit it.
 *    `required` on a `visibleWhen`/`hidden` field is a declaration of intent
 *    ("required *when* shown"), never a hidden trap.
 * 2. Every blocking field must be reachable: either rendered in the core grid,
 *    or forced into 更多信息, or reported so the caller can reveal it.
 */

export interface FormFieldLike {
  key: string;
  label: string;
  relatedValueKeys?: string[];
  required?: boolean;
  hidden?: boolean;
  section?: 'core' | 'more';
  lockedVisible?: boolean;
  keepInMore?: boolean;
  defaultValue?: string;
  visibleWhen?: (values: Record<string, string>) => boolean;
}

/** A field the user can see right now. */
export function isFieldVisible(field: FormFieldLike, values: Record<string, string>): boolean {
  if (field.hidden) return false;
  return field.visibleWhen?.(values) ?? true;
}

/**
 * "更多信息" fields are collapsed and individually toggleable. Anything the user
 * cannot un-see — locked fields and required ones — stays visible, otherwise a
 * required field could be switched off and silently block the save.
 */
export function isMoreFieldVisible(
  field: FormFieldLike,
  values: Record<string, string>,
  optionalFieldKeys?: string[],
  allMoreFieldKeys: string[] = [],
): boolean {
  if (!isFieldVisible(field, values)) return false;
  if (field.lockedVisible || field.required) return true;
  const enabled = new Set(optionalFieldKeys ?? allMoreFieldKeys);
  return enabled.has(field.key);
}

/** Keys the modal renders, in the same order as `fields`. */
export function renderedFieldKeys(
  fields: FormFieldLike[],
  values: Record<string, string>,
  optionalFieldKeys?: string[],
): string[] {
  const allMoreFieldKeys = fields.filter((f) => f.section === 'more' && !f.hidden).map((f) => f.key);
  return fields
    .filter((f) => (f.section === 'more'
      ? isMoreFieldVisible(f, values, optionalFieldKeys, allMoreFieldKeys)
      : isFieldVisible(f, values)))
    .map((f) => f.key);
}

/** Required fields that are empty *and* visible; hidden fields never block. */
export function requiredFieldErrors(
  fields: FormFieldLike[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.required || !isFieldVisible(field, values)) continue;
    if (!(values[field.key] ?? '').trim()) errors[field.key] = `请填写${field.label}`;
  }
  return errors;
}

/** Blocking fields that the modal is not currently rendering, so they can be revealed. */
export function unreachableErrorKeys(
  fields: FormFieldLike[],
  values: Record<string, string>,
  errors: Record<string, string>,
  optionalFieldKeys?: string[],
): string[] {
  const rendered = new Set(renderedFieldKeys(fields, values, optionalFieldKeys));
  return Object.keys(errors).filter((key) => !rendered.has(key));
}

/** Hint shown when a required picker has nothing to pick yet. */
export function emptyOptionHint(field: FormFieldLike, optionCount: number): string | undefined {
  if (!field.required || optionCount > 0) return undefined;
  return `${field.label}还没有可选项，请先新增`;
}

/** Only transaction forms opt into progressive placement; preferences never hide data. */
export function progressiveFieldGroups<T extends FormFieldLike>(fields: T[], values: Record<string, string>, prefilled: Record<string, string>, preferred: string[], compactKeys: readonly string[] = []) {
  const pinned = new Set(preferred);
  const compact = new Set(compactKeys);
  const core: T[] = [];
  const more: T[] = [];
  for (const field of fields) {
    if (!isFieldVisible(field, values)) continue;
    if (field.keepInMore) {
      more.push(field);
      continue;
    }
    const value = [field.key, ...(field.relatedValueKeys ?? [])].map((key) => prefilled[key]?.trim()).find(Boolean) ?? '';
    const hasData = value !== '' && value !== '[]' && value !== '{}' && value !== (field.defaultValue ?? '');
    ((field.section !== 'more' && !compact.has(field.key)) || (field.required && !compact.has(field.key)) || (field.lockedVisible && !compact.has(field.key)) || pinned.has(field.key) || hasData ? core : more).push(field);
  }
  return { core, more };
}

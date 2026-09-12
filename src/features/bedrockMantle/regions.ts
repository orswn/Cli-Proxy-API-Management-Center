export type MantleRegionRow = { model: string; region: string };
export type MantleRegionSettings = { defaultRegion: string; overrides: MantleRegionRow[] };
export type MantleRegionError =
  'mantle.invalid_region' | 'mantle.invalid_model' | 'mantle.duplicate_model';

export const REGION_PATTERN = /^[a-z]{2}(-[a-z0-9]{1,16}){1,3}-[1-9][0-9]?$/;
const MODEL_PATTERN = /^openai\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

export function readModelRegions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export function readMantleRegions(metadata: Record<string, unknown>): MantleRegionSettings {
  return {
    defaultRegion:
      typeof metadata.default_region === 'string' ? metadata.default_region : 'us-east-1',
    overrides: Object.entries(readModelRegions(metadata.model_regions)).map(([model, region]) => ({
      model,
      region,
    })),
  };
}

export function validateMantleRegions(settings: MantleRegionSettings): MantleRegionError | null {
  if (!REGION_PATTERN.test(settings.defaultRegion.trim())) return 'mantle.invalid_region';
  const seen = new Set<string>();
  for (const row of settings.overrides) {
    const model = row.model.trim();
    if (!MODEL_PATTERN.test(model)) return 'mantle.invalid_model';
    const key = model.toLowerCase();
    if (seen.has(key)) return 'mantle.duplicate_model';
    seen.add(key);
    if (!REGION_PATTERN.test(row.region.trim())) return 'mantle.invalid_region';
  }
  return null;
}

export function serializeModelRegions(rows: MantleRegionRow[]): Record<string, string> {
  return Object.fromEntries(rows.map(({ model, region }) => [model.trim(), region.trim()]));
}

export function buildMantleRegionPatch(
  original: Record<string, unknown>,
  settings: MantleRegionSettings
) {
  const patch: { default_region?: string; model_regions?: Record<string, string> } = {};
  const previous = readMantleRegions(original);
  if (settings.defaultRegion.trim() !== previous.defaultRegion.trim())
    patch.default_region = settings.defaultRegion.trim();
  const next = serializeModelRegions(settings.overrides);
  const before = serializeModelRegions(previous.overrides);
  if (
    Object.keys(next).length !== Object.keys(before).length ||
    Object.entries(next).some(([model, region]) => before[model] !== region)
  )
    patch.model_regions = next;
  return patch;
}

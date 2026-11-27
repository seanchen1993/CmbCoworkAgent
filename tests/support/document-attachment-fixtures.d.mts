export function visualDocx(
  pngs: readonly (Buffer | null)[],
  options?: { imageOnly?: boolean, missingRelationship?: boolean }
): Buffer

export function visualXlsx(png: Buffer): Buffer

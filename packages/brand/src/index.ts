// Single source of truth for product identity.
// Change these values to rebrand the entire workspace - no other file
// contains a hard-coded product name.
export const BRAND = {
  name: "Velari",
  id: "com.velari.app",
  storagePrefix: "velari",
  displayShort: "Velari",
} as const;

export const APP_NAME = BRAND.name;
export const APP_ID = BRAND.id;
export const STORAGE_PREFIX = BRAND.storagePrefix;

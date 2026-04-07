/**
 * Configuration schema validation using Zod.
 *
 * Provides runtime validation for collection configurations to ensure
 * data integrity and provide clear error messages for invalid configs.
 */

import { z } from "zod";

/**
 * Raw collection schema with optional fields for validation.
 * Default values are applied during validation.
 */
const RawCollectionSchema = z.object({
  path: z.string(),
  pattern: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  context: z.record(z.string(), z.string()).optional(),
  update: z.string().optional(),
  includeByDefault: z.boolean().optional(),
  type: z.enum(["raw", "wiki"]).optional(),
});

/**
 * Apply default values to a collection object.
 */
function applyCollectionDefaults(data: z.infer<typeof RawCollectionSchema>) {
  return {
    ...data,
    pattern: data.pattern ?? "**/*.md",
    includeByDefault: data.includeByDefault ?? true,
  };
}

export type CollectionInput = ReturnType<typeof applyCollectionDefaults>;

/**
 * Zod schema for the complete configuration file structure.
 */
export const CollectionConfigSchema = z.object({
  global_context: z.string().optional(),
  collections: z.record(z.string(), RawCollectionSchema),
});

export type CollectionConfigInput = z.infer<typeof CollectionConfigSchema>;

/**
 * Validate a collection configuration object.
 * Throws a detailed error if validation fails.
 */
export function validateCollectionConfig(
  config: unknown,
  source: string = "config"
): CollectionConfigInput {
  const result = CollectionConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => {
        const path = e.path.join(".");
        return `  - ${path || "root"}: ${e.message}`;
      })
      .join("\n");

    throw new Error(
      `Invalid configuration from ${source}:\n${errors}`
    );
  }

  // Apply defaults to all collections
  const collections: Record<string, CollectionInput> = {};
  for (const [key, value] of Object.entries(result.data.collections)) {
    collections[key] = applyCollectionDefaults(value);
  }

  return {
    global_context: result.data.global_context,
    collections,
  };
}

/**
 * Validate a single collection configuration.
 */
export function validateCollection(
  collection: unknown,
  name: string = "collection"
): CollectionInput {
  const result = RawCollectionSchema.safeParse(collection);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => {
        const path = e.path.join(".");
        return `  - ${path || "root"}: ${e.message}`;
      })
      .join("\n");

    throw new Error(
      `Invalid collection '${name}':\n${errors}`
    );
  }

  return applyCollectionDefaults(result.data);
}

/**
 * Validate that a collection path exists and is accessible.
 */
export async function validateCollectionPath(
  path: string,
  name: string = "collection"
): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const resolvedPath = resolve(path);

  try {
    const stats = await stat(resolvedPath);

    if (!stats.isDirectory()) {
      throw new Error(
        `Collection '${name}' path is not a directory: ${resolvedPath}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Collection '${name}' path does not exist: ${resolvedPath}`
      );
    }
    throw error;
  }
}

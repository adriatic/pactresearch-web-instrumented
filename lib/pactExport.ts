// .pact export/import format, ported from pact-mac's PactExport
// (src/storage/notebookStore.ts) for one specific purpose: repeatable
// test fixtures for the timing/instrumentation work. A .pact file is
// meant to be fully equivalent to a notebook instance -- importing the
// same file twice produces two independent, content-identical notebooks,
// every time.
//
// Deliberately NOT ported from pact-mac:
//   - xmState: desktop-only UI navigation state, not applicable to web.
//   - signing: pact-mac signs exports with a per-machine Ed25519 key --
//     doesn't translate to a multi-user web app (no single "local
//     machine" identity), and isn't needed for test fixtures. Export and
//     import here are plain, unsigned JSON.
//   - notebook.executionMode: this app's own schema has never had a
//     column for it -- the very first migration's own header says the
//     scope is "single-user Interactive mode only... Index mode dropped
//     entirely." There's no dual-mode concept here to preserve.
//
// Known lossy/excluded fields (see the export function's own comments
// for the full field-by-field mapping):
//   - notebooks.is_system, created_at/updated_at
//   - discussions.parent_id (unused anywhere in this app today, and has
//     no equivalent in pact-mac's discussions type either),
//     draft_prompt_text (drafts aren't part of pact-mac's export concept)
//   - responses.image_path / image_mime_type (no equivalent in pact-mac's
//     cells type; currently unused by any feature in this app, so
//     nothing is silently lost in practice today)
//   - category is round-tripped as an opaque string, not validated
//     against pact-mac's "personal-research" | "samples" | "dev-tests" |
//     "user-requests" union -- this app's real category values
//     ("Personal Research", "Dev Test") are a different naming scheme
//     entirely, so coercing between them would be arbitrary and lossy.

export const PACT_EXPORT_VERSION = 1;

export interface PactExportCell {
  id: string;
  discussionId: string;
  parentId: string | null;
  promptText: string;
  response: string;
  model: string;
  resolvedModel?: string | null;
  cellType: string;
  createdAt: number;
}

export interface PactExportDiscussion {
  id: string;
  name: string;
  createdAt: number;
  totalTimeMs: number;
}

export interface PactExport {
  version: number;
  exportedAt: number;
  notebook: {
    name: string;
    systemPrompt: string | null;
    category?: string | null;
  };
  discussions: PactExportDiscussion[];
  cells: PactExportCell[];
}

class PactExportValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PactExportValidationError(`${field} must be a string.`);
  }
  return value;
}

// Stricter than requireString for the two identifying names this format
// carries (notebook.name, discussions[].name): a real, well-formed
// export can never contain an empty one -- both creation paths this app
// has (the manual create forms, and now the unique-discussion-name
// constraint) already reject that at the source. An empty string only
// ever reaches here via a hand-edited or otherwise malformed file, and
// letting it through used to mean the imported row displayed its own
// raw uuid in the Explorer tree in place of a name (Explorer.tsx's
// name-or-id fallback existed for exactly this reason) -- closed here,
// at the one place that can actually prevent it from being created,
// rather than only papering over it at display time.
function requireNonEmptyString(value: unknown, field: string): string {
  const str = requireString(value, field);
  if (str.trim().length === 0) {
    throw new PactExportValidationError(
      `${field} must not be empty or whitespace-only.`,
    );
  }
  return str;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, field);
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PactExportValidationError(`${field} must be a number.`);
  }
  return value;
}

// Validates and narrows an arbitrary parsed-JSON value into a PactExport,
// throwing PactExportValidationError with a specific, human-readable
// message for the first thing that's wrong -- a malformed file should
// fail clearly, not crash cryptically partway through import.
export function validatePactExport(data: unknown): PactExport {
  if (!isPlainObject(data)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: expected a JSON object.",
    );
  }

  if (data.version !== PACT_EXPORT_VERSION) {
    throw new PactExportValidationError(
      `Unsupported .pact file version: expected ${PACT_EXPORT_VERSION}, got ${JSON.stringify(data.version)}.`,
    );
  }

  if (!isPlainObject(data.notebook)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: missing notebook object.",
    );
  }
  const notebook = {
    name: requireNonEmptyString(data.notebook.name, "notebook.name"),
    systemPrompt: requireNullableString(
      data.notebook.systemPrompt,
      "notebook.systemPrompt",
    ),
    category: requireNullableString(
      data.notebook.category,
      "notebook.category",
    ),
  };

  if (!Array.isArray(data.discussions)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: discussions must be an array.",
    );
  }
  const discussions: PactExportDiscussion[] = data.discussions.map(
    (raw, index) => {
      if (!isPlainObject(raw)) {
        throw new PactExportValidationError(
          `Not a valid .pact file: discussions[${index}] is not an object.`,
        );
      }
      return {
        id: requireString(raw.id, `discussions[${index}].id`),
        name: requireNonEmptyString(raw.name, `discussions[${index}].name`),
        createdAt: requireNumber(
          raw.createdAt,
          `discussions[${index}].createdAt`,
        ),
        totalTimeMs: requireNumber(
          raw.totalTimeMs,
          `discussions[${index}].totalTimeMs`,
        ),
      };
    },
  );
  const discussionIds = new Set(discussions.map((d) => d.id));

  if (!Array.isArray(data.cells)) {
    throw new PactExportValidationError(
      "Not a valid .pact file: cells must be an array.",
    );
  }
  const cells: PactExportCell[] = data.cells.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new PactExportValidationError(
        `Not a valid .pact file: cells[${index}] is not an object.`,
      );
    }
    const discussionId = requireString(
      raw.discussionId,
      `cells[${index}].discussionId`,
    );
    if (!discussionIds.has(discussionId)) {
      throw new PactExportValidationError(
        `Not a valid .pact file: cells[${index}].discussionId does not match any discussion in this file.`,
      );
    }
    return {
      id: requireString(raw.id, `cells[${index}].id`),
      discussionId,
      parentId: requireNullableString(raw.parentId, `cells[${index}].parentId`),
      promptText: requireString(raw.promptText, `cells[${index}].promptText`),
      response: requireString(raw.response, `cells[${index}].response`),
      model: requireString(raw.model, `cells[${index}].model`),
      resolvedModel: requireNullableString(
        raw.resolvedModel,
        `cells[${index}].resolvedModel`,
      ),
      cellType: requireString(raw.cellType, `cells[${index}].cellType`),
      createdAt: requireNumber(raw.createdAt, `cells[${index}].createdAt`),
    };
  });

  return {
    version: data.version,
    exportedAt:
      typeof data.exportedAt === "number" ? data.exportedAt : Date.now(),
    notebook,
    discussions,
    cells,
  };
}

export { PactExportValidationError };

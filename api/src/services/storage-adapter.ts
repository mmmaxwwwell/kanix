import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /** Store a file and return the storage key. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;

  /** Retrieve a file by its storage key. Returns null if not found. */
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;

  /** Delete a file by its storage key. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local filesystem adapter (development)
// ---------------------------------------------------------------------------

export function createLocalStorageAdapter(basePath: string): StorageAdapter {
  return {
    async put(key, data) {
      const fullPath = join(basePath, key);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, data);
    },

    async get(key) {
      const fullPath = join(basePath, key);
      if (!existsSync(fullPath)) return null;
      const data = readFileSync(fullPath);
      // Infer content type from extension
      const ext = key.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "pdf"
          ? "application/pdf"
          : ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : "application/octet-stream";
      return { data, contentType };
    },

    async delete(key) {
      const fullPath = join(basePath, key);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Stub adapter (testing)
// ---------------------------------------------------------------------------

export function createStubStorageAdapter(): StorageAdapter & {
  getStored(): Map<string, { data: Buffer; contentType: string }>;
} {
  const store = new Map<string, { data: Buffer; contentType: string }>();
  return {
    async put(key, data, contentType) {
      store.set(key, { data, contentType });
    },

    async get(key) {
      return store.get(key) ?? null;
    },

    async delete(key) {
      store.delete(key);
    },

    getStored() {
      return store;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateStorageAdapterOptions {
  /** "local" or "s3". Defaults to "local". */
  type?: string;
  /** Base path for local storage. Defaults to "data/attachments". */
  localBasePath?: string;
}

export function createStorageAdapter(options: CreateStorageAdapterOptions = {}): StorageAdapter {
  const type = options.type ?? "local";
  if (type === "local") {
    return createLocalStorageAdapter(options.localBasePath ?? "data/attachments");
  }
  // S3 adapter would be implemented here for production
  return createLocalStorageAdapter(options.localBasePath ?? "data/attachments");
}

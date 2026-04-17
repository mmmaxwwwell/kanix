import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  // Application
  readonly PORT: number;
  readonly LOG_LEVEL: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  readonly NODE_ENV: "development" | "production" | "test";

  // Database
  readonly DATABASE_URL: string;

  // Stripe
  readonly STRIPE_SECRET_KEY: string;
  readonly STRIPE_WEBHOOK_SECRET: string;
  readonly STRIPE_TAX_ENABLED: boolean;

  // SuperTokens
  readonly SUPERTOKENS_API_KEY: string;
  readonly SUPERTOKENS_CONNECTION_URI: string;

  // EasyPost
  readonly EASYPOST_API_KEY: string;

  // GitHub OAuth
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;

  // Security middleware
  readonly CORS_ALLOWED_ORIGINS: string[];
  readonly RATE_LIMIT_MAX: number;
  readonly RATE_LIMIT_WINDOW_MS: number;
}

// ---------------------------------------------------------------------------
// Defaults (non-secret values only)
// ---------------------------------------------------------------------------

const DEFAULTS: Record<string, string> = {
  PORT: "3000",
  LOG_LEVEL: "INFO",
  NODE_ENV: "development",
  SUPERTOKENS_CONNECTION_URI: "http://localhost:3567",
  STRIPE_TAX_ENABLED: "false",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  RATE_LIMIT_MAX: "100",
  RATE_LIMIT_WINDOW_MS: "60000",
};

// ---------------------------------------------------------------------------
// Secret keys — must come from env vars, never from .env file or defaults
// ---------------------------------------------------------------------------

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPERTOKENS_API_KEY",
  "EASYPOST_API_KEY",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
]);

// Keys whose values should be redacted in logs
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPERTOKENS_API_KEY",
  "EASYPOST_API_KEY",
  "GITHUB_OAUTH_CLIENT_SECRET",
]);

// ---------------------------------------------------------------------------
// Required keys (all Config keys)
// ---------------------------------------------------------------------------

const REQUIRED_KEYS: readonly string[] = [
  "PORT",
  "LOG_LEVEL",
  "NODE_ENV",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_TAX_ENABLED",
  "SUPERTOKENS_API_KEY",
  "SUPERTOKENS_CONNECTION_URI",
  "EASYPOST_API_KEY",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "CORS_ALLOWED_ORIGINS",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WINDOW_MS",
];

// ---------------------------------------------------------------------------
// .env file parser
// ---------------------------------------------------------------------------

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);
const VALID_NODE_ENVS = new Set(["development", "production", "test"]);

interface ValidationError {
  key: string;
  message: string;
}

function validateRaw(raw: Record<string, string | undefined>): {
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = raw[key];
    if (value === undefined || value === "") {
      errors.push({ key, message: `missing required config: ${key}` });
    }
  }

  // Type validations (only if present)
  const port = raw["PORT"];
  if (port !== undefined && port !== "") {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push({
        key: "PORT",
        message: `invalid PORT: must be an integer between 1 and 65535, got "${port}"`,
      });
    }
  }

  const logLevel = raw["LOG_LEVEL"];
  if (logLevel !== undefined && logLevel !== "" && !VALID_LOG_LEVELS.has(logLevel)) {
    errors.push({
      key: "LOG_LEVEL",
      message: `invalid LOG_LEVEL: must be one of DEBUG, INFO, WARN, ERROR, FATAL, got "${logLevel}"`,
    });
  }

  const nodeEnv = raw["NODE_ENV"];
  if (nodeEnv !== undefined && nodeEnv !== "" && !VALID_NODE_ENVS.has(nodeEnv)) {
    errors.push({
      key: "NODE_ENV",
      message: `invalid NODE_ENV: must be one of development, production, test, got "${nodeEnv}"`,
    });
  }

  const rateLimitMax = raw["RATE_LIMIT_MAX"];
  if (rateLimitMax !== undefined && rateLimitMax !== "") {
    const parsed = Number(rateLimitMax);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({
        key: "RATE_LIMIT_MAX",
        message: `invalid RATE_LIMIT_MAX: must be a positive integer, got "${rateLimitMax}"`,
      });
    }
  }

  const rateLimitWindow = raw["RATE_LIMIT_WINDOW_MS"];
  if (rateLimitWindow !== undefined && rateLimitWindow !== "") {
    const parsed = Number(rateLimitWindow);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({
        key: "RATE_LIMIT_WINDOW_MS",
        message: `invalid RATE_LIMIT_WINDOW_MS: must be a positive integer, got "${rateLimitWindow}"`,
      });
    }
  }

  const taxEnabled = raw["STRIPE_TAX_ENABLED"];
  if (
    taxEnabled !== undefined &&
    taxEnabled !== "" &&
    taxEnabled !== "true" &&
    taxEnabled !== "false"
  ) {
    errors.push({
      key: "STRIPE_TAX_ENABLED",
      message: `invalid STRIPE_TAX_ENABLED: must be "true" or "false", got "${taxEnabled}"`,
    });
  }

  return { errors };
}

// ---------------------------------------------------------------------------
// Redaction for logging
// ---------------------------------------------------------------------------

export function redactValue(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "missing";
  if (SENSITIVE_KEYS.has(key)) return "present";
  return value;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  envFilePath?: string;
  env?: Record<string, string | undefined>;
  logger?: (message: string) => void;
  exitFn?: (code: number) => void;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const {
    envFilePath = resolve(process.cwd(), ".env"),
    env = process.env,
    logger = console.error.bind(console),
    exitFn = process.exit.bind(process),
  } = options;

  // Layer 1: defaults
  const merged: Record<string, string | undefined> = { ...DEFAULTS };

  // Layer 2: .env file (non-secret keys only)
  if (existsSync(envFilePath)) {
    const fileContent = readFileSync(envFilePath, "utf-8");
    const fileVars = parseEnvFile(fileContent);
    for (const [key, value] of Object.entries(fileVars)) {
      if (SECRET_KEYS.has(key)) continue; // secrets must come from env vars
      merged[key] = value;
    }
  }

  // Layer 3: environment variables (highest precedence)
  for (const key of REQUIRED_KEYS) {
    const envValue = env[key];
    if (envValue !== undefined && envValue !== "") {
      merged[key] = envValue;
    }
  }

  // Validate
  const { errors } = validateRaw(merged);

  // Log config state (redacted)
  logger("Config loaded:");
  for (const key of REQUIRED_KEYS) {
    logger(`  ${key}: ${redactValue(key, merged[key])}`);
  }

  if (errors.length > 0) {
    logger("Config validation failed:");
    for (const err of errors) {
      logger(`  ${err.message}`);
    }
    exitFn(1);
  }

  // Helper to get a validated (known-present) string value
  const get = (key: string): string => merged[key] ?? "";

  // Build typed config
  return {
    PORT: Number(get("PORT")),
    LOG_LEVEL: get("LOG_LEVEL") as Config["LOG_LEVEL"],
    NODE_ENV: get("NODE_ENV") as Config["NODE_ENV"],
    DATABASE_URL: get("DATABASE_URL"),
    STRIPE_SECRET_KEY: get("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: get("STRIPE_WEBHOOK_SECRET"),
    STRIPE_TAX_ENABLED: get("STRIPE_TAX_ENABLED") === "true",
    SUPERTOKENS_API_KEY: get("SUPERTOKENS_API_KEY"),
    SUPERTOKENS_CONNECTION_URI: get("SUPERTOKENS_CONNECTION_URI"),
    EASYPOST_API_KEY: get("EASYPOST_API_KEY"),
    GITHUB_OAUTH_CLIENT_ID: get("GITHUB_OAUTH_CLIENT_ID"),
    GITHUB_OAUTH_CLIENT_SECRET: get("GITHUB_OAUTH_CLIENT_SECRET"),
    CORS_ALLOWED_ORIGINS: get("CORS_ALLOWED_ORIGINS")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    RATE_LIMIT_MAX: Number(get("RATE_LIMIT_MAX")),
    RATE_LIMIT_WINDOW_MS: Number(get("RATE_LIMIT_WINDOW_MS")),
  };
}

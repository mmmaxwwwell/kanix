import { describe, it, expect, vi } from "vitest";
import { loadConfig, parseEnvFile, redactValue } from "./config.js";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Full valid env for tests
function validEnv(): Record<string, string> {
  return {
    PORT: "3000",
    LOG_LEVEL: "INFO",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/kanix",
    STRIPE_SECRET_KEY: "sk_test_abc123",
    STRIPE_WEBHOOK_SECRET: "whsec_abc123",
    PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_abc123",
    STRIPE_TAX_ENABLED: "false",
    SUPERTOKENS_API_KEY: "supertokens-key",
    SUPERTOKENS_CONNECTION_URI: "http://localhost:3567",
    EASYPOST_API_KEY: "EZAK_abc123",
    EASYPOST_WEBHOOK_SECRET: "ep_whsec_test123",
    GITHUB_OAUTH_CLIENT_ID: "gh-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret",
  };
}

describe("parseEnvFile", () => {
  it("parses key=value pairs", () => {
    const content = `FOO=bar\nBAZ=qux`;
    expect(parseEnvFile(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", () => {
    const content = `# comment\n\nFOO=bar\n  # another comment`;
    expect(parseEnvFile(content)).toEqual({ FOO: "bar" });
  });

  it("strips surrounding quotes", () => {
    const content = `A="hello"\nB='world'`;
    expect(parseEnvFile(content)).toEqual({ A: "hello", B: "world" });
  });

  it("handles values with equals signs", () => {
    const content = `URL=postgres://user:pass@host:5432/db?opt=val`;
    expect(parseEnvFile(content)).toEqual({
      URL: "postgres://user:pass@host:5432/db?opt=val",
    });
  });
});

describe("loadConfig", () => {
  const noopLogger = () => {};
  const noopExit = () => {};

  it("loads valid config from env vars", () => {
    const config = loadConfig({
      env: validEnv(),
      envFilePath: "/nonexistent/.env",
      logger: noopLogger,
      exitFn: noopExit,
    });

    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("INFO");
    expect(config.NODE_ENV).toBe("development");
    expect(config.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/kanix");
    expect(config.STRIPE_SECRET_KEY).toBe("sk_test_abc123");
    expect(config.STRIPE_TAX_ENABLED).toBe(false);
    expect(config.SUPERTOKENS_CONNECTION_URI).toBe("http://localhost:3567");
  });

  it("STRIPE_TAX_ENABLED=true enables tax", () => {
    const env = validEnv();
    env.STRIPE_TAX_ENABLED = "true";
    const config = loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: noopLogger,
      exitFn: noopExit,
    });
    expect(config.STRIPE_TAX_ENABLED).toBe(true);
  });

  it("uses defaults when env vars are not set", () => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>).PORT;
    delete (env as Record<string, string | undefined>).LOG_LEVEL;
    delete (env as Record<string, string | undefined>).NODE_ENV;
    delete (env as Record<string, string | undefined>).SUPERTOKENS_CONNECTION_URI;
    delete (env as Record<string, string | undefined>).STRIPE_TAX_ENABLED;

    const config = loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: noopLogger,
      exitFn: noopExit,
    });

    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("INFO");
    expect(config.NODE_ENV).toBe("development");
    expect(config.SUPERTOKENS_CONNECTION_URI).toBe("http://localhost:3567");
    expect(config.STRIPE_TAX_ENABLED).toBe(false);
  });

  it("loads non-secret values from .env file", () => {
    const dir = join(tmpdir(), `kanix-config-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "PORT=4000\nLOG_LEVEL=DEBUG\n");

    try {
      const config = loadConfig({
        env: validEnv(),
        envFilePath: envFile,
        logger: noopLogger,
        exitFn: noopExit,
      });

      // env vars take precedence over .env file
      expect(config.PORT).toBe(3000);
    } finally {
      unlinkSync(envFile);
    }
  });

  it(".env file values are used when env var is not set", () => {
    const dir = join(tmpdir(), `kanix-config-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "PORT=4000\nLOG_LEVEL=DEBUG\n");

    const env = validEnv();
    delete (env as Record<string, string | undefined>).PORT;
    delete (env as Record<string, string | undefined>).LOG_LEVEL;

    try {
      const config = loadConfig({
        env,
        envFilePath: envFile,
        logger: noopLogger,
        exitFn: noopExit,
      });

      expect(config.PORT).toBe(4000);
      expect(config.LOG_LEVEL).toBe("DEBUG");
    } finally {
      unlinkSync(envFile);
    }
  });

  it("ignores secret keys from .env file", () => {
    const dir = join(tmpdir(), `kanix-config-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "DATABASE_URL=from-file\nSTRIPE_SECRET_KEY=from-file\n");

    const env = validEnv();
    // Secrets from env should be used, not from .env file
    const config = loadConfig({
      env,
      envFilePath: envFile,
      logger: noopLogger,
      exitFn: noopExit,
    });

    expect(config.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/kanix");
    expect(config.STRIPE_SECRET_KEY).toBe("sk_test_abc123");
  });

  it("calls exitFn(1) when required values are missing", () => {
    const exitFn = vi.fn();
    const logs: string[] = [];

    loadConfig({
      env: {},
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn,
    });

    expect(exitFn).toHaveBeenCalledWith(1);
    const logText = logs.join("\n");
    expect(logText).toContain("missing required config: DATABASE_URL");
    expect(logText).toContain("missing required config: STRIPE_SECRET_KEY");
  });

  it("calls exitFn(1) for invalid PORT type", () => {
    const exitFn = vi.fn();
    const logs: string[] = [];
    const env = validEnv();
    env.PORT = "not-a-number";

    loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn,
    });

    expect(exitFn).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("invalid PORT");
  });

  it("calls exitFn(1) for invalid LOG_LEVEL", () => {
    const exitFn = vi.fn();
    const logs: string[] = [];
    const env = validEnv();
    env.LOG_LEVEL = "VERBOSE";

    loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn,
    });

    expect(exitFn).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("invalid LOG_LEVEL");
  });

  it("calls exitFn(1) for invalid STRIPE_TAX_ENABLED", () => {
    const exitFn = vi.fn();
    const logs: string[] = [];
    const env = validEnv();
    env.STRIPE_TAX_ENABLED = "yes";

    loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn,
    });

    expect(exitFn).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("invalid STRIPE_TAX_ENABLED");
  });

  it("logs all missing keys at once (fail-fast)", () => {
    const exitFn = vi.fn();
    const logs: string[] = [];

    loadConfig({
      env: {},
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn,
    });

    const logText = logs.join("\n");
    // Should report all missing secrets, not just the first one
    expect(logText).toContain("DATABASE_URL");
    expect(logText).toContain("STRIPE_SECRET_KEY");
    expect(logText).toContain("STRIPE_WEBHOOK_SECRET");
    expect(logText).toContain("SUPERTOKENS_API_KEY");
    expect(logText).toContain("EASYPOST_API_KEY");
    expect(logText).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(logText).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    // Should only call exit once
    expect(exitFn).toHaveBeenCalledTimes(1);
  });
});

describe("redactValue (sensitive value redaction)", () => {
  it("shows 'present' for sensitive keys with values", () => {
    expect(redactValue("DATABASE_URL", "postgresql://secret")).toBe("present");
    expect(redactValue("STRIPE_SECRET_KEY", "sk_test_123")).toBe("present");
    expect(redactValue("STRIPE_WEBHOOK_SECRET", "whsec_123")).toBe("present");
    expect(redactValue("SUPERTOKENS_API_KEY", "key")).toBe("present");
    expect(redactValue("EASYPOST_API_KEY", "EZAK_123")).toBe("present");
    expect(redactValue("GITHUB_OAUTH_CLIENT_SECRET", "secret")).toBe("present");
  });

  it("shows 'missing' for sensitive keys without values", () => {
    expect(redactValue("DATABASE_URL", undefined)).toBe("missing");
    expect(redactValue("STRIPE_SECRET_KEY", "")).toBe("missing");
  });

  it("shows actual value for non-sensitive keys", () => {
    expect(redactValue("PORT", "3000")).toBe("3000");
    expect(redactValue("LOG_LEVEL", "INFO")).toBe("INFO");
    expect(redactValue("NODE_ENV", "development")).toBe("development");
  });

  it("shows 'missing' for non-sensitive keys without values", () => {
    expect(redactValue("PORT", undefined)).toBe("missing");
    expect(redactValue("LOG_LEVEL", "")).toBe("missing");
  });
});

describe("config logging redaction", () => {
  it("never logs actual secret values", () => {
    const logs: string[] = [];
    const env = validEnv();

    loadConfig({
      env,
      envFilePath: "/nonexistent/.env",
      logger: (msg) => logs.push(msg),
      exitFn: () => {},
    });

    const logText = logs.join("\n");
    // Actual secret values should NOT appear in logs
    expect(logText).not.toContain("postgresql://user:pass@localhost:5432/kanix");
    expect(logText).not.toContain("sk_test_abc123");
    expect(logText).not.toContain("whsec_abc123");
    expect(logText).not.toContain("supertokens-key");
    expect(logText).not.toContain("EZAK_abc123");
    expect(logText).not.toContain("gh-client-secret");

    // Should show "present" for sensitive keys
    expect(logText).toContain("DATABASE_URL: present");
    expect(logText).toContain("STRIPE_SECRET_KEY: present");

    // Should show actual values for non-sensitive keys
    expect(logText).toContain("PORT: 3000");
    expect(logText).toContain("LOG_LEVEL: INFO");
  });
});

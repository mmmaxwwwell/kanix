import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session/index.js";
import EmailPassword from "supertokens-node/recipe/emailpassword/index.js";
import EmailVerification from "supertokens-node/recipe/emailverification/index.js";
import ThirdParty from "supertokens-node/recipe/thirdparty/index.js";
import type { TypeInput } from "supertokens-node/types";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, and, ne, sql } from "drizzle-orm";
import { customer } from "../db/schema/customer.js";
import { linkGuestOrdersByEmail } from "../db/queries/order.js";
import type { AdminAlertService } from "../services/admin-alert.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuperTokensConfig {
  connectionUri: string;
  apiKey: string;
  appName: string;
  apiDomain: string;
  websiteDomain: string;
  db?: PostgresJsDatabase;
  adminAlertService?: AdminAlertService;
  githubOAuth?: {
    clientId: string;
    clientSecret: string;
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

let initialized = false;

export function initSuperTokens(config: SuperTokensConfig): void {
  if (initialized) return;
  initialized = true;
  const recipeList: TypeInput["recipeList"] = [
    EmailPassword.init({
      signUpFeature: {
        formFields: [
          { id: "email" },
          {
            id: "password",
          },
          { id: "name", optional: true },
        ],
      },
      override: {
        apis: (originalImplementation) => ({
          ...originalImplementation,
          signUpPOST: async (input) => {
            if (!originalImplementation.signUpPOST) {
              throw new Error("signUpPOST not available");
            }

            // Pre-check: reject if email already claimed by another customer
            // (case-insensitive to prevent bypass via casing)
            if (config.db) {
              const emailField = input.formFields.find((f) => f.id === "email");
              if (emailField) {
                const existingByEmail = await config.db
                  .select({ id: customer.id })
                  .from(customer)
                  .where(
                    eq(sql`lower(${customer.email})`, sql`lower(${emailField.value as string})`),
                  )
                  .limit(1);

                if (existingByEmail.length > 0) {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "ERR_EMAIL_CONFLICT",
                  };
                }
              }
            }

            const response = await originalImplementation.signUpPOST(input);

            // Transform SuperTokens' native duplicate detection to consistent error
            if (response.status === "EMAIL_ALREADY_EXISTS_ERROR") {
              return {
                status: "GENERAL_ERROR" as const,
                message: "ERR_EMAIL_CONFLICT",
              };
            }

            if (response.status === "OK" && config.db) {
              const userId = response.user.id;
              const email = response.user.emails[0];

              // Create customer record linked to the SuperTokens user
              await config.db
                .insert(customer)
                .values({
                  authSubject: userId,
                  email,
                  status: "active",
                })
                .onConflictDoNothing();
            }

            return response;
          },
        }),
      },
    }),
    EmailVerification.init({
      mode: "REQUIRED",
      override: {
        apis: (originalImplementation) => ({
          ...originalImplementation,
          verifyEmailPOST: async (input) => {
            if (!originalImplementation.verifyEmailPOST) {
              throw new Error("verifyEmailPOST not available");
            }

            const response = await originalImplementation.verifyEmailPOST(input);

            if (response.status === "OK" && config.db) {
              const email = response.user.email;
              const userId = response.user.recipeUserId.getAsString();

              // Check if another customer already has this email verified
              const existingCustomers = await config.db
                .select({ id: customer.id, authSubject: customer.authSubject })
                .from(customer)
                .where(and(eq(customer.email, email), ne(customer.authSubject, userId)))
                .limit(1);

              if (existingCustomers.length > 0) {
                // Another account already owns this email — unverify and reject
                await EmailVerification.unverifyEmail(supertokens.convertToRecipeUserId(userId));

                // Queue admin alert
                if (config.adminAlertService) {
                  config.adminAlertService.queue({
                    type: "email_conflict",
                    orderId: "",
                    message: `Duplicate email verification attempt: ${email} is already claimed by customer ${existingCustomers[0].id}`,
                    details: {
                      email,
                      claimingAuthSubject: userId,
                      existingCustomerId: existingCustomers[0].id,
                      existingAuthSubject: existingCustomers[0].authSubject,
                    },
                  });
                }

                return {
                  status: "GENERAL_ERROR" as const,
                  message: "ERR_EMAIL_ALREADY_CLAIMED",
                };
              }

              // No conflict — link guest orders
              const cust = await getCustomerByAuthSubject(config.db, userId);
              if (cust) {
                await linkGuestOrdersByEmail(config.db, email, cust.id);
              }
            }

            return response;
          },
        }),
      },
    }),
    ThirdParty.init({
      signInAndUpFeature: {
        providers: config.githubOAuth
          ? [
              {
                config: {
                  thirdPartyId: "github",
                  clients: [
                    {
                      clientId: config.githubOAuth.clientId,
                      clientSecret: config.githubOAuth.clientSecret,
                    },
                  ],
                },
              },
            ]
          : [],
      },
    }),
    Session.init(),
  ];

  supertokens.init({
    framework: "custom",
    supertokens: {
      connectionURI: config.connectionUri,
      apiKey: config.apiKey,
    },
    appInfo: {
      appName: config.appName,
      apiDomain: config.apiDomain,
      websiteDomain: config.websiteDomain,
      apiBasePath: "/auth",
      websiteBasePath: "/auth",
    },
    recipeList,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a SuperTokens user has a verified email.
 */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const result = await EmailVerification.isEmailVerified(supertokens.convertToRecipeUserId(userId));
  return result;
}

/**
 * Looks up the customer record by SuperTokens auth_subject.
 */
export async function getCustomerByAuthSubject(
  db: PostgresJsDatabase,
  authSubject: string,
): Promise<{ id: string; email: string; status: string; githubUserId: string | null } | undefined> {
  const rows = await db
    .select({
      id: customer.id,
      email: customer.email,
      status: customer.status,
      githubUserId: customer.githubUserId,
    })
    .from(customer)
    .where(eq(customer.authSubject, authSubject))
    .limit(1);
  return rows[0];
}

/**
 * Links a GitHub user ID to a customer record.
 * Returns the updated customer, or null if the github_user_id is already taken.
 */
export async function linkGitHubToCustomer(
  db: PostgresJsDatabase,
  customerId: string,
  githubUserId: string,
): Promise<{ id: string; githubUserId: string | null } | null> {
  // Check if this github_user_id is already linked to another customer
  const existing = await db
    .select({ id: customer.id })
    .from(customer)
    .where(eq(customer.githubUserId, githubUserId))
    .limit(1);

  if (existing.length > 0 && existing[0].id !== customerId) {
    return null; // Already linked to a different customer
  }

  const rows = await db
    .update(customer)
    .set({ githubUserId, updatedAt: new Date() })
    .where(eq(customer.id, customerId))
    .returning({ id: customer.id, githubUserId: customer.githubUserId });

  return rows[0] ?? null;
}

export async function unlinkGitHubFromCustomer(
  db: PostgresJsDatabase,
  customerId: string,
): Promise<{ id: string; githubUserId: string | null } | null> {
  const rows = await db
    .update(customer)
    .set({ githubUserId: null, updatedAt: new Date() })
    .where(eq(customer.id, customerId))
    .returning({ id: customer.id, githubUserId: customer.githubUserId });

  return rows[0] ?? null;
}

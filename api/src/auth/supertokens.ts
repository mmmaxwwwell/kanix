import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session/index.js";
import EmailPassword from "supertokens-node/recipe/emailpassword/index.js";
import EmailVerification from "supertokens-node/recipe/emailverification/index.js";
import type { TypeInput } from "supertokens-node/types";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { customer } from "../db/schema/customer.js";

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
        ],
      },
      override: {
        apis: (originalImplementation) => ({
          ...originalImplementation,
          signUpPOST: async (input) => {
            if (!originalImplementation.signUpPOST) {
              throw new Error("signUpPOST not available");
            }

            const response = await originalImplementation.signUpPOST(input);

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
): Promise<{ id: string; email: string; status: string } | undefined> {
  const rows = await db
    .select({ id: customer.id, email: customer.email, status: customer.status })
    .from(customer)
    .where(eq(customer.authSubject, authSubject))
    .limit(1);
  return rows[0];
}

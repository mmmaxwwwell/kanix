export {
  initSuperTokens,
  isEmailVerified,
  getCustomerByAuthSubject,
  linkGitHubToCustomer,
} from "./supertokens.js";
export type { SuperTokensConfig } from "./supertokens.js";
export { registerAuthMiddleware, verifySession, requireVerifiedEmail } from "./middleware.js";
export { createGitHubUserFetcher } from "./github.js";
export type { GitHubUser, GitHubUserFetcher } from "./github.js";

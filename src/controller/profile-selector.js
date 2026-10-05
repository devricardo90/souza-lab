/**
 * Explicit profile selection for the Controller CLI. There is NO default profile and NO fallback: the profile named in the
 * configuration is the one built, and anything else (missing, misspelled, or "production" with a bad config) fails closed with
 * CONFIG_INVALID. A production failure can therefore never degrade into synthetic mode.
 * The synthetic builder is imported only on the "synthetic" branch, so the production path never loads src/testing/.
 */
export const PROFILES = Object.freeze(["synthetic", "production"]);

export async function buildControllerForProfile(config, env = process.env, overrides = {}) {
  const profile = config?.profile;
  if (profile === "production") {
    const { buildProductionController } = await import("../composition/production-profile.js");
    return buildProductionController(config, env, overrides);
  }
  if (profile === "synthetic") {
    const { buildSyntheticController } = await import("../testing/synthetic-profile.js");
    return buildSyntheticController(config, env, overrides);
  }
  throw Object.assign(new Error(`config.profile must be one of ${PROFILES.join(", ")} (got ${JSON.stringify(profile ?? null)}); there is no default profile`), { code: "CONFIG_INVALID" });
}

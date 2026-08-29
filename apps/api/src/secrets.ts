import { SecretBox } from "@app/security";
import { env } from "./env.js";

/**
 * Envelope encryption for BYOK secrets. Only the sealed reference is stored
 * in Postgres; plaintext exists in memory solely during a provider call.
 */
export const secretBox = new SecretBox(env.secretMasterKey);


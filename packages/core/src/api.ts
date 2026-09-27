/**
 * The Core package re-exports the SDK's UI-independent API descriptor so the
 * gateway and consumers cannot drift into two capability vocabularies.
 */

export type {
  PlatformApiDescriptor,
  StandardApiCapability,
} from "@inquiry-platform/sdk";
export {
  PLATFORM_API_VERSION,
  platformApiDescriptor,
  standardApiCapabilities,
} from "@inquiry-platform/sdk";

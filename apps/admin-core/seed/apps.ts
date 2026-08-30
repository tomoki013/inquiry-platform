import type { CreateAppInput } from "@tomokichi/admin-contracts";

/**
 * The apps the Studio runs today.
 *
 * Every value here was read out of the repositories rather than guessed:
 * bundle ids from each project's `project.yml`, brand URLs from
 * `packages/app-site/src/urls.ts`, App Store ids from the brand sites'
 * `appStoreHref`. Remeet has no App Store URL because Remeet is not on the App
 * Store — leaving the field empty is the honest state, and inventing a
 * plausible id would put a dead link in the admin screen.
 */
export const seedApps: (CreateAppInput & {
  links?: { type: string; label: string; url: string }[];
})[] = [
  {
    slug: "remeet",
    name: "Remeet",
    platform: "ios",
    status: "testflight",
    description: "会えない時間を、ふたりで持っておくためのアプリ。",
    bundleId: "io.tmkch.remeet",
    publicUrl: "https://remeet.tmkch.io",
    supportUrl: "https://tmkch.io/support",
    links: [
      { type: "brand", label: "Brand site", url: "https://remeet.tmkch.io" },
      { type: "privacy", label: "Privacy", url: "https://remeet.tmkch.io/privacy" },
      { type: "terms", label: "Terms", url: "https://remeet.tmkch.io/terms" },
    ],
  },
  {
    slug: "colorvia",
    name: "Colorvia",
    platform: "ios",
    status: "live",
    bundleId: "io.tmkch.colorvia",
    publicUrl: "https://colorvia.tmkch.io",
    supportUrl: "https://tmkch.io/support",
    appStoreUrl: "https://apps.apple.com/app/id6798378768",
    links: [
      { type: "brand", label: "Brand site", url: "https://colorvia.tmkch.io" },
      { type: "app_store", label: "App Store", url: "https://apps.apple.com/app/id6798378768" },
    ],
  },
  {
    slug: "yohaku",
    name: "Yohaku",
    platform: "ios",
    status: "live",
    bundleId: "io.tmkch.yohaku",
    publicUrl: "https://yohaku.tmkch.io",
    supportUrl: "https://tmkch.io/support",
    appStoreUrl: "https://apps.apple.com/app/id6798718923",
    links: [
      { type: "brand", label: "Brand site", url: "https://yohaku.tmkch.io" },
      { type: "app_store", label: "App Store", url: "https://apps.apple.com/app/id6798718923" },
    ],
  },
];

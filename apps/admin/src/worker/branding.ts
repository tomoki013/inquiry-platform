import { type ConsoleProfile, consoleAppName } from "@inquiry-platform/core";

/**
 * Puts the deployment's name on the parts of the console that are static
 * files: the PWA manifest and the HTML shell.
 *
 * The built assets carry a neutral "Admin", so a build is the same for every
 * deployment; the name comes from Core (`BRANDING` on the API Worker) at the
 * moment a file is served. Only the name is used here, which is what makes it
 * safe on the manifest — the one path served before sign-in.
 */
export async function brandManifest(asset: Response, profile: ConsoleProfile): Promise<Response> {
  if (!asset.ok) return asset;
  const manifest = (await asset.json()) as Record<string, unknown>;
  const names = consoleAppName(profile);
  const headers = new Headers(asset.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(
    JSON.stringify({
      ...manifest,
      name: names.name,
      short_name: names.shortName,
      description: `${profile.consoleName} の問い合わせ・通報・運用を扱う管理画面`,
    }),
    { status: asset.status, headers },
  );
}

/** The `<title>` and the iOS home-screen label, on any HTML response. */
export function brandHtml(asset: Response, profile: ConsoleProfile): Response {
  if (!asset.headers.get("Content-Type")?.includes("text/html")) return asset;
  const names = consoleAppName(profile);
  return new HTMLRewriter()
    .on("title", {
      element(element) {
        element.setInnerContent(names.name);
      },
    })
    .on('meta[name="apple-mobile-web-app-title"]', {
      element(element) {
        element.setAttribute("content", names.shortName);
      },
    })
    .transform(asset);
}

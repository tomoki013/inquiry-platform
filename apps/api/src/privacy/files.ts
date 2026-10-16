import type { PrivateCipher } from "./crypto";

const encode = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
/** Encrypt body, original HTTP metadata and private custom metadata together.
 * R2 still owns transport/disk encryption; this key remains in Worker Secrets. */
export function privateBucket(raw: R2Bucket, cipher?: PrivateCipher): R2Bucket {
  if (!cipher) return raw;
  async function metadata(object: R2Object, key: string) {
    if (object.customMetadata?.privateStorage !== "v1") return null;
    const envelope = object.customMetadata.privateMetadata;
    if (!envelope) throw new Error("PrivateFileMetadataMissing");
    return JSON.parse(await cipher!.open(envelope, `file-metadata:${key}`)) as {
      size: number;
      httpMetadata: R2HTTPMetadata;
      customMetadata: Record<string, string>;
    };
  }
  return new Proxy(raw, {
    get(target, name) {
      if (name === "put")
        return async (
          key: string,
          value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
          options?: R2PutOptions,
        ) => {
          const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
          const content = await cipher.seal(encode(bytes), `file:${key}`);
          const meta = await cipher.seal(
            JSON.stringify({
              size: bytes.length,
              httpMetadata: options?.httpMetadata ?? {},
              customMetadata: options?.customMetadata ?? {},
            }),
            `file-metadata:${key}`,
          );
          return target.put(key, content, {
            ...options,
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: {
              privateStorage: "v1",
              privateMetadata: meta,
              ...(options?.customMetadata?.createdAt
                ? { createdAt: options.customMetadata.createdAt }
                : {}),
              ...(options?.customMetadata?.projectSlug
                ? { projectSlug: options.customMetadata.projectSlug }
                : {}),
            },
          });
        };
      if (name === "get")
        return async (key: string, options?: R2GetOptions) => {
          if (options?.range) throw new Error("PrivateRangeUnsupported");
          const object = await target.get(key, options);
          if (!object || !("body" in object)) return object;
          const meta = await metadata(object, key);
          if (!meta) return object;
          const bytes = decode(await cipher.open(await object.text(), `file:${key}`));
          return new Proxy(object, {
            get(o, p) {
              if (p === "size") return bytes.length;
              if (p === "httpMetadata") return meta.httpMetadata;
              if (p === "customMetadata") return meta.customMetadata;
              if (p === "body") return new Blob([bytes]).stream();
              if (p === "arrayBuffer")
                return async () =>
                  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
              if (p === "text") return async () => new TextDecoder().decode(bytes);
              if (p === "json") return async () => JSON.parse(new TextDecoder().decode(bytes));
              if (p === "writeHttpMetadata")
                return (headers: Headers) => {
                  for (const [k, v] of Object.entries(meta.httpMetadata)) {
                    if (k === "contentType") headers.set("content-type", v as string);
                  }
                };
              const v = Reflect.get(o, p, o);
              return typeof v === "function" ? v.bind(o) : v;
            },
          });
        };
      if (name === "head")
        return async (key: string) => {
          const object = await target.head(key);
          if (!object) return null;
          const meta = await metadata(object, key);
          return meta
            ? new Proxy(object, {
                get(o, p) {
                  if (p === "size") return meta.size;
                  if (p === "customMetadata") return meta.customMetadata;
                  if (p === "httpMetadata") return meta.httpMetadata;
                  const v = Reflect.get(o, p, o);
                  return typeof v === "function" ? v.bind(o) : v;
                },
              })
            : object;
        };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Etchv } from "@etchv-labs/sdk";
import { CloudinaryClient } from "./cloudinary.ts";
import { createHandler, MAX_NOTIFICATION_BYTES } from "./handler.ts";
import type { SignatureAlgorithm } from "./signature.ts";
import { VERSION } from "./version.ts";

/** Identifies this integration to the Etchv API, ahead of the SDK's own User-Agent. */
export const USER_AGENT = `etchv-cloudinary/${VERSION}`;

/** A fetch that puts this integration's name at the front of the User-Agent. */
export function identifiedFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", [USER_AGENT, headers.get("User-Agent")].filter(Boolean).join(" "));
    return fetcher(input, { ...init, headers });
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

/** Build the request handler from environment variables (see README). */
export function handlerFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const algorithm = (env.CLOUDINARY_SIGNATURE_ALGORITHM?.trim() || "sha1") as SignatureAlgorithm;
  if (algorithm !== "sha1" && algorithm !== "sha256") throw new Error("CLOUDINARY_SIGNATURE_ALGORITHM must be sha1 or sha256.");
  const apiSecret = required(env, "CLOUDINARY_API_SECRET");
  const etchv = new Etchv({
    apiKey: required(env, "ETCHV_API_KEY"),
    baseUrl: env.ETCHV_BASE_URL || undefined,
    fetch: identifiedFetch(),
  });
  const cloudinary = new CloudinaryClient({
    cloudName: required(env, "CLOUDINARY_CLOUD_NAME"),
    apiKey: required(env, "CLOUDINARY_API_KEY"),
    apiSecret,
    apiOrigin: env.CLOUDINARY_API_ORIGIN || undefined,
  });
  return createHandler({
    webhookSecret: env.CLOUDINARY_WEBHOOK_SECRET?.trim() || apiSecret,
    signatureAlgorithm: algorithm,
    defaultDelivery: required(env, "ETCHV_DELIVERY"),
    publicIdSuffix: env.ETCHV_PUBLIC_ID_SUFFIX || undefined,
  }, { etchv, cloudinary });
}

/** Adapt a fetch-style handler to Node's HTTP server. */
export function nodeListener(handle: (request: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).byteLength;
        if (size > MAX_NOTIFICATION_BYTES) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await handle(new Request(`http://localhost${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(`etchv-cloudinary: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 8080);
  createServer(nodeListener(handlerFromEnv())).listen(port, () => {
    console.info(`etchv-cloudinary listening on port ${port}`);
  });
}

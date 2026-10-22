// Hosted mode: the same tools as the npm package, served over MCP's
// Streamable HTTP transport, so an agent can connect with just a URL and an
// API key — no local Node or npx. Runs on the sms-florin box behind nginx
// (api.flo-voice1.com/mcp), not as part of the npm package's entry point.
//
// Unlike the local server, this one is shared by every caller, which
// changes three things:
// - Every tool needs a valid sms-florin API key, including the free email
//   ones. All calls to receivemail.dev leave from this box's single IP, so
//   without a per-key limit here one caller could spend receivemail's
//   per-IP budget for everyone.
// - Mailbox secrets are kept per API key, never in one shared map.
// - wait_for_test_sms is capped below nginx's proxy read timeout.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SmsFlorinClient, SmsFlorinError } from "sms-florin";
import { API_KEY_URL, type MailboxSecrets, RateLimitError, SIGNUP_URL, VERSION, buildServer } from "./tools.js";
import { PersistentUsageStoreRegistry } from "@sms-florin/mcpmeter";

const PORT = Number(process.env.PORT ?? 3902);
// Calls the sms-florin app over loopback: the public hostname is behind
// Cloudflare, whose bot protection challenges non-browser clients.
const SMS_FLORIN_BASE_URL = process.env.SMS_FLORIN_BASE_URL ?? "http://127.0.0.1:3000";
const RECEIVEMAIL_BASE_URL = process.env.RECEIVEMAIL_BASE_URL ?? "https://receivemail.dev";

const MAX_BODY_BYTES = 256 * 1024;
// nginx allows 150s on this route; leave headroom for the response.
const MAX_WAIT_MS = 110_000;
const REQUESTS_PER_KEY_PER_MINUTE = 60;
// Checked before the key is: otherwise a stream of made-up keys, each in
// its own bucket, would turn into one upstream key check apiece.
const REQUESTS_PER_IP_PER_MINUTE = 120;
// A wait_for_test_sms call holds its request open for up to MAX_WAIT_MS and
// polls sms-florin throughout, so a key could otherwise stack dozens of them.
const MAX_IN_FLIGHT_PER_KEY = 5;
const MIN_POLL_INTERVAL_MS = 3_000;
// receivemail allows 20 creates/minute per IP, and every hosted caller
// shares this box's IP.
const MAILBOXES_PER_KEY_PER_MINUTE = 5;
const KEY_CHECK_TTL_MS = 10 * 60 * 1000;
const MAILBOX_SECRET_TTL_MS = 65 * 60 * 1000; // mailboxes live at most 60 minutes

const MINUTE_MS = 60 * 1000;

// Kept outside the app directory on purpose: deploys rsync --delete into
// the app directory, which would wipe the counts on every release.
const USAGE_FILE = process.env.USAGE_FILE ?? join(homedir(), ".agent-identity-mcp", "usage.json");
const USAGE_SAVE_INTERVAL_MS = 60 * 1000;
// Only hashed keys ever reach the file — never the API key itself.
const usage = new PersistentUsageStoreRegistry(USAGE_FILE);

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Fixed-window counters, in memory: a restart only resets them, and the
// upstream limits (sms-florin per account, receivemail per IP and per day)
// still hold.
const counters = new Map<string, { windowStart: number; count: number }>();
function allow(bucket: string, max: number): boolean {
  const now = Date.now();
  const entry = counters.get(bucket);
  if (!entry || now - entry.windowStart >= MINUTE_MS) {
    counters.set(bucket, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

// A key is checked against sms-florin once, then trusted for a while —
// otherwise every tool call would cost an extra upstream request.
const verifiedKeys = new Map<string, number>();
async function isValidKey(client: SmsFlorinClient, keyHash: string): Promise<boolean> {
  const verifiedAt = verifiedKeys.get(keyHash);
  if (verifiedAt !== undefined && Date.now() - verifiedAt < KEY_CHECK_TTL_MS) return true;
  try {
    await client.listServices();
  } catch (error) {
    if (error instanceof SmsFlorinError && error.status === 401) return false;
    throw error;
  }
  verifiedKeys.set(keyHash, Date.now());
  return true;
}

// Mailbox secrets per API key hash. Each entry remembers when it was created
// so expired mailboxes don't pile up for the life of the process.
const secretsByKey = new Map<string, { secrets: Map<string, string>; createdAt: Map<string, number> }>();
function mailboxSecretsFor(keyHash: string): MailboxSecrets {
  let owner = secretsByKey.get(keyHash);
  if (!owner) {
    owner = { secrets: new Map(), createdAt: new Map() };
    secretsByKey.set(keyHash, owner);
  }
  const { secrets, createdAt } = owner;
  // Record creation times as the tools write secrets in.
  return {
    get: (address) => secrets.get(address),
    set: (address, secret) => {
      secrets.set(address, secret);
      createdAt.set(address, Date.now());
    },
  };
}

function sweep() {
  const now = Date.now();
  for (const [bucket, entry] of counters) {
    if (now - entry.windowStart >= MINUTE_MS) counters.delete(bucket);
  }
  for (const [keyHash, verifiedAt] of verifiedKeys) {
    if (now - verifiedAt >= KEY_CHECK_TTL_MS) verifiedKeys.delete(keyHash);
  }
  for (const [keyHash, owner] of secretsByKey) {
    for (const [address, createdAt] of owner.createdAt) {
      if (now - createdAt >= MAILBOX_SECRET_TTL_MS) {
        owner.createdAt.delete(address);
        owner.secrets.delete(address);
      }
    }
    if (owner.secrets.size === 0) secretsByKey.delete(keyHash);
  }
  usage.prune();
}
setInterval(sweep, MINUTE_MS).unref();
setInterval(() => void usage.save(), USAGE_SAVE_INTERVAL_MS).unref();

const inFlight = new Map<string, number>();

// nginx sets X-Real-IP from the TCP peer, and this server only listens on
// loopback, so the header can't come from anyone but nginx.
function clientIp(req: IncomingMessage): string {
  const realIp = req.headers["x-real-ip"];
  return (typeof realIp === "string" && realIp) || req.socket.remoteAddress || "unknown";
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// JSON-RPC shaped so MCP clients surface the message instead of a bare status.
function sendRpcError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= 200 ? token : undefined;
}

const NO_KEY_MESSAGE = [
  "This hosted server needs an sms-florin API key, sent as \"Authorization: Bearer <key>\". Please tell the user:",
  `1. Create a free account at ${SIGNUP_URL}`,
  `2. Create an API key at ${API_KEY_URL} and add it to this MCP server's connection settings.`,
  "The email tools are free with any valid key; renting a phone number needs account balance.",
].join("\n");

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  // Stateless: every request is a complete JSON-RPC exchange, so there is no
  // session to resume with GET or end with DELETE.
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  if (!allow(`ip:${clientIp(req)}`, REQUESTS_PER_IP_PER_MINUTE)) {
    return sendRpcError(res, 429, "Rate limited — too many requests, try again in a minute.");
  }
  const apiKey = bearerToken(req);
  if (!apiKey) return sendRpcError(res, 401, NO_KEY_MESSAGE);
  const keyHash = hashKey(apiKey);
  if (!allow(`req:${keyHash}`, REQUESTS_PER_KEY_PER_MINUTE)) {
    return sendRpcError(res, 429, "Rate limited — too many requests for this API key, try again in a minute.");
  }
  const running = inFlight.get(keyHash) ?? 0;
  if (running >= MAX_IN_FLIGHT_PER_KEY) {
    return sendRpcError(res, 429, "Too many requests in progress for this API key — wait for one to finish.");
  }
  inFlight.set(keyHash, running + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(keyHash) ?? 1) - 1;
    if (left <= 0) inFlight.delete(keyHash);
    else inFlight.set(keyHash, left);
  };
  // "close" fires once the response is done or the client goes away,
  // whichever path this request takes below.
  res.on("close", release);

  const client = new SmsFlorinClient(apiKey, {
    baseUrl: SMS_FLORIN_BASE_URL,
    userAgent: `agent-identity-mcp-hosted/${VERSION}`,
  });
  try {
    if (!(await isValidKey(client, keyHash))) {
      return sendRpcError(res, 401, `The API key was rejected. Create a new one at ${API_KEY_URL}.`);
    }
  } catch (error) {
    console.error("key check failed:", error);
    return sendRpcError(res, 503, "Could not verify the API key right now, try again shortly.");
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendRpcError(res, 400, "Request body must be JSON, at most 256 KB.");
  }

  const server = buildServer({
    getSmsClient: () => client,
    siteBaseUrl: SMS_FLORIN_BASE_URL,
    mailboxSecrets: mailboxSecretsFor(keyHash),
    receivemailBaseUrl: RECEIVEMAIL_BASE_URL,
    maxWaitMs: MAX_WAIT_MS,
    minIntervalMs: MIN_POLL_INTERVAL_MS,
    beforeCreateMailbox: () => {
      if (!allow(`mailbox:${keyHash}`, MAILBOXES_PER_KEY_PER_MINUTE)) {
        throw new RateLimitError("Too many test mailboxes created in the last minute for this API key, try again shortly.");
      }
    },
    // Scoped to this key's hash, so a caller only ever sees its own counts.
    logUsage: (toolName, opts) => usage.record(keyHash, toolName, opts),
    getClient: () => String(req.headers["user-agent"] ?? "").split(/[\s/]/)[0].slice(0, 40) || undefined,
    getUsageStats: () => usage.for(keyHash).stats(),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const handler =
    path === "/mcp"
      ? handleMcp(req, res)
      : path === "/mcp/health"
        ? Promise.resolve(sendJson(res, 200, { ok: true, version: VERSION }))
        : Promise.resolve(sendJson(res, 404, { error: "not found" }));
  handler.catch((error) => {
    // Never echo the error: it can carry upstream detail. Log it here instead.
    console.error("request failed:", error);
    if (!res.headersSent) sendRpcError(res, 500, "Internal error.");
    else res.end();
  });
});

// Flush pending counts on a PM2 restart/stop instead of losing up to a
// minute of them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void usage.save().finally(() => process.exit(0));
  });
}

await usage.load();
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`agent-identity-mcp hosted server listening on 127.0.0.1:${PORT}`);
});

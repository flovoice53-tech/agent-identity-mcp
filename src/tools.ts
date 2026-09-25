import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SmsFlorinClient, SmsFlorinError } from "sms-florin";
import { z } from "zod";

export const VERSION = "0.1.4";
export const SIGNUP_URL = "https://flo-voice1.com/register";
export const API_KEY_URL = "https://flo-voice1.com/api-access";
export const TOP_UP_URL = "https://flo-voice1.com/topup";

export class ReceivemailError extends Error {}
export class ConfigError extends Error {}
export class RateLimitError extends Error {}

// Per-mailbox secrets returned at creation time, kept so a caller doesn't
// have to pass the secret back on every read. Scoped to one owner: locally
// that's the single user running the process; on the hosted server it's one
// API key, so one caller can never read another caller's mailbox by address.
export interface MailboxSecrets {
  get(address: string): string | undefined;
  set(address: string, secret: string): void;
}

export interface ToolDeps {
  getSmsClient: () => SmsFlorinClient;
  // sms-florin's own site, for the eSIM tools (public endpoints, no key).
  siteBaseUrl: string;
  mailboxSecrets: MailboxSecrets;
  receivemailBaseUrl: string;
  // Admin-only token, never set on the hosted server.
  receivemailToken?: string;
  // Throws RateLimitError when the caller may not create another mailbox.
  beforeCreateMailbox?: () => void;
  // Upper bound on how long wait_for_test_sms may block. The hosted server
  // lowers it to stay inside its proxy's read timeout.
  maxWaitMs?: number;
  // Lower bound on wait_for_test_sms's poll interval.
  minIntervalMs?: number;
}

async function createTestMailbox(deps: ToolDeps, ttlMinutes: number) {
  deps.beforeCreateMailbox?.();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.receivemailToken) headers.authorization = `Bearer ${deps.receivemailToken}`;

  const res = await fetch(`${deps.receivemailBaseUrl}/mailboxes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ttlMinutes }),
  });
  if (!res.ok) {
    throw new ReceivemailError(`Failed to create mailbox: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { address: string; expiresAt: string; secret: string };
  deps.mailboxSecrets.set(data.address, data.secret);
  return { address: data.address, expiresAt: data.expiresAt };
}

async function getTestMailboxMessages(deps: ToolDeps, address: string) {
  const secret = deps.mailboxSecrets.get(address);
  if (!secret) {
    throw new ReceivemailError(
      `No secret on file for ${address} — it must have been created with create_test_email by this same caller.`,
    );
  }
  const res = await fetch(`${deps.receivemailBaseUrl}/mailboxes/${encodeURIComponent(address)}/messages`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    throw new ReceivemailError(`Failed to fetch messages: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

class EsimError extends Error {}

// The same two public endpoints the /esim page's WebMCP tools use. Data-only
// eSIMs: no number, no SMS — kept distinct from the phone tools above.
async function listEsimPlans(deps: ToolDeps) {
  const res = await fetch(`${deps.siteBaseUrl}/api/v1/esim-catalog`);
  if (!res.ok) throw new EsimError(`Could not load eSIM plans: ${res.status}`);
  return res.json();
}

async function getEsimCheckoutLink(deps: ToolDeps, slug: string) {
  const res = await fetch(`${deps.siteBaseUrl}/api/v1/esim-checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const data = (await res.json().catch(() => null)) as { checkoutUrl?: string; error?: string } | null;
  if (!res.ok || !data?.checkoutUrl) {
    throw new EsimError(data?.error ?? `Could not start checkout: ${res.status}`);
  }
  return {
    checkoutUrl: data.checkoutUrl,
    note: "Give this link to the user: they pay on Stripe themselves. Nothing is charged until they enter card details, and the eSIM is emailed to the address they enter there.",
  };
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// The two sms-florin failures a caller can fix themselves get a next step
// the agent can pass on; everything else is shown as the API returned it.
function smsFlorinHint(error: SmsFlorinError): string | undefined {
  if (error.code === "insufficient_balance") {
    return `The account balance is too low for this rental. Ask the user to top up at ${error.topUpUrl ?? TOP_UP_URL}.`;
  }
  if (error.status === 401) {
    return `The API key was rejected. Ask the user to check SMS_FLORIN_API_KEY or create a new one at ${API_KEY_URL}.`;
  }
  return undefined;
}

function errorText(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof SmsFlorinError ? smsFlorinHint(error) : undefined;
  if (hint) message += `\n${hint}`;
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "agent-identity-mcp", version: VERSION });
  const maxWaitMs = deps.maxWaitMs ?? Number.POSITIVE_INFINITY;
  const minIntervalMs = deps.minIntervalMs ?? 1_000;

  server.registerTool(
    "create_test_email",
    {
      title: "Create a disposable test email address",
      description:
        "Get a fresh, real email address that can receive mail for a short time — use it to sign up for something you're testing, then call get_test_email_messages to read what arrives.",
      inputSchema: {
        ttlMinutes: z
          .number()
          .int()
          .positive()
          .max(60)
          .default(15)
          .describe("How long the address stays valid, in minutes (max 60)."),
      },
    },
    async ({ ttlMinutes }) => {
      try {
        return text(await createTestMailbox(deps, ttlMinutes));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_test_email_messages",
    {
      title: "Read messages for a test email address",
      description: "Get the messages received so far on an address created with create_test_email.",
      inputSchema: {
        address: z.string().describe("The address returned by create_test_email."),
      },
    },
    async ({ address }) => {
      try {
        return text(await getTestMailboxMessages(deps, address));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List phone-verification services",
      description:
        "List the services a real UK phone number can be rented for (WhatsApp, Telegram, Google, Discord, etc.), with prices.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await deps.getSmsClient().listServices());
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "rent_test_phone_number",
    {
      title: "Rent a real test phone number",
      description:
        "Rent a real UK phone number for a given service so it can receive an SMS/OTP verification code. Debits the account balance. Returns a rentalId to check with wait_for_test_sms.",
      inputSchema: {
        serviceSlug: z
          .string()
          .describe('Service slug from list_services, e.g. "whatsapp", "google", "discord".'),
        period: z
          .enum(["instant", "monthly"])
          .default("instant")
          .describe("instant = one-time rental for a single code; monthly = keep the number for a month."),
      },
    },
    async ({ serviceSlug, period }) => {
      try {
        return text(await deps.getSmsClient().rentNumber(serviceSlug, period));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "wait_for_test_sms",
    {
      title: "Wait for the SMS/OTP code",
      description:
        "Block until the first SMS/OTP code arrives on a phone rental, or time out. If it times out, call it again — the rental keeps receiving until it expires.",
      inputSchema: {
        rentalId: z.number().int().describe("The rentalId returned by rent_test_phone_number."),
        timeoutMs: z.number().int().positive().default(120_000).describe("Max time to wait, in ms."),
        intervalMs: z.number().int().positive().default(3_000).describe("Poll interval, in ms."),
      },
    },
    async ({ rentalId, timeoutMs, intervalMs }) => {
      try {
        return text(
          await deps.getSmsClient().waitForSms(rentalId, {
            timeoutMs: Math.min(timeoutMs, maxWaitMs),
            intervalMs: Math.max(intervalMs, minIntervalMs),
          }),
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "list_esim_plans",
    {
      title: "List travel eSIM data plans",
      description:
        "List the travel eSIM data plans on sale (country, data amount, duration in days, price in USD cents). Data only — an eSIM has no phone number and cannot receive SMS codes; use rent_test_phone_number for that.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await listEsimPlans(deps));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_esim_checkout_link",
    {
      title: "Get a checkout link for an eSIM plan",
      description:
        "Get a Stripe checkout link for one eSIM plan, to hand to the user. It does not buy anything: the user pays on the Stripe page themselves and receives the eSIM by email.",
      inputSchema: {
        slug: z.string().max(60).describe('Plan slug from list_esim_plans, e.g. "uk-1gb-7d".'),
      },
    },
    async ({ slug }) => {
      try {
        return text(await getEsimCheckoutLink(deps, slug));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  return server;
}

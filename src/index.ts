#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SmsFlorinClient, SmsFlorinError } from "sms-florin";
import { z } from "zod";

const VERSION = "0.1.3";
const SIGNUP_URL = "https://flo-voice1.com/register";
const API_KEY_URL = "https://flo-voice1.com/api-access";
const TOP_UP_URL = "https://flo-voice1.com/topup";

// SMS_FLORIN_API_KEY is only needed for the phone-number tools
// (list_services, rent_test_phone_number, wait_for_test_sms). The email
// tools (create_test_email, get_test_email_messages) hit receivemail.dev's
// public/self-serve mailbox creation and need no credential at all, so the
// server must not refuse to start just because this env var is absent —
// only the phone tools should fail, and only when actually called.
let smsClient: SmsFlorinClient | undefined;
function getSmsClient(): SmsFlorinClient {
  const smsFlorinApiKey = process.env.SMS_FLORIN_API_KEY;
  if (!smsFlorinApiKey) {
    // The first thing a new user sees from the phone tools, so it has to say
    // how to get going, not just what's missing. Tell the agent to relay it:
    // only the human can sign up and pay.
    throw new ConfigError(
      [
        "The phone tools need an sms-florin API key (SMS_FLORIN_API_KEY), which isn't set. Please tell the user:",
        `1. Create a free account at ${SIGNUP_URL}`,
        `2. Add balance at ${TOP_UP_URL} — a number costs from 0.80 EUR, and a first top-up of 5 EUR or more gets 1 EUR extra.`,
        `3. Create an API key at ${API_KEY_URL} and set it as SMS_FLORIN_API_KEY in this MCP server's config.`,
        "The email tools (create_test_email, get_test_email_messages) are free and work without a key.",
      ].join("\n"),
    );
  }
  if (!smsClient) {
    smsClient = new SmsFlorinClient(smsFlorinApiKey, {
      baseUrl: process.env.SMS_FLORIN_BASE_URL,
      userAgent: `agent-identity-mcp/${VERSION}`,
    });
  }
  return smsClient;
}

// receivemail.dev's mailbox creation is public/self-serve — no token needed.
// RECEIVEMAIL_API_TOKEN is optional, admin-only (Florin's own debugging).
const receivemailToken = process.env.RECEIVEMAIL_API_TOKEN;

const receivemailBaseUrl = process.env.RECEIVEMAIL_BASE_URL ?? "https://receivemail.dev";

// Per-mailbox secrets returned at creation time, kept in memory for this
// server's lifetime so a caller doesn't have to pass the secret back on
// every read — fine for short-TTL (max 60min) disposable mailboxes.
const mailboxSecrets = new Map<string, string>();

class ReceivemailError extends Error {}
class ConfigError extends Error {}

async function createTestMailbox(ttlMinutes: number) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (receivemailToken) headers.authorization = `Bearer ${receivemailToken}`;

  const res = await fetch(`${receivemailBaseUrl}/mailboxes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ttlMinutes }),
  });
  if (!res.ok) {
    throw new ReceivemailError(`Failed to create mailbox: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { address: string; expiresAt: string; secret: string };
  mailboxSecrets.set(data.address, data.secret);
  return { address: data.address, expiresAt: data.expiresAt };
}

async function getTestMailboxMessages(address: string) {
  const secret = mailboxSecrets.get(address);
  if (!secret) {
    throw new ReceivemailError(
      `No secret on file for ${address} — it must have been created with create_test_email in this same session.`,
    );
  }
  const res = await fetch(`${receivemailBaseUrl}/mailboxes/${encodeURIComponent(address)}/messages`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    throw new ReceivemailError(`Failed to fetch messages: ${res.status} ${await res.text()}`);
  }
  return res.json();
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
  let message =
    error instanceof SmsFlorinError || error instanceof ReceivemailError || error instanceof ConfigError
      ? error.message
      : String(error);
  const hint = error instanceof SmsFlorinError ? smsFlorinHint(error) : undefined;
  if (hint) message += `\n${hint}`;
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "agent-identity-mcp", version: VERSION });

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
      return text(await createTestMailbox(ttlMinutes));
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
      return text(await getTestMailboxMessages(address));
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
      return text(await getSmsClient().listServices());
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
      return text(await getSmsClient().rentNumber(serviceSlug, period));
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
      "Block until the first SMS/OTP code arrives on a phone rental, or time out.",
    inputSchema: {
      rentalId: z.number().int().describe("The rentalId returned by rent_test_phone_number."),
      timeoutMs: z.number().int().positive().default(120_000).describe("Max time to wait, in ms."),
      intervalMs: z.number().int().positive().default(3_000).describe("Poll interval, in ms."),
    },
  },
  async ({ rentalId, timeoutMs, intervalMs }) => {
    try {
      return text(await getSmsClient().waitForSms(rentalId, { timeoutMs, intervalMs }));
    } catch (error) {
      return errorText(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("agent-identity-mcp failed to start:", error);
  process.exit(1);
});

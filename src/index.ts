#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SmsFlorinClient } from "sms-florin";
import { API_KEY_URL, ConfigError, SIGNUP_URL, TOP_UP_URL, VERSION, buildServer } from "./tools.js";
import { UsageStore } from "@sms-florin/mcpmeter";

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

// Counts for this process only: nothing is written to the user's disk, so
// get_usage_stats here reports usage since the MCP client started us.
const usage = new UsageStore();

// One user per process, so one set of mailbox secrets for its lifetime —
// fine for short-TTL (max 60min) disposable mailboxes.
const server = buildServer({
  logUsage: (toolName) => usage.record(toolName),
  getUsageStats: () => usage.stats(),
  getSmsClient,
  siteBaseUrl: (process.env.SMS_FLORIN_BASE_URL ?? "https://flo-voice1.com").replace(/\/$/, ""),
  mailboxSecrets: new Map(),
  receivemailBaseUrl: process.env.RECEIVEMAIL_BASE_URL ?? "https://receivemail.dev",
  // receivemail.dev's mailbox creation is public/self-serve — no token needed.
  // RECEIVEMAIL_API_TOKEN is optional, admin-only (Florin's own debugging).
  receivemailToken: process.env.RECEIVEMAIL_API_TOKEN,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("agent-identity-mcp failed to start:", error);
  process.exit(1);
});

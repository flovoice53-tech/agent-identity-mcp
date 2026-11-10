# agent-identity-mcp

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/flovoice53-tech/agent-identity-mcp)

MCP server that gives an AI agent a throwaway test identity — a real disposable email address and a real UK phone number — so it can sign up for something it's testing and read back the verification email/SMS itself, without a human in the loop.

Bundles two existing services:
- [receivemail.dev](https://receivemail.dev) ([source](https://github.com/flovoice53-tech/receivemail-worker)) for the email side.
- [sms-florin](https://flo-voice1.com) for the phone/SMS side.

See it in use: [Signup Sandbox](https://sandbox.flo-voice1.com) is an AI agent that tests a signup flow end to end with a disposable inbox like this one and reports where it breaks (live demo).

## Status: published on npm and the official MCP registry

`create_test_email` no longer needs any receivemail.dev credential — mailbox creation is public/self-serve (rate-limited: 20/min per IP, 5,000/day total). The only credential needed is your own `SMS_FLORIN_API_KEY`, for the phone-number tools.

## Setup

```json
{
  "mcpServers": {
    "agent-identity": {
      "command": "npx",
      "args": ["-y", "agent-identity-mcp"],
      "env": {
        "SMS_FLORIN_API_KEY": "your_key_here"
      }
    }
  }
}
```

## Tools

| Tool | Description |
| --- | --- |
| `create_test_email` | Get a fresh disposable email address, valid up to 60 minutes. |
| `get_test_email_messages` | Read what's arrived on an address created above. |
| `list_services` | List services a phone number can be rented for. |
| `rent_test_phone_number` | Rent a real UK number for a service. Costs balance. |
| `wait_for_test_sms` | Block until the SMS/OTP code arrives. |
| `list_esim_plans` | List travel eSIM data plans (data only, no SMS). |
| `get_esim_checkout_link` | Get a Stripe checkout link for an eSIM plan, for the user to pay. |
| `get_usage_stats` | See how many times each tool was called — today, last 7 and last 30 days. On the hosted server it's per API key and survives restarts; locally it counts since the MCP client started the server. Failed calls aren't counted. |

## Pairs well with: acp-sandbox

Building or testing an AI shopping agent (ACP/agentic commerce)? [acp-sandbox](https://github.com/flovoice53-tech/acp-sandbox) is a hosted mock merchant your agent can complete a full test checkout against — no real store, no real money. Combined with this package, an agent gets a disposable email/phone for the buyer identity *and* a merchant to actually check out with, entirely test-side.

## Pairs well with: otp-watch

Ship your own signup/verification flow? [otp-watch](https://otpwatch.flo-voice1.com) uses the same underlying real phone numbers and disposable mailboxes to answer a different question: is your OTP/verification SMS or email actually arriving, and how fast? Point your own cron/CI at it to catch a broken delivery pipeline before your users do.

## License

MIT

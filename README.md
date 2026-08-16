# agent-identity-mcp

MCP server that gives an AI agent a throwaway test identity — a real disposable email address and a real UK phone number — so it can sign up for something it's testing and read back the verification email/SMS itself, without a human in the loop.

Bundles two existing services:
- [receivemail.dev](https://receivemail.dev) for the email side.
- [sms-florin](https://flo-voice1.com) for the phone/SMS side.

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

## License

MIT

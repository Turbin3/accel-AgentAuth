# Configuration examples

| File | For |
|---|---|
| `.mcp.json` | Claude Code, project scope: copy to the root of the project that the agent works in (`claude mcp add` also works). `${HOME}` is expanded by Claude Code. |
| `claude_desktop_config.json` | Claude Desktop: merge into your config file. Claude Desktop does not expand variables: use absolute paths. |

Notes:

- Replace the placeholders. The package is **not published to npm**; build it first (`pnpm --filter @agentauth-sol/mcp build`) and point `args` at `packages/mcp/dist/bin.js`.
- Use **separate** servers for the agent and the owner. The agent entry holds only the agent key file. The owner entry holds no key at all: it builds unsigned transactions that you sign in your own wallet.
- Do not put the owner and agent profiles in the same Claude session you hand to an untrusted workflow. A session that can build owner plans is a session that can ask you to sign them.
- The key file path goes in an environment variable, never in a tool argument. Keep the file at mode 600.

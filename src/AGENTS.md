# Bun-based TypeScript Project Source Code

> TODO: .claude/rules largely defines instructions, which should load on read files as needed.
> TODO: prefer .claude/rule to longer AGENTS.md or CLAUDE.md to capture instruction or critical information using `paths` in smaller scoped files, or code comments should reference relevant related projects files in some case => avoid context bloating large instructions <-- many narrowly targeted and scoped files always preferred
> TODO: so using this file more than a pointer is a anti-pattern

## MCP and webproxy support with Dockerfile

- MCP with OAuth/Passkeys supported (tied in with webproxy)
- webproxy support RADIUS/user-manager as auth source for proxying OAuth2 and/or Passkeys
- Available as MikroTik /app so Dockerfile build to start mcp/webproxy, which allow DDNS name which can be used for passkey support in web proxy

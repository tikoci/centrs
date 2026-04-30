---
applyTo: "src/**,test/**,package.json,bun.lock"
---

# Use Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`.
- Use `bun test` instead of Jest or Vitest.
- Use `bun build <file.html|file.ts|file.css>` instead of webpack or esbuild.
- Use `bun install` instead of `npm install`, `yarn install`, or `pnpm install`.
- Use `bun run <script>` instead of `npm run <script>`, `yarn run <script>`, or `pnpm run <script>`.
- Use `bunx <package> <command>` instead of `npx <package> <command>`.
- Bun automatically loads `.env`, so do not use `dotenv`.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Do not use Express.
- Use `bun:sqlite` for SQLite. Do not use `better-sqlite3`.
- Prefer `Bun.file` over `node:fs` read/write helpers when practical.
- Use `Bun.$` instead of `execa`.

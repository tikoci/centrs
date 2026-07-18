# `transport/provider-trust`

A warning (not an error): the target came from a named-live-provider
(`--quickchr <name>`), and centrs relaxed peer verification to use its
endpoint.

## Why this happens

quickchr's descriptor prefers the VM's TLS forwards (`https` / `api-ssl`),
whose certificate is the CHR's own self-signed one, and its SSH endpoint's
host key is regenerated per VM. The descriptor carries no trust material, so
strict verification would reject every quickchr target and force `--insecure`
ceremony onto every lab call.

Instead, centrs treats the endpoint as **trusted by provenance**: quickchr
vouches for a loopback-forwarded port (`127.0.0.1:<port>`) of a VM the user
owns, so peer verification is relaxed for exactly that connection — with
`provider` provenance on `meta.settings.insecure` and this warning on the
envelope, never silently.

## When to care

- If this warning appears on a target you did **not** select with
  `--quickchr`, that is a bug — report it.
- The relaxation never applies to CDB, literal, or env-resolved targets;
  those still require an explicit `--insecure` (which raises
  [`transport/insecure-trust`](./insecure-trust.md) instead).

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers.

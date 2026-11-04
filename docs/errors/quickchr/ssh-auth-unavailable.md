# `quickchr/ssh-auth-unavailable`

The quickchr machine forwards SSH, but its descriptor vouches for no verified
SSH key, so centrs has nothing to log in with non-interactively. centrs never
falls back to an ambient `ssh-agent` identity or a password prompt for a
provider target: an agent cannot answer a prompt, and an unrelated key would
widen trust beyond what quickchr verified.

## Typical trigger

An SSH-backed command against a `--quickchr` target whose descriptor SSH
endpoint has an empty `auth.batchModes` (or `private-key` with no
`privateKeyPath`):

- `execute --quickchr <name> --via ssh '<cli>'`
- `transfer --quickchr <name> … --via sftp`
- `terminal --quickchr <name>` (ssh is terminal's only quickchr transport)

`terminal` is stricter: it also raises this code when the only batch mode is
`agent-or-config`, because it needs a `privateKeyPath`. An interactive ssh with
no key would offer ambient agent/config identities. With the key, the console
is limited to public-key auth (`PreferredAuthentications=publickey`), so a
rejected key fails rather than prompting for a password.

A machine with no SSH service at all, or one quickchr marks unavailable, is
[`quickchr/unsupported-via`](unsupported-via.md) instead.

quickchr creates and verifies its managed key only on a machine's **first
boot** with secure login, for its auto-created `quickchr` user. A machine
started without `--secure-login` (the default), or created with `--add-user`,
has none, and a booted machine cannot gain one yet
([tikoci/quickchr#253](https://github.com/tikoci/quickchr/issues/253)).

The error context carries `machine`, `host`, `port`, `username`, `modes`,
`batchModes`, and `availableServices` (the machine's other live services), so
a caller can build the direct call below without parsing the message. When the
machine forwards `native-api` or `rest-api`, `keyInstallVia` names the one the
key-install command uses (`native-api` first).

## Fix

- **Recreate the machine with secure login**: `quickchr add … --secure-login`
  / `quickchr start <name> --secure-login` on its first boot, or
  `QuickCHR.start({ secureLogin: true })`. The descriptor then advertises
  `private-key` in `batchModes`, and `--quickchr` SSH works unchanged.
- **Or bring your own key** and target the endpoint directly. Install the
  public key over the non-SSH service in `keyInstallVia`, then dial the
  forwarded port. Pin `--via`: execute's default (`native-api`, or a
  `CENTRS_VIA` setting) may not be a service the machine forwards. With no
  `keyInstallVia`, the machine forwards no service to install a key over, and
  the remediation omits this step.

  ```sh
  centrs execute --quickchr <name> --via <keyInstallVia> '/user/ssh-keys/add user=<user> key="<public key>"' --yes
  centrs terminal --host 127.0.0.1 --port <port> --username <user> --ssh-key <private key> --insecure
  ```

  `--quickchr` itself rejects `--ssh-key`
  ([tikoci/centrs#420](https://github.com/tikoci/centrs/issues/420)), so this
  path gives up the machine-name lookup. `--insecure` is needed because the
  ephemeral VM's host key changes at a reused loopback port. RouterOS's
  default `/ip/ssh password-authentication=yes-if-no-key` turns off SSH
  password login for a user once it has a key; REST and API are unaffected.
- **Or skip SSH**: `execute` and `transfer` can use `--via rest-api` /
  `--via native-api` (listed in `availableServices`). Their uploads are
  limited to 60 KB, so a larger `transfer` upload still needs one of the
  key-based routes above. `terminal` cannot skip SSH, since neither service has
  a terminal capability.

See [`docs/CONSTITUTION.md`](../../CONSTITUTION.md) → Resolution providers for
why a provider target never falls back to ambient credentials.

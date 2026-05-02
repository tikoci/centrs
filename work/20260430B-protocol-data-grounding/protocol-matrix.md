# Protocol grounding matrix

This is a draft evidence matrix. It is not a spec. Promote stable conclusions to
S002/S006 only after the row has enough source references and a test shape.

| Protocol | Capabilities | RouterOS surface | Auth and secrets | Local dependencies | Validation source | CHR/lab testability | Security and failure notes | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REST API | retrieve, update, execute, small transfer, proxy | `/rest/*`, service `www` or `www-ssl`, default HTTP 80 and HTTPS 443 when enabled | RouterOS user with `rest-api` policy; Basic auth; empty password shape must be explicit | Bun `fetch` or hardened HTTP client; TLS handling for self-signed routers | `restraml`, rosetta REST docs, static schema, live `/console/inspect` for commands | Strong via `quickchr`; first read-only retrieve candidate | Non-standard verbs (`PUT` creates, `PATCH` updates); continuous monitor commands are not supported; boot readiness race; HTTPS/cert diagnostics must be actionable | Preferred first alpha transport |
| Native API | retrieve, update, execute, streaming/eventing, proxy | TCP API service 8728 and API-SSL 8729; binary sentence protocol with tagged replies | RouterOS user with `api` policy; plaintext modern login; TLS optional via API-SSL | Pure TypeScript client possible via `Bun.connect`; needs explicit tag, cancellation, connection, and backpressure discipline | RouterOS API docs, `tiktui`, `restraml`, live CHR tests | Strong via `quickchr`, `tiktui`, `restraml`; eventing tests should use `/listen`, monitor commands, `/cancel`, traps, and connection recovery | Tagged multiplexing is powerful but has timeout/ghost-command evidence under bulk inspect workloads; cancellation, `!trap`, `!fatal`, and orphan replies must be tested | Strategic eventing transport; not first alpha read path |
| SSH | execute, terminal, transfer | RouterOS CLI over TCP 22; SCP/SFTP where enabled | RouterOS user with SSH rights; password or key | Host `ssh`, `scp`, and possibly `tmux` or pseudo-terminal support | CLI canonicalizer plus live `/console/inspect` where possible | Testable through CHR port forwarding | RouterOS is not Linux; command output is CLI text; interactive first-login password prompt matters | Planned after first retrieve loop |
| SNMP | retrieve | SNMP service and MIB/OIDs | SNMP community or v3 credentials | SNMP client library/tooling | MikroTik MIB, rosetta docs, device tests | CHR can expose SNMP after config | Read-only but can leak inventory; script policy limits matter | Planned read-only metrics path |
| MNDP | discover and enrich diagnostics | UDP 5678 broadcast/multicast; RouterOS `/ip/neighbor` and `/ip/neighbor/discovery-settings` | None | UDP socket with broadcast and port reuse; Bun >= 1.3.11 for reliable reuse on macOS | `routeros-mndp` skill, `mcp-mikrotik`, rosetta neighbor docs | Hardware or bridged/shared-network CHR better than SLiRP; parser unit tests do not need CHR | Unauthenticated LAN inventory leak; absence is not proof of offline; identity is non-unique; one router may appear once per interface | Important discovery source; planned data hint |
| MAC Telnet | terminal and emergency access by MAC | RouterOS `/tool/mac-server`, `/tool/mac-telnet`, UDP 20561, L2 MAC protocol | RouterOS username/password; device addressed by MAC or identity resolved through MNDP | Raw/link-layer socket or external `mactelnet`; interface selection matters; elevated privileges may be needed | Legacy mac-telnet implementation, RouterOS MAC server docs, future dissector review | Needs L2-capable lab; not testable through ordinary SLiRP hostfwd | Critical when IP access is broken; should warn about interface scope, MAC server exposure, and default all-active-interface client behavior before RouterOS 7.22 `interface=` selection | Planned; needs protocol extraction and lab |
| RoMON | terminal and routed management overlay | `/tool/romon`, `/tool/romon/port`, `romon ssh`, `discover`, `ping`, EtherType `0x88bf` | RouterOS credentials plus optional RoMON secrets; RoMON itself does not encrypt traffic | Local client/tooling not yet identified | rosetta RoMON docs; more implementation evidence needed | Requires multi-router or suitable CHR topology with shared L2/multicast | Default `all` port entry participates when enabled; secrets, multicast/bridge behavior, VLAN alignment, and v7.17 switch ACL behavior need care | Planned; research gap |
| WinBox protocol / Nova messages | terminal, proxy, schema discovery, CDB/Dude-related understanding, RoMON proxy research | WinBox service TCP 8291 plus Nova message families used by WinBox, CDB, Dude DB, terminal-over-WinBox, and RoMON proxy views | RouterOS credentials plus possible CDB password context; authentication and saved-password behavior are separate concerns | Open protocol implementations, dissectors, and lab captures; do not assume proprietary WinBox is scriptable | WinBox protocol research, Nova/CDB/Dude evidence, future dissector review | CHR can expose TCP 8291 for liveness; behavior needs protocol/tooling evidence and safe captures | Undocumented and version-sensitive; high value for understanding RouterOS internals but not an implementation commitment | Strategic research area; provisional |
| WinBox Terminal | terminal | Likely a WinBox protocol feature over TCP 8291, not merely a service liveness check | RouterOS credentials; possible CDB integration | Terminal-over-WinBox implementation or scriptable tooling; local tooling unknown | Needs references and dissector review | CHR service reachable by hostfwd for liveness only; terminal behavior not grounded | Protocol and UX risk; avoid assuming local WinBox availability or scriptability | Planned; research gap |
| File transfer | transfer | REST file endpoints for small files, SSH/SCP/SFTP, `/tool/fetch` | Protocol-specific credentials | Depends on chosen protocol and file size | RouterOS docs plus quickchr/tikbook patterns | Testable via CHR with files package paths | Large files, binary serialization, and path semantics differ by protocol | Planned after first transport |
| Proxy/eventing | proxy, streaming, HTTP/SSE/WebSocket presentation | REST for polling and one-shot reads; native API for `/listen` and monitor streams | Device credentials should not leak to browser clients | HTTP server, SSE/WebSocket, API client lifecycle | `tiktui`, `restraml`, RouterOS API docs | Testable with CHR and per-client stream cleanup | REST cannot replace native API eventing; backpressure, cancellation, orphan replies, connection ownership, and credential boundaries are security-sensitive | Future surface; design now, implement later |

## Open questions

- Which native API command shapes are safe to multiplex, and where must `centrs`
  serialize or isolate connections?
- What is the minimum L2 lab topology for MAC Telnet and MNDP tests on macOS,
  Linux CI, and quickchr?
- Which WinBox Terminal path is practical without bundling proprietary tooling?
- Should file transfer be modeled as a capability on each adapter or as a
  separate planner that selects among protocol-specific transfer paths?

## Default service and transfer notes

- Future `check` work should assume RouterOS service defaults first, then use
  reachable protocols to discover configured service ports when possible. A
  useful RouterOS probe shape is:

  ```routeros
  :put [:serialize to=json options=json.pretty [ip/service/print detail as-value where !dynamic ]]
  ```

- SSH is useful for command execution and for discovering custom service ports,
  but command output is terminal text whose columns and formatting can vary with
  terminal width and RouterOS version.
- File transfer should remain a planner problem until grounded. Candidate paths
  include FTP, SFTP, SCP, REST file endpoints, `/tool/fetch`, SMB, and optional
  storage-package protocols such as rsync, NFS, NVMe over TCP, and iSCSI.
- Unsafe or optional protocols should require explicit selection and
  user-visible warnings rather than becoming automatic fallbacks.

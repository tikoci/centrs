# Reference inventory

This inventory names the current evidence sources for protocol and data
grounding. Prefer local repo paths when available; use external links only when
the local workspace lacks the necessary detail.

| Area | Reference | What it contributes | Status |
| --- | --- | --- | --- |
| CHR/QEMU labs | `/Users/amm0/GitHub/quickchr` | CHR lifecycle, QEMU args, port forwarding, boot readiness, provisioning, integration-test patterns, and RouterOS REST quirks. | Local reference available. |
| REST schema and inspect | `/Users/amm0/GitHub/restraml` | REST RAML/OpenAPI generation, raw `/console/inspect`, deep-inspect, version diffs, native API client, and CHR-in-CI workflows. | Local reference available. |
| Native API multiplexing | `/Users/amm0/GitHub/restraml/ros-api-protocol.ts` and `/Users/amm0/GitHub/restraml/deep-inspect.ts` | Per-command tags, `/cancel`, interrupted-stream handling, and evidence that bulk native-API `/console/inspect` enrichment can time out or leave ghost in-flight work. | Local reference available; multiplexing risk scope still open. |
| Validation and canonicalization | `/Users/amm0/GitHub/lsp-routeros-ts` | Inspect-driven validation and RouterOS command canonicalization patterns. | Local reference available. |
| REST/native API/SSE lessons | `/Users/amm0/Lab/tiktui` | REST for one-shot reads, native API for streaming, tag-based commands, `/listen`, `/monitor-traffic`, cancellation, and SSE presentation patterns. | Local reference available. |
| Native API CHR tests | `/Users/amm0/Lab/tiktui/test/protocol.test.ts` and `/Users/amm0/Lab/tiktui/test/listen.test.ts` | Test shapes for `monitor-traffic =once`, `/interface/listen`, multi-packet streams, cancellation, and stream plus parallel write coexistence. | Local reference available. |
| MNDP discovery | `/Users/amm0/Lab/mcp-monorepo/mcp-mikrotik` | MNDP packet parsing/listening, live scan timing, multi-interface behavior, identity ambiguity, port probing, and probe presentation. | Local reference available. |
| Packet capture | `/Users/amm0/Lab/mcp-monorepo/mcp-tzsp` and `routeros-sniffer` skill | TZSP capture paths for protocol debugging. | Local reference available. |
| Dude DB | `/Users/amm0/GitHub/donny` | `dude.db`, `export.dude`, Nova codec, normalized schema, plaintext credential risk, and quickchr-backed validation. | Local reference available; safe lab fixtures only. |
| MAC Telnet | `/Users/amm0/Lab/Legacy/mac-telnet` and <https://github.com/haakonnessjoen/mac-telnet> | `mactelnet`, `macping`, MNDP utility behavior, POSIX client/server implementation, UDP port 20561, packet retransmit/session behavior, and interface selection concerns. | Local reference available; protocol notes still need extraction before implementation. |
| RouterOS docs/RAG | rosetta MCP tools | Current RouterOS docs, command tree, property lookup, changelog, and device facts. | Available through MCP. |
| RouterOS MAC server docs | rosetta page "MAC server" | `/tool/mac-server`, `/tool/mac-telnet`, MAC scan, MAC WinBox, MAC ping, allowed-interface-list, security guidance, and RouterOS v7.22 client interface selection note. | Available through MCP. |
| RouterOS native API docs | rosetta page "API" | Tags, replies, `/cancel`, `listen`, `!trap`, `!fatal`, warnings about attribute order, query order, and unsupported regular-expression queries. | Available through MCP. |
| RouterOS REST API docs | rosetta page "REST API" | REST verb mapping, POST command behavior, `.proplist`, `.query`, timeouts, errors, and the warning that continuous monitor commands are not supported through REST. | Available through MCP. |
| RouterOS RoMON docs | rosetta page "RoMON" | `/tool/romon`, `/tool/romon/port`, EtherType `0x88bf`, secrets, interface-list behavior, default all-interfaces participation, multicast/bridge caveats, `discover`, `ping`, and `ssh`. | Available through MCP. |
| RouterOS neighbor discovery docs | rosetta page "Neighbor discovery" | `/ip/neighbor`, `/ip/neighbor/discovery-settings`, MNDP/CDP/LLDP behavior, interface-list controls, and read-only neighbor properties. | Available through MCP. |
| Wireshark dissectors | Upstream Wireshark source tree | Protocol dissectors for independent wire-format checks. | Needs local clone or pinned source reference for MNDP, MAC Telnet, RoMON, and WinBox. |
| WinBox protocol dissector | <https://github.com/Cisco-Talos/Winbox_Protocol_Dissector> | Independent WinBox protocol parsing reference, including areas that may overlap RoMON proxy or terminal research. | Provisional external reference; needs source pinning and license review before relying on details. |
| WinBox CDB implementation | <https://github.com/jabb3rd/RouterOS_Tools> | Candidate implementation evidence for CDB file format, saved entries, and encryption behavior. | Provisional external reference; compare against safe fixtures before code. |
| WinBox Terminal protocol | <https://github.com/subixonfire/winbox-terminal-protocol> | Candidate reference for terminal-over-WinBox behavior. | Provisional external reference; needs spike before adapter decisions. |
| Netmiko SSH patterns | <https://github.com/ktbyers/netmiko> | SSH automation design reference for network devices, useful as a contrast to RouterOS-specific multi-protocol design. | Background reference only. |
| Terraform RouterOS provider | <https://pkg.go.dev/github.com/terraform-routeros/terraform-provider-routeros/routeros> | Native API and RouterOS provisioning patterns using a widely used Go stack. | Background reference for native API compare-and-contrast. |
| C librouteros-api | <https://github.com/haakonnessjoen/librouteros-api> | C implementation by the MAC Telnet author; useful for native API cross-checking. | Background reference; not an implementation dependency. |
| Bandwidth-test open source | <https://github.com/samm-git/btest-opensource> | Possible reference for RouterOS bandwidth-test protocol if future `check` grows into traffic testing. | Future feature reference only. |

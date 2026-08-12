/**
 * RouterOS path catalog — GENERATED, do not hand-edit.
 *
 * Regenerate with `bun run explain:catalog`; `bun run explain:catalog --check`
 * is the drift gate. The generator (`scripts/gen-explain-catalog.ts`) carries
 * the full rationale, the vendored-ETL provenance, and the alias allowlist with
 * its two safety assertions.
 *
 * Union of two first-order sources (#228):
 *
 * 1. MikroTik's published CLI Reference (`https://manual.mikrotik.com/docs/cli-reference/`),
 *    1,070 pages, 1,077 entries — first-order about the definition
 *    structs and their build-time gates. Since #285 every page is a leaf whose
 *    slug is the CLI path, so no spelling has to be rewritten to be looked up.
 * 2. Four pinned restraml `/console/inspect` trees
 *    (`https://tikoci.github.io/restraml/`) — first-order about the CLI surface:
 *
 * | Tree | Arch | RouterOS | Nodes |
 * | ---- | ---- | -------- | ----- |
 * | `7.10.2/extra/inspect.json` | x86 | 7.10.2 | 29,086 |
 * | `7.16/extra/inspect.json` | x86 | 7.16 | 34,876 |
 * | `7.23.2/extra/deep-inspect.x86.json` | x86 | 7.23.2 | 40,595 |
 * | `7.24rc2/extra/deep-inspect.arm64.json` | arm64 | 7.24rc2 | 42,690 |
 *
 * | Kind | Total | `both` | `inspect` | `published` |
 * | ---- | ----- | ------ | --------- | ----------- |
 * | `menu` | 558 | 454 | 54 | 50 |
 * | `command` | 450 | 407 | 0 | 43 |
 * | `settings` | 116 | 107 | 0 | 9 |
 *
 * Zero navigation-vs-command contradictions between the two sources. Generation
 * aborts if that ever stops holding, rather than picking a winner. Where a path
 * is published twice as a container under different hardware gates — the seven
 * `/interface/ethernet/switch` and `/system/health` variants — the row records
 * what the occurrences agree on.
 *
 * **This table is not a schema.** It says what a path IS — navigation, an
 * executable command, or a settings menu — and never what a command accepts.
 * Arguments, types, enums and `.proplist` stay live-only evidence.
 *
 * **Absence never rejects.** A path in neither source is simply absent, and a
 * caller that does not find one must abstain. A gate never decides anything
 * offline either: it explains why a published path may be missing from a given
 * router ("PoE hardware only"), and no router was consulted to build this.
 *
 * **Gates conjoin down a path, so read them with {@link effectiveGates}, not
 * row by row.** A row states only what the publication stated at that entry.
 * Read row-wise, 2 published-only paths look ungated; read with
 * ancestry, the residue carrying no published explanation for its absence at
 * all is 1.
 *
 * Tree COMMANDS are not enumerated — those are the generic CRUD leaves
 * `verbs.ts` already owns. The command rows here are the published,
 * overwhelmingly non-generic ones.
 */

/** What a path IS. `settings` is a menu whose contents are a single record. */
export type PathKind = "menu" | "command" | "settings";

/**
 * Which source carried an entry.
 *
 * `inspect` and `both` are device-confirmed: the path was observed on at least
 * one real `/console/inspect` tree. `published` is documentation evidence only
 * — usually a path gated to hardware no CHR has.
 */
export type PathProvenance = "inspect" | "published" | "both";

/**
 * One catalog row. The gate fields are MikroTik's published build-time
 * applicability markers, verbatim; they are provenance for an explanation, never
 * a claim about any particular router.
 */
export interface CatalogEntry {
	kind: PathKind;
	provenance: PathProvenance;
	/** Required RouterOS package, e.g. `wireless-qca`. */
	package?: string;
	/** Build conditions, e.g. `!i386, !smips`. */
	conditions?: string;
	/** Required system capability, e.g. `poe`, `lcd`, `multiswitch`. */
	syscap?: string;
}

/**
 * The catalog as text: one line per path, columns separated by `|` —
 * `path|kind|provenance|package|conditions|syscap` — with trailing empty
 * columns trimmed. Lower-cased, slash-led and sorted by path.
 *
 * Text rather than ~1,124 object literals so that one path is one line in a
 * review diff, and so the formatter has nothing to re-wrap.
 */
const ROWS = `
/app|menu|both|container||app
/app/cleanup|command|both|container||app
/app/network|menu|both|container||app
/app/remove|command|both|container||app
/app/restart|command|both|container||app
/app/settings|settings|both|container||app
/app/setup|command|both|container||app
/app/update|command|both|container||app
/beep|command|both
/blink|command|both||!i386
/caps-man|menu|inspect
/caps-man/aaa|settings|both|wireless-rep
/caps-man/access-list|menu|both|wireless-rep
/caps-man/actual-interface-configuration|menu|both|wireless-rep
/caps-man/channel|menu|both|wireless-rep
/caps-man/configuration|menu|both|wireless-rep
/caps-man/datapath|menu|both|wireless-rep
/caps-man/interface|menu|both|wireless-rep
/caps-man/interface/hw-info|command|both|wireless-rep
/caps-man/interface/possible-channels|command|both|wireless-rep
/caps-man/interface/reselect-channel|command|both|wireless-rep
/caps-man/interface/scan|command|both|wireless-rep
/caps-man/manager|settings|both|wireless-rep
/caps-man/manager/interface|menu|both|wireless-rep
/caps-man/provisioning|menu|both|wireless-rep
/caps-man/radio|menu|both|wireless-rep
/caps-man/radio/hw-info|command|both|wireless-rep
/caps-man/radio/provision|command|both|wireless-rep
/caps-man/rates|menu|both|wireless-rep
/caps-man/registration-table|menu|both|wireless-rep
/caps-man/remote-cap|menu|both|wireless-rep
/caps-man/remote-cap/provision|command|both|wireless-rep
/caps-man/remote-cap/set-identity|command|both|wireless-rep
/caps-man/remote-cap/upgrade|command|both|wireless-rep
/caps-man/security|menu|both|wireless-rep
/certificate|menu|both
/certificate/acme-renew|command|both
/certificate/add-acme|command|both
/certificate/add-scep|command|both
/certificate/builtin|menu|both
/certificate/card-reinstall|command|both
/certificate/card-verify|command|both
/certificate/create-certificate-request|command|both
/certificate/crl|menu|both
/certificate/crl/download|command|both
/certificate/crl/flush|command|both
/certificate/enable-ssl-certificate|command|both
/certificate/export-certificate|command|both
/certificate/import|command|both
/certificate/issued-revoke|command|both
/certificate/scep-renew|command|both
/certificate/scep-server|menu|both
/certificate/scep-server/otp|menu|both
/certificate/scep-server/otp/generate|command|both
/certificate/scep-server/ra|menu|both
/certificate/scep-server/ra/renew|command|both
/certificate/scep-server/requests|menu|both
/certificate/scep-server/requests/grant|command|both
/certificate/settings|settings|both
/certificate/sign|command|both
/certificate/sign-certificate-request|command|both
/console|menu|both
/console/inspect|command|both
/console/settings|settings|both
/container|menu|both|container
/container/config|settings|both|container
/container/envs|menu|both|container
/container/kill|command|both|container
/container/layers|menu|both|container
/container/log|menu|both|container
/container/mounts|menu|both|container
/container/repull|command|both|container
/container/restart|command|both|container
/container/save|command|both|container
/container/start|command|both|container
/container/stop|command|both|container
/container/update|command|both|container
/disk|menu|both||!smips
/disk/blink|command|both||!smips
/disk/btrfs|menu|both||!smips|storage
/disk/btrfs/filesystem|menu|both||!smips|storage
/disk/btrfs/filesystem/add-device|command|both||!smips|storage
/disk/btrfs/filesystem/balance-cancel|command|both||!smips|storage
/disk/btrfs/filesystem/balance-start|command|both||!smips|storage
/disk/btrfs/filesystem/remove-device|command|both||!smips|storage
/disk/btrfs/filesystem/replace-cancel|command|both||!smips|storage
/disk/btrfs/filesystem/replace-device|command|both||!smips|storage
/disk/btrfs/filesystem/reset-counters|command|both||!smips|storage
/disk/btrfs/filesystem/scrub-cancel|command|both||!smips|storage
/disk/btrfs/filesystem/scrub-start|command|both||!smips|storage
/disk/btrfs/subvolume|menu|both||!smips|storage
/disk/btrfs/transfer|menu|both||!smips|storage
/disk/check|command|both||!smips|storage
/disk/copy|command|both||!smips
/disk/eject|command|both||!smips
/disk/format|command|both||!smips
/disk/monitor-traffic|command|both||!smips
/disk/nvme-discover|command|both||!smips|storage
/disk/raid-scrub|command|both||!smips|storage
/disk/raid-scrub-cancel|command|both||!smips|storage
/disk/repair|command|both||!smips|storage
/disk/reset-counters|command|both||!smips
/disk/scan|command|both||!smips
/disk/settings|settings|both||!smips
/disk/smart-info|command|both||!smips|storage
/disk/smb-share|menu|inspect
/disk/smb-user|menu|inspect
/disk/test|command|both||!smips
/disk/trim|command|both||!smips
/dude|settings|both|dude
/dude/agent|menu|both|dude
/dude/device|menu|both|dude
/dude/device-type|menu|both|dude
/dude/export-db|command|both|dude
/dude/import-db|command|both|dude
/dude/notification|menu|both|dude
/dude/probe|menu|both|dude
/dude/ros|menu|both|dude
/dude/ros/address|menu|both|dude
/dude/ros/arp|menu|both|dude
/dude/ros/health|menu|both|dude
/dude/ros/interface|menu|both|dude
/dude/ros/lease|menu|both|dude
/dude/ros/neighbor|menu|both|dude
/dude/ros/queue|menu|both|dude
/dude/ros/registration-table|menu|both|dude
/dude/ros/resource|menu|both|dude
/dude/ros/route|menu|both|dude
/dude/ros/routerboard|menu|both|dude
/dude/service|menu|both|dude
/dude/settings|settings|both|dude
/dude/vacuum-db|command|both|dude
/environment|menu|both
/file|menu|both
/file/copy|command|both
/file/head|command|both
/file/read|command|both
/file/rsync-daemon|settings|both|rose-storage
/file/sync|menu|both|rose-storage
/file/sync/monitor|command|both|rose-storage
/file/tail|command|both
/import|command|both
/interface|menu|both
/interface/6to4|menu|both
/interface/blink|command|both
/interface/bonding|menu|both
/interface/bonding/monitor|command|both
/interface/bonding/monitor-slaves|command|both
/interface/bridge|menu|both||MSRP_ENABLE
/interface/bridge/calea|menu|both
/interface/bridge/calea/reset-counters|command|both
/interface/bridge/calea/reset-counters-all|command|both
/interface/bridge/filter|menu|both
/interface/bridge/filter/reset-counters|command|both
/interface/bridge/filter/reset-counters-all|command|both
/interface/bridge/host|menu|both
/interface/bridge/mdb|menu|both
/interface/bridge/monitor|command|both
/interface/bridge/msrp|menu|published||MSRP_ENABLE
/interface/bridge/msrp/attributes|menu|published||MSRP_ENABLE
/interface/bridge/msrp/domain|menu|published||MSRP_ENABLE
/interface/bridge/msrp/domain/attributes|menu|published||MSRP_ENABLE
/interface/bridge/msrp/domain/monitor|command|published||MSRP_ENABLE
/interface/bridge/msti|menu|both
/interface/bridge/msti/monitor|command|both
/interface/bridge/nat|menu|both
/interface/bridge/nat/reset-counters|command|both
/interface/bridge/nat/reset-counters-all|command|both
/interface/bridge/port|menu|both
/interface/bridge/port-controller|menu|inspect
/interface/bridge/port-controller/device|menu|inspect
/interface/bridge/port-controller/port|menu|inspect
/interface/bridge/port-controller/port/poe|menu|inspect
/interface/bridge/port-extender|menu|inspect
/interface/bridge/port/monitor|command|both
/interface/bridge/port/mst-override|menu|both
/interface/bridge/port/mst-override/monitor|command|both
/interface/bridge/settings|settings|both
/interface/bridge/vlan|menu|both
/interface/bridge/vlan/mvrp|menu|both
/interface/detect-internet|settings|both
/interface/detect-internet/state|menu|both
/interface/dot1x|menu|both||!smips
/interface/dot1x/client|menu|both||!smips
/interface/dot1x/server|menu|both||!smips
/interface/dot1x/server/active|menu|both||!smips
/interface/dot1x/server/state|menu|both||!smips
/interface/eoip|menu|both
/interface/eoipv6|menu|both
/interface/ethernet|menu|both||i386
/interface/ethernet/blink|command|both
/interface/ethernet/cable-test|command|both
/interface/ethernet/monitor|command|both||i386
/interface/ethernet/poe|menu|published|||(poe or poe-in)
/interface/ethernet/poe/monitor|command|published|||(poe or poe-in)
/interface/ethernet/poe/power-cycle|command|published|||(poe or poe-in)
/interface/ethernet/poe/settings|settings|published|||(poe or poe-in) and poesettings
/interface/ethernet/reset-counters|command|both
/interface/ethernet/reset-mac-address|command|both
/interface/ethernet/switch|menu|both
/interface/ethernet/switch/acl|menu|published|||musicswitch
/interface/ethernet/switch/acl/policer|menu|published|||musicswitch
/interface/ethernet/switch/dscp-qos-map|menu|published|||musicswitch
/interface/ethernet/switch/dscp-to-dscp|menu|published|||musicswitch
/interface/ethernet/switch/egress-vlan-tag|menu|published|||musicswitch
/interface/ethernet/switch/egress-vlan-translation|menu|published|||musicswitch
/interface/ethernet/switch/host|menu|both|||rbswitch and oldswitch
/interface/ethernet/switch/ingress-port-policer|menu|published|||musicswitch
/interface/ethernet/switch/ingress-vlan-translation|menu|published|||musicswitch
/interface/ethernet/switch/l3hw-settings|settings|published|||rbswitch and crs_prestera
/interface/ethernet/switch/l3hw-settings/advanced|settings|published|||rbswitch and crs_prestera
/interface/ethernet/switch/l3hw-settings/advanced/monitor|command|published|||rbswitch and crs_prestera
/interface/ethernet/switch/l3hw-settings/monitor|command|published|||rbswitch and crs_prestera
/interface/ethernet/switch/mac-based-vlan|menu|published|||musicswitch
/interface/ethernet/switch/multicast-fdb|menu|published|||musicswitch
/interface/ethernet/switch/one2one-vlan-switching|menu|published|||musicswitch
/interface/ethernet/switch/policer-qos-map|menu|published|||musicswitch
/interface/ethernet/switch/port|menu|both
/interface/ethernet/switch/port-isolation|menu|both
/interface/ethernet/switch/port-leakage|menu|published|||musicswitch
/interface/ethernet/switch/port/reset-counters|command|both
/interface/ethernet/switch/protocol-based-vlan|menu|published|||musicswitch
/interface/ethernet/switch/qos|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos-group|menu|published|||musicswitch
/interface/ethernet/switch/qos/map|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/map/ip|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/map/vlan|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/monitor|command|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/port|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/port/reset-counters|command|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/priority-flow-control|menu|published|||rbswitch and crs_prestera and !prestera-ac3
/interface/ethernet/switch/qos/profile|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/settings|settings|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/tx-manager|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/qos/tx-manager/queue|menu|published|||rbswitch and crs_prestera
/interface/ethernet/switch/reserved-fdb|menu|published|||musicswitch
/interface/ethernet/switch/reset-counters|command|both
/interface/ethernet/switch/rule|menu|both|||rbswitch
/interface/ethernet/switch/shaper|menu|published|||musicswitch
/interface/ethernet/switch/stats|settings|published||!smips|musicswitch
/interface/ethernet/switch/trunk|menu|published|||musicswitch
/interface/ethernet/switch/unicast-fdb|menu|published|||musicswitch
/interface/ethernet/switch/unicast-fdb/flush|command|published|||musicswitch
/interface/ethernet/switch/vlan|menu|both
/interface/gre|menu|both
/interface/gre6|menu|both
/interface/ipip|menu|both
/interface/ipipv6|menu|both
/interface/l2tp-client|menu|both
/interface/l2tp-client/monitor|command|both
/interface/l2tp-ether|menu|both
/interface/l2tp-ether/monitor|command|both
/interface/l2tp-server|menu|both
/interface/l2tp-server/monitor|command|both
/interface/l2tp-server/server|settings|both
/interface/list|menu|both
/interface/list/member|menu|both
/interface/lte|menu|both||!smips
/interface/lte/apn|menu|both||!smips
/interface/lte/at-chat|command|both||!smips
/interface/lte/cell-monitor|command|both||!smips
/interface/lte/esim|menu|both||!smips
/interface/lte/esim/activate|command|both||!smips
/interface/lte/esim/deactivate|command|both||!smips
/interface/lte/esim/delete|command|both||!smips
/interface/lte/esim/esim-id|command|both||!smips
/interface/lte/esim/provision|command|both||!smips
/interface/lte/esim/refresh-profile-list|command|both||!smips
/interface/lte/esim/send-notifications|command|both||!smips
/interface/lte/esim/set-nickname|command|both||!smips
/interface/lte/firmware-upgrade|command|both||!smips
/interface/lte/monitor|command|both||!smips
/interface/lte/run-modem-update|command|published||!smips
/interface/lte/scan|command|both||!smips
/interface/lte/settings|settings|both||!smips, !i386, !mips, !powerpc
/interface/lte/show-capabilities|command|both||!smips
/interface/macsec|menu|both||!smips
/interface/macsec/monitor|command|both||!smips
/interface/macsec/profile|menu|both||!smips
/interface/macvlan|menu|both
/interface/mesh|menu|both
/interface/mesh/fdb|menu|both
/interface/mesh/port|menu|both
/interface/mesh/traceroute|command|both
/interface/monitor-traffic|command|both
/interface/ovpn-client|menu|both
/interface/ovpn-client/import-ovpn-configuration|command|both
/interface/ovpn-client/monitor|command|both
/interface/ovpn-server|menu|both
/interface/ovpn-server/monitor|command|both
/interface/ovpn-server/server|menu|both
/interface/ovpn-server/server/export-client-configuration|command|both
/interface/ppp-client|menu|both
/interface/ppp-client/at-chat|command|both
/interface/ppp-client/firmware-upgrade|command|both
/interface/ppp-client/info|command|both
/interface/ppp-client/monitor|command|both
/interface/ppp-client/scan|command|both
/interface/ppp-server|menu|both
/interface/ppp-server/monitor|command|both
/interface/pppoe-client|menu|both
/interface/pppoe-client/monitor|command|both
/interface/pppoe-client/scan|command|both
/interface/pppoe-server|menu|both
/interface/pppoe-server/monitor|command|both
/interface/pppoe-server/server|menu|both
/interface/pptp-client|menu|both
/interface/pptp-client/monitor|command|both
/interface/pptp-server|menu|both
/interface/pptp-server/monitor|command|both
/interface/pptp-server/server|settings|both
/interface/pwr-line|menu|published|||pwrlink
/interface/pwr-line/blink|command|published|||pwrlink
/interface/pwr-line/configure|command|published|||pwrlink
/interface/pwr-line/join|command|published|||pwrlink
/interface/pwr-line/leave|command|published|||pwrlink
/interface/pwr-line/monitor|command|published|||pwrlink
/interface/pwr-line/reset-counters|command|published|||pwrlink
/interface/pwr-line/reset-mac-address|command|published|||pwrlink
/interface/pwr-line/upgrade-firmware|command|published|||pwrlink
/interface/reset-counters|command|both
/interface/sstp-client|menu|both
/interface/sstp-client/monitor|command|both
/interface/sstp-server|menu|both
/interface/sstp-server/monitor|command|both
/interface/sstp-server/server|settings|both
/interface/veth|menu|both||!smips|container
/interface/vlan|menu|both||!smips
/interface/vpls|menu|both||!smips
/interface/vpls/monitor|command|both||!smips
/interface/vrrp|menu|both
/interface/vxlan|menu|both
/interface/vxlan/fdb|menu|both
/interface/vxlan/vteps|menu|both
/interface/w60g|menu|published|wireless-rep||60ghz
/interface/w60g/align|command|published|wireless-rep||60ghz
/interface/w60g/monitor|command|published|wireless-rep||60ghz
/interface/w60g/reset-configuration|command|published|wireless-rep||60ghz
/interface/w60g/scan|command|published|wireless-rep||60ghz
/interface/w60g/station|menu|published|wireless-rep||60ghz
/interface/w60g/station/monitor|command|published|wireless-rep||60ghz
/interface/wifi|menu|both
/interface/wifi/aaa|menu|both
/interface/wifi/access-list|menu|both
/interface/wifi/cap|settings|both
/interface/wifi/capsman|settings|both
/interface/wifi/capsman/remote-cap|menu|both
/interface/wifi/capsman/remote-cap/provision|command|both
/interface/wifi/capsman/remote-cap/set-identity|command|both
/interface/wifi/capsman/remote-cap/upgrade|command|both
/interface/wifi/channel|menu|both
/interface/wifi/configuration|menu|both
/interface/wifi/datapath|menu|both
/interface/wifi/devel|command|both
/interface/wifi/flat-snoop|command|both
/interface/wifi/frequency-scan|command|both
/interface/wifi/interworking|menu|both
/interface/wifi/liberate|command|both
/interface/wifi/monitor|command|both
/interface/wifi/network|menu|both
/interface/wifi/network/radio|menu|both
/interface/wifi/provisioning|menu|both
/interface/wifi/radio|menu|both
/interface/wifi/radio/provision|command|both
/interface/wifi/radio/reg-info|command|both
/interface/wifi/radio/settings|settings|both
/interface/wifi/registration-table|menu|both
/interface/wifi/reset-mac-address|command|both
/interface/wifi/roam|command|both
/interface/wifi/scan|command|both
/interface/wifi/security|menu|both
/interface/wifi/security/multi-passphrase|menu|both
/interface/wifi/sniffer|command|both
/interface/wifi/spectral-scan|command|both
/interface/wifi/steering|menu|both
/interface/wifi/steering/neighbor-group|menu|both
/interface/wifi/trigger-radar|command|published|||dfstest
/interface/wifi/wps-client|command|both
/interface/wifi/wps-push-button|command|both
/interface/wifiwave2|menu|inspect
/interface/wifiwave2/aaa|menu|inspect
/interface/wifiwave2/access-list|menu|inspect
/interface/wifiwave2/actual-configuration|menu|inspect
/interface/wifiwave2/cap|menu|inspect
/interface/wifiwave2/capsman|menu|inspect
/interface/wifiwave2/capsman/remote-cap|menu|inspect
/interface/wifiwave2/channel|menu|inspect
/interface/wifiwave2/configuration|menu|inspect
/interface/wifiwave2/datapath|menu|inspect
/interface/wifiwave2/interworking|menu|inspect
/interface/wifiwave2/provisioning|menu|inspect
/interface/wifiwave2/radio|menu|inspect
/interface/wifiwave2/registration-table|menu|inspect
/interface/wifiwave2/security|menu|inspect
/interface/wireguard|menu|both
/interface/wireguard/peers|menu|both
/interface/wireguard/peers/show-client-config|command|both
/interface/wireguard/wg-export|command|both
/interface/wireguard/wg-import|command|both
/interface/wireless|menu|both|wireless-rep
/interface/wireless/access-list|menu|both|wireless-rep
/interface/wireless/align|settings|both|wireless-rep
/interface/wireless/align/monitor|command|both|wireless-rep
/interface/wireless/align/test-audio|command|both|wireless-rep
/interface/wireless/cap|settings|both|wireless-rep
/interface/wireless/channels|menu|both|wireless-rep
/interface/wireless/connect-list|menu|both|wireless-rep
/interface/wireless/frequency-monitor|command|both|wireless-rep
/interface/wireless/info|menu|both|wireless-rep
/interface/wireless/info/allowed-channels|command|both|wireless-rep
/interface/wireless/info/country-info|command|both|wireless-rep
/interface/wireless/info/country-list|command|both|wireless-rep
/interface/wireless/info/default-scan-list|command|both|wireless-rep
/interface/wireless/info/hw-info|command|both|wireless-rep
/interface/wireless/info/scan-list|command|both|wireless-rep
/interface/wireless/interworking-profiles|menu|both|wireless-rep
/interface/wireless/manual-tx-power-table|menu|both|wireless-rep
/interface/wireless/monitor|command|both|wireless-rep
/interface/wireless/nstreme|menu|both|wireless-rep
/interface/wireless/nstreme-dual|menu|both|wireless-rep
/interface/wireless/nstreme-dual/monitor|command|both|wireless-rep
/interface/wireless/nstreme-dual/reset-counters|command|both|wireless-rep
/interface/wireless/registration-table|menu|both|wireless-rep
/interface/wireless/registration-table/reset-counters|command|both|wireless-rep
/interface/wireless/reset-configuration|command|both|wireless-rep
/interface/wireless/reset-mac-address|command|both|wireless-rep
/interface/wireless/scan|command|both|wireless-rep
/interface/wireless/security-profiles|menu|both|wireless-rep
/interface/wireless/setup-repeater|command|both|wireless-rep
/interface/wireless/sniffer|settings|both|wireless-rep
/interface/wireless/sniffer/packet|menu|both|wireless-rep
/interface/wireless/sniffer/save|command|both|wireless-rep
/interface/wireless/sniffer/sniff|command|both|wireless-rep
/interface/wireless/snooper|settings|both|wireless-rep
/interface/wireless/snooper/flat-snoop|command|both|wireless-rep
/interface/wireless/spectral-scan|command|both|wireless-rep
/interface/wireless/wds|menu|both|wireless-rep
/interface/wireless/wds/monitor|command|both|wireless-rep
/interface/wireless/wps-client|command|both|wireless-rep
/interface/wireless/wps-push-button|command|both|wireless-rep
/interface/xfrm|menu|published
/iot|menu|inspect
/iot/bluetooth|menu|both|iot
/iot/bluetooth/advertisers|menu|both|iot
/iot/bluetooth/advertisers/ad-structures|menu|both|iot
/iot/bluetooth/connections|menu|both|iot
/iot/bluetooth/connections/async-data|menu|both|iot
/iot/bluetooth/connections/async-data/clear|command|both|iot
/iot/bluetooth/connections/characteristics|menu|both|iot
/iot/bluetooth/connections/connect|command|both|iot
/iot/bluetooth/connections/disconnect|command|both|iot
/iot/bluetooth/connections/read|command|both|iot
/iot/bluetooth/connections/subscribe|command|both|iot
/iot/bluetooth/connections/unsubscribe|command|both|iot
/iot/bluetooth/connections/write|command|both|iot
/iot/bluetooth/connections/write-no-resp|command|both|iot
/iot/bluetooth/decode-ad|command|both|iot
/iot/bluetooth/peripheral-devices|menu|both|iot
/iot/bluetooth/reset-counters|command|both|iot
/iot/bluetooth/scanners|menu|both|iot
/iot/bluetooth/scanners/advertisements|menu|both|iot
/iot/bluetooth/scanners/advertisements/clear|command|both|iot
/iot/bluetooth/whitelist|menu|both|iot
/iot/gpio|menu|published|iot||gpio
/iot/gpio/analog|menu|published|iot||gpio
/iot/gpio/digital|menu|published|iot||gpio
/iot/lora|menu|both|iot
/iot/lora/channels|menu|both|iot
/iot/lora/joineui|menu|both|iot
/iot/lora/netid|menu|both|iot
/iot/lora/radios|menu|both|iot
/iot/lora/reset-devices|command|both|iot
/iot/lora/send|command|both|iot
/iot/lora/servers|menu|both|iot
/iot/lora/servers/reset-servers|command|both|iot
/iot/lora/traffic|menu|both|iot
/iot/lora/traffic/clear|command|both|iot
/iot/lora/traffic/options|settings|both|iot
/iot/modbus|settings|both|iot
/iot/modbus/read-holding-registers|command|both|iot
/iot/modbus/security-rules|menu|both|iot
/iot/modbus/transceive|command|both|iot
/iot/mqtt|settings|both|iot
/iot/mqtt/brokers|menu|both|iot
/iot/mqtt/connect|command|both|iot
/iot/mqtt/disconnect|command|both|iot
/iot/mqtt/publish|command|both|iot
/iot/mqtt/subscribe|command|both|iot
/iot/mqtt/subscriptions|menu|both|iot
/iot/mqtt/subscriptions/monitor-data|command|both|iot
/iot/mqtt/subscriptions/recv|menu|both|iot
/iot/mqtt/subscriptions/recv/clear|command|both|iot
/iot/mqtt/unsubscribe|command|both|iot
/iot/wiliot|settings|both|iot
/iot/wiliot/bluetooth-traffic|menu|both|iot
/iot/wiliot/bluetooth-traffic/clear|command|both|iot
/iot/wiliot/clear|command|both|iot
/iot/wiliot/disable|command|both|iot
/iot/wiliot/enable|command|both|iot
/iot/wiliot/mqtt-traffic|menu|both|iot
/iot/wiliot/mqtt-traffic/clear|command|both|iot
/iot/wiliot/options|settings|both|iot
/iot/wiliot/servers|menu|both|iot
/iot/wiliot/servers/defaults|command|both|iot
/ip|menu|inspect
/ip/address|menu|both
/ip/arp|menu|both
/ip/cloud|settings|both
/ip/cloud/advanced|settings|both
/ip/cloud/back-to-home-file|menu|both|||cloud-vpn
/ip/cloud/back-to-home-file/settings|settings|both|||cloud-vpn
/ip/cloud/back-to-home-file/settings/remove-certificate|command|published|||cloud-vpn
/ip/cloud/back-to-home-user|menu|both|||cloud-vpn
/ip/cloud/back-to-home-user/show-client-config|command|both|||cloud-vpn
/ip/cloud/force-update|command|both
/ip/dhcp-client|menu|both
/ip/dhcp-client/option|menu|both
/ip/dhcp-client/release|command|both
/ip/dhcp-client/renew|command|both
/ip/dhcp-relay|menu|both
/ip/dhcp-relay/monitor|command|both
/ip/dhcp-relay/reset-counters|command|both
/ip/dhcp-server|menu|both
/ip/dhcp-server/alert|menu|both
/ip/dhcp-server/alert/reset-alert|command|both
/ip/dhcp-server/config|settings|both
/ip/dhcp-server/lease|menu|both
/ip/dhcp-server/lease/check-status|command|both
/ip/dhcp-server/lease/make-static|command|both
/ip/dhcp-server/lease/send-reconfigure|command|both
/ip/dhcp-server/matcher|menu|both
/ip/dhcp-server/network|menu|both
/ip/dhcp-server/option|menu|both
/ip/dhcp-server/option/sets|menu|both
/ip/dhcp-server/setup|command|both
/ip/dns|settings|both
/ip/dns/adlist|menu|both
/ip/dns/adlist/pause|command|both
/ip/dns/adlist/reload|command|both
/ip/dns/cache|menu|both
/ip/dns/cache/all|menu|both
/ip/dns/cache/flush|command|both
/ip/dns/forwarders|menu|both
/ip/dns/static|menu|both
/ip/firewall|menu|inspect
/ip/firewall/address-list|menu|both
/ip/firewall/calea|menu|both
/ip/firewall/calea/reset-counters|command|both
/ip/firewall/calea/reset-counters-all|command|both
/ip/firewall/connection|menu|both
/ip/firewall/connection/tracking|settings|both
/ip/firewall/filter|menu|both
/ip/firewall/filter/reset-counters|command|both
/ip/firewall/filter/reset-counters-all|command|both
/ip/firewall/layer7-protocol|menu|both
/ip/firewall/mangle|menu|both
/ip/firewall/mangle/reset-counters|command|both
/ip/firewall/mangle/reset-counters-all|command|both
/ip/firewall/nat|menu|both
/ip/firewall/nat/reset-counters|command|both
/ip/firewall/nat/reset-counters-all|command|both
/ip/firewall/raw|menu|both
/ip/firewall/raw/reset-counters|command|both
/ip/firewall/raw/reset-counters-all|command|both
/ip/firewall/service-port|menu|both
/ip/hotspot|menu|both
/ip/hotspot/active|menu|both
/ip/hotspot/active/login|command|both
/ip/hotspot/cookie|menu|both
/ip/hotspot/host|menu|both
/ip/hotspot/host/make-binding|command|both
/ip/hotspot/ip-binding|menu|both
/ip/hotspot/profile|menu|both
/ip/hotspot/reset-html|command|both
/ip/hotspot/service-port|menu|both
/ip/hotspot/setup|command|both
/ip/hotspot/user|menu|both
/ip/hotspot/user/profile|menu|both
/ip/hotspot/user/reset-counters|command|both
/ip/hotspot/walled-garden|menu|both
/ip/hotspot/walled-garden/ip|menu|both
/ip/hotspot/walled-garden/reset-counters|command|both
/ip/hotspot/walled-garden/reset-counters-all|command|both
/ip/ipsec|menu|both
/ip/ipsec/active-peers|menu|both
/ip/ipsec/active-peers/kill-connections|command|both
/ip/ipsec/identity|menu|both
/ip/ipsec/installed-sa|menu|both
/ip/ipsec/installed-sa/flush|command|both
/ip/ipsec/key|menu|both
/ip/ipsec/key/psk|menu|both
/ip/ipsec/key/psk/generate|command|both
/ip/ipsec/key/qkd|menu|inspect
/ip/ipsec/key/rsa|menu|both
/ip/ipsec/key/rsa/export-pub-key|command|both
/ip/ipsec/key/rsa/generate-key|command|both
/ip/ipsec/key/rsa/import|command|both
/ip/ipsec/mode-config|menu|both
/ip/ipsec/peer|menu|both
/ip/ipsec/policy|menu|both
/ip/ipsec/policy/group|menu|both
/ip/ipsec/profile|menu|both
/ip/ipsec/proposal|menu|both
/ip/ipsec/settings|settings|both
/ip/ipsec/statistics|settings|both
/ip/kid-control|menu|both
/ip/kid-control/device|menu|both
/ip/kid-control/device/reset-counters|command|both
/ip/kid-control/pause|command|both
/ip/kid-control/resume|command|both
/ip/media|menu|both||!smips
/ip/media/settings|settings|both||!smips
/ip/nat-pmp|settings|both
/ip/nat-pmp/interfaces|menu|both
/ip/neighbor|menu|both
/ip/neighbor/discovery-settings|settings|both
/ip/neighbor/lldp|menu|both
/ip/packing|menu|both
/ip/pool|menu|both
/ip/pool/used|menu|both
/ip/proxy|settings|both
/ip/proxy/access|menu|both
/ip/proxy/access/reset-counters|command|both
/ip/proxy/access/reset-counters-all|command|both
/ip/proxy/cache|menu|both
/ip/proxy/cache-contents|menu|both
/ip/proxy/cache/reset-counters|command|both
/ip/proxy/cache/reset-counters-all|command|both
/ip/proxy/clear-cache|command|both
/ip/proxy/connections|menu|both
/ip/proxy/direct|menu|both
/ip/proxy/direct/reset-counters|command|both
/ip/proxy/direct/reset-counters-all|command|both
/ip/proxy/inserts|settings|both
/ip/proxy/lookups|settings|both
/ip/proxy/monitor|command|both
/ip/proxy/refreshes|settings|both
/ip/proxy/reset-html|command|both
/ip/reverse-proxy|menu|both||!smips
/ip/route|menu|both
/ip/route/check|command|both
/ip/service|menu|both
/ip/service/webserver|settings|both
/ip/settings|settings|both
/ip/smb|settings|both||!smips
/ip/smb/shares|menu|both||!smips
/ip/smb/users|menu|both||!smips
/ip/socks|settings|both
/ip/socks/access|menu|both
/ip/socks/connections|menu|both
/ip/socks/users|menu|both
/ip/socksify|menu|both
/ip/ssh|settings|both
/ip/ssh/export-host-key|command|both
/ip/ssh/import-host-key|command|both
/ip/ssh/regenerate-host-key|command|both
/ip/tftp|menu|both
/ip/tftp/settings|settings|both
/ip/traffic-flow|settings|both
/ip/traffic-flow/ipfix|settings|both
/ip/traffic-flow/monitor|command|both
/ip/traffic-flow/target|menu|both
/ip/upnp|settings|both
/ip/upnp/interfaces|menu|both
/ip/vrf|menu|both
/ipv6|menu|inspect
/ipv6/address|menu|both
/ipv6/dhcp-client|menu|both
/ipv6/dhcp-client/option|menu|both
/ipv6/dhcp-client/release|command|both
/ipv6/dhcp-client/renew|command|both
/ipv6/dhcp-relay|menu|both
/ipv6/dhcp-relay/monitor|command|both
/ipv6/dhcp-relay/option|menu|both
/ipv6/dhcp-relay/reset-counters|command|both
/ipv6/dhcp-relay/routes|menu|both
/ipv6/dhcp-server|menu|both
/ipv6/dhcp-server/binding|menu|both
/ipv6/dhcp-server/binding/make-static|command|both
/ipv6/dhcp-server/binding/send-reconfigure|command|both
/ipv6/dhcp-server/option|menu|both
/ipv6/dhcp-server/option/sets|menu|both
/ipv6/firewall|menu|inspect
/ipv6/firewall/address-list|menu|both
/ipv6/firewall/connection|menu|both
/ipv6/firewall/filter|menu|both
/ipv6/firewall/filter/reset-counters|command|both
/ipv6/firewall/filter/reset-counters-all|command|both
/ipv6/firewall/mangle|menu|both
/ipv6/firewall/mangle/reset-counters|command|both
/ipv6/firewall/mangle/reset-counters-all|command|both
/ipv6/firewall/nat|menu|both
/ipv6/firewall/nat/reset-counters|command|both
/ipv6/firewall/nat/reset-counters-all|command|both
/ipv6/firewall/raw|menu|both
/ipv6/firewall/raw/reset-counters|command|both
/ipv6/firewall/raw/reset-counters-all|command|both
/ipv6/nd|menu|both
/ipv6/nd/prefix|menu|both
/ipv6/nd/prefix/default|settings|both
/ipv6/nd/proxy|menu|both
/ipv6/nd/settings|settings|both
/ipv6/neighbor|menu|both
/ipv6/pool|menu|both
/ipv6/pool/used|menu|both
/ipv6/route|menu|both
/ipv6/settings|settings|both
/lcd|settings|published||!smips|lcd
/lcd/backlight|command|published||!smips|lcd
/lcd/interface|menu|published||!smips|lcd
/lcd/interface/default-wireless|command|published||!smips|lcd
/lcd/interface/display|command|published||!smips|lcd
/lcd/interface/pages|menu|published||!smips|lcd
/lcd/pin|settings|published||!smips|lcd
/lcd/recalibrate|command|published||!smips|lcd
/lcd/screen|menu|published||!smips|lcd
/lcd/show|command|published||!smips|lcd
/lcd/take-screenshot|command|published||!smips|lcd
/log|menu|both
/lora|menu|inspect
/lora/channels|menu|inspect
/lora/joineui|menu|inspect
/lora/netid|menu|inspect
/lora/radios|menu|inspect
/lora/servers|menu|inspect
/mpls|menu|inspect
/mpls/forwarding-table|menu|both||!smips
/mpls/interface|menu|both||!smips
/mpls/ldp|menu|both||!smips
/mpls/ldp/accept-filter|menu|both||!smips
/mpls/ldp/advertise-filter|menu|both||!smips
/mpls/ldp/interface|menu|both||!smips
/mpls/ldp/local-mapping|menu|both||!smips
/mpls/ldp/neighbor|menu|both||!smips
/mpls/ldp/remote-mapping|menu|both||!smips
/mpls/mangle|menu|both
/mpls/mangle/reset-counters|command|both
/mpls/mangle/reset-counters-all|command|both
/mpls/settings|settings|both||!smips
/mpls/traffic-eng|menu|both||!smips
/mpls/traffic-eng/flow|menu|both||!smips
/mpls/traffic-eng/interface|menu|both||!smips
/mpls/traffic-eng/path|menu|both||!smips
/mpls/traffic-eng/tunnel|menu|both||!smips
/mpls/traffic-eng/tunnel/reoptimize|command|both||!smips
/openflow|menu|both|openflow
/openflow/flow|menu|both|openflow
/openflow/group|menu|both|openflow
/openflow/meter|menu|both|openflow
/openflow/port|menu|both|openflow
/partitions|menu|published||!i386, !smips, !mmips|partitions
/partitions/activate|command|published||!i386, !smips, !mmips|partitions
/partitions/copy-to|command|published||!i386, !smips, !mmips|partitions
/partitions/repartition|command|published||!i386, !smips, !mmips|partitions
/partitions/restore-config-from|command|published||!i386, !smips, !mmips|partitions
/partitions/save-config-to|command|published||!i386, !smips, !mmips|partitions
/password|command|both
/port|menu|both
/port/remote-access|menu|both
/ppp|menu|both
/ppp/aaa|settings|both
/ppp/active|menu|both
/ppp/l2tp-secret|menu|both
/ppp/profile|menu|both
/ppp/secret|menu|both
/queue|menu|inspect
/queue/interface|menu|both
/queue/monitor|command|both
/queue/simple|menu|both
/queue/simple/reset-counters|command|both
/queue/simple/reset-counters-all|command|both
/queue/tree|menu|both
/queue/tree/reset-counters|command|both
/queue/tree/reset-counters-all|command|both
/queue/type|menu|both
/quit|command|both
/radius|menu|both
/radius/incoming|settings|both
/radius/incoming/monitor|command|both
/radius/incoming/reset-counters|command|both
/radius/monitor|command|both
/radius/reset-counters|command|both
/redo|command|both
/root|menu|published||CONSOLE_DEBUG
/root/terminal|menu|published
/routing|menu|inspect
/routing/bfd|menu|both||BFD_AUTHENTICATION
/routing/bfd/authentication|menu|published||BFD_AUTHENTICATION
/routing/bfd/configuration|menu|both||BFD_AUTHENTICATION
/routing/bfd/session|menu|both
/routing/bgp|menu|both||!smips
/routing/bgp/advertisements|menu|both||!smips
/routing/bgp/connection|menu|both||!smips
/routing/bgp/evpn|menu|both||!smips
/routing/bgp/instance|menu|both||!smips
/routing/bgp/session|menu|both||!smips
/routing/bgp/session/clear|command|both||!smips
/routing/bgp/session/dump-saved-advertisements|command|both||!smips
/routing/bgp/session/refresh|command|both||!smips
/routing/bgp/session/resend|command|both||!smips
/routing/bgp/session/stop|command|both||!smips
/routing/bgp/template|menu|both||!smips
/routing/bgp/vpls|menu|both||!smips
/routing/bgp/vpn|menu|both||!smips
/routing/discourse|command|both
/routing/fantasy|menu|both
/routing/filter|menu|both
/routing/filter/chain|menu|both
/routing/filter/community-ext-list|menu|both
/routing/filter/community-large-list|menu|both
/routing/filter/community-list|menu|both
/routing/filter/filter-wizard|command|both
/routing/filter/num-list|menu|both
/routing/filter/rule|menu|both
/routing/filter/select-rule|menu|both
/routing/filter/sync|command|both
/routing/filter/test-as-path-regexp|command|both
/routing/gmp|menu|both
/routing/id|menu|both
/routing/igmp-proxy|settings|both
/routing/igmp-proxy/interface|menu|both
/routing/igmp-proxy/mfc|menu|both
/routing/isis|menu|both
/routing/isis/instance|menu|both
/routing/isis/interface|menu|both
/routing/isis/interface-template|menu|both
/routing/isis/lsp|menu|both
/routing/isis/neighbor|menu|both
/routing/nexthop|menu|both
/routing/nexthop/dump-dot|command|both
/routing/ospf|menu|both
/routing/ospf/area|menu|both
/routing/ospf/area/range|menu|both
/routing/ospf/instance|menu|both
/routing/ospf/interface|menu|both
/routing/ospf/interface-template|menu|both
/routing/ospf/lsa|menu|both
/routing/ospf/neighbor|menu|both
/routing/ospf/static-neighbor|menu|both
/routing/pimsm|menu|both||!smips
/routing/pimsm/bsr|menu|both||!smips
/routing/pimsm/bsr/candidate|menu|both||!smips
/routing/pimsm/bsr/rp-candidate|menu|both||!smips
/routing/pimsm/bsr/rp-set|menu|both||!smips
/routing/pimsm/igmp-interface-template|menu|both||!smips
/routing/pimsm/instance|menu|both||!smips
/routing/pimsm/interface|menu|both||!smips
/routing/pimsm/interface-template|menu|both||!smips
/routing/pimsm/neighbor|menu|both||!smips
/routing/pimsm/static-rp|menu|both||!smips
/routing/pimsm/uib-g|menu|both||!smips
/routing/pimsm/uib-sg|menu|both||!smips
/routing/rip|menu|both
/routing/rip/instance|menu|both
/routing/rip/interface|menu|both
/routing/rip/interface-template|menu|both
/routing/rip/keys|menu|both
/routing/rip/neighbor|menu|both
/routing/rip/static-neighbor|menu|both
/routing/route|menu|both
/routing/route/rule|menu|inspect
/routing/rpki|menu|both
/routing/rpki/rpki-check|command|both
/routing/rpki/rpki-query|command|both
/routing/rpki/session|menu|both
/routing/rule|menu|both
/routing/settings|settings|both
/routing/stats|menu|both||!smips
/routing/stats/memory|menu|both
/routing/stats/origin|menu|both
/routing/stats/pcap|menu|both||!smips
/routing/stats/process|menu|both
/routing/stats/process/kill|command|both
/routing/stats/step|menu|both
/routing/table|menu|both
/rsync-daemon|menu|inspect
/safe-mode|settings|both
/snmp|settings|both
/snmp/community|menu|both
/snmp/send-trap|command|both
/special-login|menu|both
/system|menu|inspect
/system/backup|menu|both
/system/backup/cloud|menu|both
/system/backup/cloud/download-file|command|both
/system/backup/cloud/remove-file|command|both
/system/backup/cloud/upload-file|command|both
/system/backup/load|command|both
/system/backup/save|command|both
/system/check-disk|command|both||i386
/system/check-installation|command|both
/system/clock|settings|both
/system/clock/manual|settings|both
/system/console|menu|both
/system/console/screen|settings|both||i386
/system/default-configuration|settings|both
/system/default-configuration/caps-mode-script|settings|both
/system/default-configuration/custom-script|settings|both
/system/default-configuration/script|settings|both
/system/default-configuration/wps-sync-mode-script|settings|published|||wpssync
/system/device-mode|settings|both
/system/device-mode/update|command|both
/system/gps|settings|both|gps|mmips
/system/gps/monitor|command|both|gps
/system/hardware|menu|inspect
/system/health|menu|both||!i386
/system/health/settings|settings|both||!i386, tile|health and health-settings
/system/health/settings/detect-fans|command|both||!i386|health and health-settings
/system/history|menu|both
/system/identity|settings|both
/system/keymat-provider|menu|both
/system/keymat-provider/qkd-get-key|command|both
/system/keymat-provider/qkd-get-key-with-ids|command|both
/system/keymat-provider/qkd-get-status|command|both
/system/leds|menu|both
/system/leds/settings|settings|both
/system/license|settings|both
/system/license/generate-new-id|command|both|||chr
/system/license/output|command|published|||nochr
/system/license/renew|command|both|||chr
/system/logging|menu|both
/system/logging/action|menu|both
/system/logging/action/clear|command|both
/system/note|settings|both
/system/ntp|menu|both
/system/ntp/client|settings|both
/system/ntp/client/reset-freq-drift|command|both
/system/ntp/client/servers|menu|both
/system/ntp/key|menu|both
/system/ntp/monitor-peers|command|both
/system/ntp/server|settings|both
/system/package|menu|both
/system/package/apply-changes|command|both
/system/package/disable|command|both
/system/package/downgrade|command|both
/system/package/enable|command|both
/system/package/local-update|menu|both
/system/package/local-update/download|command|both
/system/package/local-update/download-all|command|both
/system/package/local-update/mirror|settings|both
/system/package/local-update/mirror/force-check|command|both
/system/package/local-update/refresh|command|both
/system/package/local-update/update-package-source|menu|both
/system/package/uninstall|command|both
/system/package/unschedule|command|both
/system/package/update|settings|both
/system/package/update/cancel|command|both
/system/package/update/check-for-updates|command|both
/system/package/update/download|command|both
/system/package/update/install|command|both
/system/ptp|menu|published||!smips|ptp
/system/ptp/monitor|command|published||!smips|ptp
/system/ptp/port|menu|published||!smips|ptp
/system/ptp/status|menu|published||!smips|ptp
/system/reboot|command|both
/system/regulatory|settings|both
/system/reset-configuration|command|both
/system/resource|settings|both||!powerpc, !smips
/system/resource/cpu|menu|both
/system/resource/hardware|menu|both||!powerpc, !smips, i386
/system/resource/hardware/authorize|command|both||!powerpc, !smips
/system/resource/hardware/usb-power-reset|command|both||!powerpc, !smips, i386
/system/resource/hardware/usb-settings|settings|both||!powerpc, !smips
/system/resource/irq|menu|both
/system/resource/irq/rps|menu|both|||rps
/system/resource/monitor|command|both
/system/resource/pci|menu|inspect
/system/resource/usb|menu|inspect
/system/resource/usb/settings|menu|inspect
/system/routerboard|settings|both||!i386, !i386, !mipsel, !powerpc
/system/routerboard/mode-button|settings|both||!i386
/system/routerboard/reset-button|settings|both||!i386
/system/routerboard/settings|settings|both||!i386, !i386
/system/routerboard/settings/keep-frequency|command|published||!i386, mipsel
/system/routerboard/upgrade|command|both||!i386
/system/routerboard/usb|settings|both||!i386, !i386, !mipsel, !powerpc
/system/routerboard/usb/power-reset|command|both||!i386, !i386, !mipsel, !powerpc
/system/routerboard/wps-button|settings|both||!i386
/system/rtrace|settings|both
/system/rtrace/start|command|both
/system/rtrace/stop|command|both
/system/scheduler|menu|both
/system/script|menu|both
/system/script/environment|menu|both
/system/script/job|menu|both
/system/serial-terminal|command|both
/system/shutdown|command|both
/system/ssh|command|both
/system/ssh-exec|command|both
/system/sup-output|command|both
/system/swos|settings|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/swos/load-config|command|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/swos/password|command|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/swos/reset-config|command|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/swos/save-config|command|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/swos/upgrade|command|published||!i386, !mmips, !powerpc, !tile, !smips|swos
/system/telnet|command|both
/system/upgrade|menu|inspect
/system/upgrade/mirror|menu|inspect
/system/upgrade/upgrade-package-source|menu|inspect
/system/ups|menu|both|ups
/system/ups/beep|command|both|ups
/system/ups/monitor|command|both|ups
/system/ups/rtc|command|both|ups
/system/ups/self-test|command|both|ups
/system/watchdog|settings|both
/task|menu|both
/task/add|command|both
/task/next|command|both
/task/terminate|command|both
/terminal|menu|inspect
/tool|menu|inspect
/tool/bandwidth-server|settings|both
/tool/bandwidth-server/session|menu|both
/tool/bandwidth-test|command|both
/tool/calea|menu|both|calea
/tool/dns-update|command|both
/tool/e-mail|settings|both
/tool/e-mail/send|command|both
/tool/fetch|command|both||arm64
/tool/flood-ping|command|both||!smips
/tool/graphing|settings|both
/tool/graphing/interface|menu|both
/tool/graphing/queue|menu|both
/tool/graphing/resource|menu|both
/tool/ip-scan|command|both||!smips
/tool/mac-scan|command|both||!smips
/tool/mac-server|settings|both
/tool/mac-server/mac-winbox|settings|both
/tool/mac-server/ping|settings|both
/tool/mac-server/sessions|menu|both
/tool/mac-telnet|command|both
/tool/netinstall|menu|inspect
/tool/netinstall/cache|menu|inspect
/tool/netinstall/devices|menu|inspect
/tool/netinstall/settings|menu|inspect
/tool/netwatch|menu|both
/tool/ping|command|both
/tool/ping-speed|command|both||!smips
/tool/profile|command|both
/tool/romon|settings|both
/tool/romon/discover|command|both
/tool/romon/ping|command|both
/tool/romon/port|menu|both
/tool/romon/ssh|command|both|||security
/tool/sms|settings|both||!smips
/tool/sms/inbox|menu|both||!smips
/tool/sms/send|command|both||!smips
/tool/sniffer|settings|both
/tool/sniffer/connection|menu|both
/tool/sniffer/host|menu|both
/tool/sniffer/packet|menu|both
/tool/sniffer/protocol|menu|both
/tool/sniffer/quick|command|both
/tool/sniffer/save|command|both
/tool/sniffer/start|command|both
/tool/sniffer/stop|command|both
/tool/snmp-get|command|both
/tool/snmp-walk|command|both
/tool/speed-test|command|both
/tool/torch|command|both
/tool/traceroute|command|both
/tool/traffic-generator|settings|both
/tool/traffic-generator/inject|command|both
/tool/traffic-generator/inject-pcap|command|both
/tool/traffic-generator/packet-template|menu|both
/tool/traffic-generator/port|menu|both
/tool/traffic-generator/quick|command|both
/tool/traffic-generator/raw-packet-template|menu|both
/tool/traffic-generator/start|command|both
/tool/traffic-generator/stats|menu|both
/tool/traffic-generator/stats/latency-distribution|menu|both
/tool/traffic-generator/stats/port|menu|both
/tool/traffic-generator/stats/raw|menu|both
/tool/traffic-generator/stats/stream|menu|both
/tool/traffic-generator/stop|command|both
/tool/traffic-generator/stream|menu|both
/tool/traffic-monitor|menu|both
/tool/wol|command|both
/tr069-client|settings|both|tr069-client
/tr069-client/reset-tr069-config|command|both|tr069-client
/undo|command|both
/user|menu|both
/user-manager|settings|both|userman-5
/user-manager/advanced|settings|both|userman-5
/user-manager/attribute|menu|both|userman-5
/user-manager/database|settings|both|userman-5
/user-manager/database/load|command|both|userman-5
/user-manager/database/migrate-legacy-db|command|both|userman-5
/user-manager/database/optimize-db|command|both|userman-5
/user-manager/database/save|command|both|userman-5
/user-manager/generate-report|command|both|userman-5
/user-manager/limitation|menu|both|userman-5
/user-manager/monitor|command|both|userman-5
/user-manager/payment|menu|both|userman-5
/user-manager/profile|menu|both|userman-5
/user-manager/profile-limitation|menu|both|userman-5
/user-manager/router|menu|both|userman-5
/user-manager/router/monitor|command|both|userman-5
/user-manager/router/reset-counters|command|both|userman-5
/user-manager/session|menu|both|userman-5
/user-manager/session/close-session|command|both|userman-5
/user-manager/user|menu|both|userman-5
/user-manager/user-profile|menu|both|userman-5
/user-manager/user-profile/activate-user-profile|command|both|userman-5
/user-manager/user/add-batch-users|command|both|userman-5
/user-manager/user/generate-voucher|command|both|userman-5
/user-manager/user/group|menu|both|userman-5
/user-manager/user/monitor|command|both|userman-5
/user/aaa|settings|both
/user/active|menu|both
/user/expire-password|command|both
/user/group|menu|both
/user/settings|settings|both
/user/ssh-keys|menu|both
/user/ssh-keys/import|command|both
/user/ssh-keys/private|menu|both
/user/ssh-keys/private/import|command|both
/zerotier|menu|both|zerotier
/zerotier/controller|menu|both|zerotier
/zerotier/controller/member|menu|both|zerotier
/zerotier/interface|menu|both|zerotier
/zerotier/peer|menu|both|zerotier
/zerotier/peer/hint|menu|both|zerotier
`;

const KINDS = new Set<string>(["menu", "command", "settings"]);
const PROVENANCES = new Set<string>(["inspect", "published", "both"]);

/**
 * Decode {@link ROWS} once, at module load.
 *
 * Throws rather than skipping a malformed row: this file is generated, so a row
 * that does not decode means the generator and this loader disagree, and a
 * silently shorter catalog would look exactly like a correct one.
 */
function decodeRows(text: string): Map<string, CatalogEntry> {
	const catalog = new Map<string, CatalogEntry>();
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const [path, kind, provenance, ...gates] = line.split("|");
		if (
			path === undefined ||
			kind === undefined ||
			provenance === undefined ||
			!KINDS.has(kind) ||
			!PROVENANCES.has(provenance)
		)
			throw new Error(`catalog row is malformed: ${JSON.stringify(line)}`);
		const [packageName, conditions, syscap] = gates;
		const entry: CatalogEntry = {
			kind: kind as PathKind,
			provenance: provenance as PathProvenance,
		};
		if (packageName) entry.package = packageName;
		if (conditions) entry.conditions = conditions;
		if (syscap) entry.syscap = syscap;
		catalog.set(path, entry);
	}
	return catalog;
}

/** Every catalog path, lower-cased and slash-led. */
export const PATH_CATALOG: ReadonlyMap<string, CatalogEntry> = decodeRows(ROWS);

/**
 * Look a path up by its SEGMENTS, so callers pass what they already parsed
 * rather than re-splitting a statement and re-deriving which spelling
 * (`/ip/address` or `/ip address`) it used. Both reduce to the same segments.
 *
 * Empty input is never a catalog entry: the bare `/` and `..` forms are decided
 * by their own rule.
 */
export function lookupPath(
	segments: readonly string[],
): CatalogEntry | undefined {
	if (segments.length === 0) return undefined;
	return PATH_CATALOG.get(`/${segments.join("/").toLowerCase()}`);
}

/**
 * Where a published COMMAND ends inside a path run: the index of the run
 * segment that is the VERB, or `null` when no prefix of `segments` is one.
 *
 * This is the command half of V4. `menus.ts` answers "is this bare path a
 * menu?"; nothing answered "is it a command?", so `/system/reboot` and
 * `/system/gps/monitor once` were read by punctuation — which puts the verb on
 * `once`, not on `monitor`. A published command names its own boundary, so the
 * segments before it are the menu and everything after it is an argument.
 *
 * At most ONE prefix can match: no command row has a descendant (R3, asserted at
 * generation), so the walk direction cannot change the answer.
 *
 * Presence is load-bearing in one direction only, exactly as in `menus.ts`.
 * A hit is decisive — both catalog sources are first-order, and the 439 command
 * rows are `both` or `published`, never inspect-only. A MISS says nothing:
 * generic CRUD leaves are deliberately not enumerated here, so absence must
 * fall through to the schema-free rule rather than deny that a command exists.
 *
 * A gate is not consulted. Whether this router HAS the hardware is a live
 * question; what the segment IS is not.
 */
export function commandVerbIndex(segments: readonly string[]): number | null {
	for (let depth = 1; depth <= segments.length; depth++)
		if (
			PATH_CATALOG.get(`/${segments.slice(0, depth).join("/").toLowerCase()}`)
				?.kind === "command"
		)
			return depth - 1;
	return null;
}

/** One published gate, and the path that published it. */
export interface CatalogGate {
	path: string;
	package?: string;
	conditions?: string;
	syscap?: string;
}

/**
 * Every gate that applies to a path, root-first — its own and its ancestors'.
 *
 * A row carries only what the publication stated AT that entry, which is the
 * honest thing for a row to carry but the wrong thing to read alone. Reaching
 * `/interface/ethernet/poe/monitor` requires `/interface/ethernet/poe`, so the
 * parent's `syscap` applies even though the child entry states none: the gates
 * up a path CONJOIN, they do not override.
 *
 * Read row-wise, 2 published-only paths look ungated; read with
 * ancestry the residue is 1. The gap between the two is the
 * conjunction, and it is what a caller has to reproduce: a child's silence about
 * a gate is not the absence of one. #228's finding — that a published-only path
 * almost always explains its own absence — is about the ancestry-aware number.
 *
 * Still not a claim about any router. This says what MikroTik published about
 * applicability; only a live device knows what it has.
 */
export function effectiveGates(segments: readonly string[]): CatalogGate[] {
	const gates: CatalogGate[] = [];
	for (let depth = 1; depth <= segments.length; depth++) {
		const path = `/${segments.slice(0, depth).join("/").toLowerCase()}`;
		const entry = PATH_CATALOG.get(path);
		if (entry === undefined) continue;
		const gate: CatalogGate = { path };
		if (entry.package !== undefined) gate.package = entry.package;
		if (entry.conditions !== undefined) gate.conditions = entry.conditions;
		if (entry.syscap !== undefined) gate.syscap = entry.syscap;
		if (Object.keys(gate).length > 1) gates.push(gate);
	}
	return gates;
}

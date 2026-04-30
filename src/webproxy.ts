import { plannedProtocols } from "./index.ts";

export interface WebProxyPlan {
	name: "centrs-proxy";
	purpose: string;
	protocols: readonly string[];
	defaultMaxConnections: number;
}

export const webProxyPlan: WebProxyPlan = {
	name: "centrs-proxy",
	purpose:
		"Future HTTP/WebSocket proxy and daemon surface for RouterOS REST/native API access.",
	protocols: plannedProtocols,
	defaultMaxConnections: 20,
};

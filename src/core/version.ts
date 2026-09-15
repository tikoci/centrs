import packageMetadata from "../../package.json" with { type: "json" };

/** Package version reported by every frontend and the root library surface. */
export const centrsVersion = packageMetadata.version;

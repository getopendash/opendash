// Test helpers for packages that build on core (the agent): a learned demo source in a fresh database, and a
// stand-in MCP server with its authorization server, for the analyst's connected-service tools.
export { type FakeMcp, fakeMcp } from "../test/helpers/fake-mcp";
export { type LearnedSource, learnedSource } from "../test/helpers/learned-source";

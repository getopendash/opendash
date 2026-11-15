/**
 * The client side (browser): a typed client over the RPC endpoint, and TanStack Query helpers for it. Only types come
 * from the contract's server-side imports, so nothing server-only reaches the bundle.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Contract } from "./contract";

export type ApiClient = RouterContractClient<Contract>;

export function createApiClient(url: `/${string}` = "/api/rpc"): ApiClient {
  return createORPCClient(new RPCLink({ url }));
}

export function createApiQueries(client: ApiClient) {
  return createTanstackQueryUtils(client);
}

export { isDefinedError, ORPCError } from "@orpc/client";
export type {
  AskableSource,
  Attachable,
  AttachmentInput,
  DashboardListing,
  DashboardPage,
  RecentRunView,
  RunEvent,
} from "./contract";

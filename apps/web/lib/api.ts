"use client";

import { createApiClient, createApiQueries } from "@opendash/api/client";

/** The typed API client and its TanStack Query helpers, for client components. */
export const api = createApiClient("/api/rpc");
export const apiQueries = createApiQueries(api);

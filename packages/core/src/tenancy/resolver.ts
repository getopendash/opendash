import type { TenantCtx, TenantTx } from "@opendash/db";

/**
 * TenantResourceResolver. Tools and API handlers never use raw ids
 * from callers: they resolve them here, which checks org, visibility, role, shares and ownership. RLS is the
 * backstop, not the check. A missing or foreign resource is always NotFound, never "forbidden", so existence in
 * another org can't be probed.
 */
export type Need = "read" | "write" | "admin";
export interface ResourceRef {
  type: string;
  id: string;
}

export interface ResourceResolver<T = unknown> {
  type: string;
  resolve(tx: TenantTx, ctx: TenantCtx, id: string, need: Need): Promise<T | null>;
}

export class ResourceNotFound extends Error {
  override name = "ResourceNotFound";
  constructor(readonly ref: ResourceRef) {
    super(`${ref.type} not found`);
  }
}

export class TenantResourceResolver {
  readonly #resolvers = new Map<string, ResourceResolver>();

  register(resolver: ResourceResolver): this {
    if (this.#resolvers.has(resolver.type)) throw new Error(`Resolver already registered for ${resolver.type}`);
    this.#resolvers.set(resolver.type, resolver);
    return this;
  }

  async resolve<T>(tx: TenantTx, ctx: TenantCtx, ref: ResourceRef, need: Need): Promise<T> {
    const resolver = this.#resolvers.get(ref.type);
    if (!resolver) throw new Error(`No resolver for resource type ${ref.type}`);
    const found = await resolver.resolve(tx, ctx, ref.id, need);
    if (found == null) throw new ResourceNotFound(ref);
    return found as T;
  }
}

/**
 * How an API key travels, in words: the header and its value format (`{key}` where the key goes), as an admin set them
 * for a server. A server from before formats has none: Authorization carries `Bearer <key>`, and any other header the
 * key as it is.
 */
export function keyHeaderName(header: string | null | undefined): string {
  return header?.trim() || "Authorization";
}

export function keyHeaderFormat(header: string | null | undefined, format: string | null | undefined): string {
  return format?.trim() || (keyHeaderName(header).toLowerCase() === "authorization" ? "Bearer {key}" : "{key}");
}

/** `Authorization: Bearer ••••`: what a call sends, the key hidden. */
export function keyHeaderLine(header: string | null | undefined, format: string | null | undefined): string {
  return `${keyHeaderName(header)}: ${keyHeaderFormat(header, format).replace("{key}", "••••")}`;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Gallery } from "./gallery";

export const metadata: Metadata = { title: "Design system · OpenDash" };

/** Dev-only gallery: every component in every state, light and dark. */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV === "production" && process.env.OPENDASH_DEV_GALLERY !== "1") notFound();
  return <Gallery />;
}

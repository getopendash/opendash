import { OpenDashLogo } from "@opendash/ui";
import Link from "next/link";

/** The logo at the top of the auth screens: home. */
export function BrandLogo() {
  return (
    <Link href="/" aria-label="OpenDash" className="flex items-center text-foreground">
      <OpenDashLogo className="h-7" label={null} />
    </Link>
  );
}

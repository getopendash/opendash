import { buttonVariants } from "@heroui/react";
import Link from "next/link";
import { ErrorScreen } from "@/components/errors/error-screen";

/** Something in the app that isn't there for this person (deleted, or never theirs): the sidebar stays. */
export default function AppNotFound() {
  return (
    <ErrorScreen
      title="This isn't here for you"
      actions={
        <Link href="/" className={buttonVariants({ size: "sm", variant: "outline" })}>
          Back to home
        </Link>
      }
    >
      It was deleted, or it isn't shared with you any more.
    </ErrorScreen>
  );
}

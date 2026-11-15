/** A project's letter avatar: its colour comes from its id, so it never changes and needs no setting. */
const COLORS = [
  "bg-avatar-violet",
  "bg-avatar-teal",
  "bg-avatar-rose",
  "bg-avatar-amber",
  "bg-avatar-indigo",
  "bg-avatar-sky",
] as const;

export function avatarColor(id: string): (typeof COLORS)[number] {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length] as (typeof COLORS)[number];
}

const SIZES = {
  sm: "size-4.5 rounded-md text-micro",
  md: "size-7 rounded-xl text-small",
  lg: "size-11 rounded-2xl text-heading",
} as const;

export function ProjectAvatar({ id, name, size = "sm" }: { id: string; name: string; size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-semibold text-avatar-foreground ${SIZES[size]} ${avatarColor(id)}`}
    >
      {name.trim().slice(0, 1).toUpperCase() || "P"}
    </span>
  );
}

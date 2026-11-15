"use client";

const partOfDay = (hour: number) =>
  hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

/** "Good morning, Maya" in the viewer's own time zone. */
export function Greeting({ name }: { name: string }) {
  return (
    <h1 className="text-display" suppressHydrationWarning>
      {partOfDay(new Date().getHours())}, {name}
    </h1>
  );
}

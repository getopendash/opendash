"use client";

import { Pair } from "@opendash/ui";
import { createContext, type ReactNode, useContext, useState } from "react";

/** Whether someone is writing a question in Home's composer: Pair beside the greeting listens while they are. */
const Writing = createContext<{ writing: boolean; setWriting: (writing: boolean) => void }>({
  writing: false,
  setWriting: () => {},
});

export function WritingProvider({ children }: { children: ReactNode }) {
  const [writing, setWriting] = useState(false);
  return <Writing.Provider value={{ writing, setWriting }}>{children}</Writing.Provider>;
}

export const useSetWriting = () => useContext(Writing).setWriting;

/** Pair beside Home's greeting: idle, its eyes on the pointer, and listening while a question is written. */
export function HomePair() {
  const { writing } = useContext(Writing);
  return <Pair size={36} state={writing ? "listening" : "idle"} interactive />;
}

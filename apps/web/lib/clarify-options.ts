/**
 * A clarifying question's options: short readings show as buttons in a row; a dashboard option, written
 * "Title: what it holds; its filter", or any long one, shows as a stacked row with its title in bold. Pure, so it's
 * tested on its own.
 */

export interface OptionView {
  /** What's sent when it's chosen: the option as the analyst wrote it. */
  text: string;
  title: string;
  /** What it holds and its filter, joined for reading: "MRR, new and churned MRR · filter by plan". */
  detail: string | null;
}

const TITLED = /^([^:]{2,48}):\s+(.+)$/s;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function optionViews(options: string[]): { stacked: boolean; options: OptionView[] } {
  const views = options.map((text) => {
    const m = TITLED.exec(text.trim());
    return m
      ? { text, title: (m[1] as string).trim(), detail: sentence((m[2] as string).trim().replace(/\s*;\s*/g, " · ")) }
      : { text, title: text.trim(), detail: null };
  });
  return { stacked: views.some((v) => v.detail !== null || v.title.length > 48), options: views };
}

/**
 * Whether a composer on the page holds something unsent (text or an attachment): what moves the person elsewhere on
 * its own (a build opening its dashboard) waits for it, so nothing typed is lost.
 */
const busy = new Set<symbol>();

export function setComposerBusy(token: symbol, isBusy: boolean): void {
  if (isBusy) busy.add(token);
  else busy.delete(token);
}

export const composerBusy = (): boolean => busy.size > 0;

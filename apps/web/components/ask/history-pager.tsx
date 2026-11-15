"use client";

import { Pagination } from "@heroui/react";
import { useRouter } from "next/navigation";
import { type HistoryParams, historyHref, PAGE_SIZE, pagesAround } from "@/lib/ask-filters";

/** The conversations list's footer: how many of how many, and the pages when there's more than one. */
export function HistoryPager({ params, shown, total }: { params: HistoryParams; shown: number; total: number }) {
  const router = useRouter();
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const go = (page: number) => router.push(historyHref(params, { page }));
  return (
    <div className="flex w-full items-center justify-between gap-4">
      <span>
        {shown === total
          ? total.toLocaleString("en-US")
          : `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`}{" "}
        {total === 1 ? "conversation" : "conversations"}
      </span>
      {last > 1 ? (
        <Pagination size="sm" aria-label="Pages">
          <Pagination.Content>
            <Pagination.Item>
              <Pagination.Previous isDisabled={params.page <= 1} onPress={() => go(params.page - 1)}>
                <Pagination.PreviousIcon />
                <span>Previous</span>
              </Pagination.Previous>
            </Pagination.Item>
            {pagesAround(params.page, last).map((p, i) =>
              p === "gap" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: gaps have no identity of their own.
                <Pagination.Item key={`gap-${i}`}>
                  <Pagination.Ellipsis />
                </Pagination.Item>
              ) : (
                <Pagination.Item key={p}>
                  <Pagination.Link isActive={p === params.page} onPress={() => go(p)}>
                    {p}
                  </Pagination.Link>
                </Pagination.Item>
              ),
            )}
            <Pagination.Item>
              <Pagination.Next isDisabled={params.page >= last} onPress={() => go(params.page + 1)}>
                <span>Next</span>
                <Pagination.NextIcon />
              </Pagination.Next>
            </Pagination.Item>
          </Pagination.Content>
        </Pagination>
      ) : null}
    </div>
  );
}

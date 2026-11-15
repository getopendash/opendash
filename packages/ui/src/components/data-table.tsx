"use client";

import { type SortDescriptor, Table } from "@heroui/react";
import {
  type CellData,
  columnGroupingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createExpandedRowModel,
  createGroupedRowModel,
  createSortedRowModel,
  type ReactTable,
  type RowData,
  rowExpandingFeature,
  rowSortingFeature,
  sortFns,
  type TableFeatures,
  type TableOptions,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

declare module "@tanstack/react-table" {
  interface ColumnMeta<
    in out TFeatures extends TableFeatures,
    in out TData extends RowData,
    TValue extends CellData = CellData,
  > {
    /** Right-align the column (numbers). */
    align?: "end";
    /** Classes on the column's header and cells: widths, hiding on narrow screens. */
    className?: string;
    /** The column that names the row, for screen readers. One per table. */
    rowHeader?: boolean;
  }
}

/**
 * The one feature set every table uses (Tables). Add a feature here, not per table, so there's one way to
 * write a table.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  columnGroupingFeature,
  rowExpandingFeature,
  sortedRowModel: createSortedRowModel(),
  groupedRowModel: createGroupedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  sortFns,
});
export type DataTableFeatures = typeof dataTableFeatures;
export type DataTableInstance<TData extends RowData> = ReactTable<DataTableFeatures, TData>;

/** A column helper bound to the shared features: `const col = dataColumns<Source>()`. */
export const dataColumns = <TData extends RowData>() => createColumnHelper<DataTableFeatures, TData>();

/** TanStack's table over the shared features. Pass stable `columns` (module scope) and `data`. */
export function useDataTable<TData extends RowData>(
  options: Omit<TableOptions<DataTableFeatures, TData>, "features">,
): DataTableInstance<TData> {
  return useTable({ ...options, features: dataTableFeatures });
}

const cellClass = (meta: { align?: "end"; className?: string } | undefined) =>
  [meta?.align === "end" ? "text-right" : "", meta?.className ?? ""].join(" ").trim() || undefined;

export interface DataTableProps<TData extends RowData> {
  table: DataTableInstance<TData>;
  /** What the table lists, for screen readers ("Sources"). */
  label: string;
  /** framed: a full-page list; plain: inside a card or panel. */
  variant?: "framed" | "plain";
  /** Shown under the rows (framed only): a count, a pager. */
  footer?: ReactNode;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  /** Makes each row a link to its record. */
  rowHref?: (row: TData) => string | undefined;
  /**
   * Draws only the first this many rows, after sorting (a table of hundreds draws slowly). The caller says how many
   * there are and offers the rest.
   */
  maxRows?: number;
}

/**
 * Every tabular list (Tables): TanStack owns the columns and the table state, HeroUI's Table draws it, with
 * react-aria's keyboard navigation, row links and sort indicator. Sorting goes through TanStack; HeroUI only shows it.
 * A grouped table (state `grouping: [column]`, `expanded: true`, `groupedColumnMode: "remove"`) draws each group's
 * value as a heading row across the columns, then its rows; a group with no name (an empty value) has no heading.
 */
export function DataTable<TData extends RowData>({
  table,
  label,
  variant = "framed",
  footer,
  empty,
  rowHref,
  maxRows,
}: DataTableProps<TData>) {
  const sort = table.state.sorting[0];
  const sortDescriptor: SortDescriptor | undefined = sort
    ? { column: sort.id, direction: sort.desc ? "descending" : "ascending" }
    : undefined;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  return (
    <Table
      variant={variant === "plain" ? "secondary" : "primary"}
      className={variant === "plain" ? "ui-table ui-table--plain" : "ui-table"}
    >
      <Table.ScrollContainer>
        <Table.Content
          aria-label={label}
          sortDescriptor={sortDescriptor}
          onSortChange={(d) => table.setSorting([{ id: String(d.column), desc: d.direction === "descending" }])}
        >
          <Table.Header>
            {headers.map((header) => {
              const meta = header.column.columnDef.meta;
              const sortable = header.column.getCanSort();
              return (
                <Table.Column
                  key={header.id}
                  id={header.column.id}
                  isRowHeader={meta?.rowHeader}
                  allowsSorting={sortable}
                  className={cellClass(meta)}
                >
                  {({ sortDirection }) =>
                    sortable ? (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        <table.FlexRender header={header} />
                      </Table.SortableColumnHeader>
                    ) : (
                      <table.FlexRender header={header} />
                    )
                  }
                </Table.Column>
              );
            })}
          </Table.Header>
          <Table.Body renderEmptyState={empty ? () => empty : undefined}>
            {table
              .getRowModel()
              .rows.slice(0, maxRows)
              .map((row) =>
                row.getIsGrouped() ? (
                  String(row.groupingValue ?? "") === "" ? null : (
                    <Table.Row key={row.id} id={row.id} className="ui-table__group">
                      <Table.Cell colSpan={headers.length}>{String(row.groupingValue ?? "")}</Table.Cell>
                    </Table.Row>
                  )
                ) : (
                  <Table.Row key={row.id} id={row.id} href={rowHref?.(row.original)}>
                    {row.getVisibleCells().map((cell) => (
                      <Table.Cell key={cell.id} className={cellClass(cell.column.columnDef.meta)}>
                        <table.FlexRender cell={cell} />
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ),
              )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      {footer && variant === "framed" ? <Table.Footer>{footer}</Table.Footer> : null}
    </Table>
  );
}

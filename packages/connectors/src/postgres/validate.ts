/**
 * The statement check for Postgres, with Postgres's own parser (libpg-query). It's the third layer of read-only
 * enforcement, after the read-only user and the read-only transaction: one SELECT, nothing that writes,
 * locks, creates or calls out. It also collects what grounding needs: the tables, the literals compared with columns,
 * and the aggregated columns.
 */
import { parse } from "libpg-query";
import type { DivisionSide, StatementCheck, StatementInfo } from "../dialect";

/**
 * Functions named pg_* are administration and introspection: replication, WAL, backends, files, locks, statistics
 * resets… A read-only analytics query needs only these few, so every other pg_* function is refused (an allow-list,
 * so a function nobody thought of isn't let through).
 */
const SAFE_PG = new Set([
  "pg_typeof",
  "pg_size_pretty",
  "pg_size_bytes",
  "pg_column_size",
  "pg_relation_size",
  "pg_total_relation_size",
  "pg_table_size",
  "pg_indexes_size",
  "pg_get_viewdef",
  "pg_get_expr",
  "pg_get_constraintdef",
  "pg_get_indexdef",
  "pg_get_userbyid",
  "pg_table_is_visible",
  "pg_input_is_valid",
  "pg_input_error_info",
  "pg_backend_pid",
  "pg_postmaster_start_time",
]);

/**
 * Other functions that reach outside a read-only query: other databases, large objects (lo_*, loread, lowrite),
 * session settings, sequences, transaction ids, and the ones that run SQL written as text, which the walk can't see
 * into (the *_to_xml family, ts_stat, ts_rewrite, tablefunc's crosstab and connectby, xpath_table). Functions defined
 * in the database itself (an extension's http_get, a team's own function) are refused by the dialect against the
 * server's catalog (`functionsOutsideCatalog`); these names stay refused even when one is built in.
 */
const DENIED = [
  /^ts_(stat|rewrite)$/,
  /^crosstab\d*$/,
  /^(connectby|xpath_table)$/,
  /^http(_|$)/,
  /^dblink/,
  /^lo_/,
  /^lo(read|write|creat|create|import|export|unlink|open|close|tell|tell64|seek|seek64|truncate|truncate64|put|get|from_bytea)$/,
  /^set_config$/,
  /^(nextval|setval|currval|lastval)$/,
  /^txid_/,
  /_to_xml(schema|_and_xmlschema)?$/,
];

const denied = (fn: string) => (fn.startsWith("pg_") && !SAFE_PG.has(fn)) || DENIED.some((re) => re.test(fn));

type Node = Record<string, unknown>;
const WRITES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

const str = (n: unknown) => ((n as { String?: { sval?: string } })?.String?.sval ?? "") as string;
const names = (list: unknown) => ((list as unknown[]) ?? []).map(str).filter(Boolean);

/** A division's side the advice can type: a column as written, or a count() (which returns bigint). */
function divisionSide(n: unknown): DivisionSide | null {
  const ref = columnRef(n);
  if (ref) return ref;
  const call = (n as { FuncCall?: { funcname?: unknown } } | null)?.FuncCall;
  return call && names(call.funcname).at(-1)?.toLowerCase() === "count" ? { count: true } : null;
}

function columnRef(n: unknown): { qualifier: string | null; column: string } | null {
  const ref = (n as { ColumnRef?: { fields?: unknown[] } })?.ColumnRef;
  if (!ref?.fields?.length) return null;
  const parts = names(ref.fields);
  if (parts.length !== ref.fields.length) return null; // a * or something unusual
  const column = parts.at(-1) as string;
  return { qualifier: parts.length > 1 ? (parts.at(-2) as string) : null, column };
}

function constString(n: unknown): string | null {
  let node = n as Node;
  const cast = node?.TypeCast as { arg?: unknown } | undefined;
  if (cast) node = cast.arg as Node;
  const c = node?.A_Const as { sval?: { sval?: string } } | undefined;
  return typeof c?.sval?.sval === "string" ? c.sval.sval : null;
}

/** The number of a parameter reference ($2 → 2), also inside a cast ($2::date). */
function paramNumber(n: unknown): number | null {
  let node = n as Node;
  const cast = node?.TypeCast as { arg?: unknown } | undefined;
  if (cast) node = cast.arg as Node;
  const p = node?.ParamRef as { number?: number } | undefined;
  return typeof p?.number === "number" ? p.number : null;
}

/** The constant strings and parameter numbers in a list of expressions (an IN list, an ARRAY[…]). */
function valuesOf(items: unknown[]): { values: string[]; params: number[] } {
  const values = items.map(constString).filter((v): v is string => v !== null);
  const params = items.map(paramNumber).filter((v): v is number => v !== null);
  return { values, params };
}

type TableRef = { schema: string | null; name: string; alias: string | null };

/** The tables directly in a FROM clause (through joins, not into subqueries): what an unqualified * expands to. */
function directTables(node: unknown, out: TableRef[]) {
  const n = node as Node;
  const range = n?.RangeVar as Node | undefined;
  if (range) {
    out.push({
      schema: (range.schemaname as string | undefined) ?? null,
      name: range.relname as string,
      alias: ((range.alias as { aliasname?: string } | undefined)?.aliasname ?? null) as string | null,
    });
    return;
  }
  const join = n?.JoinExpr as Node | undefined;
  if (join) {
    directTables(join.larg, out);
    directTables(join.rarg, out);
  }
}

/** Collects the columns and stars a select-list entry returns, skipping what's inside count(). */
function returned(node: unknown, info: StatementInfo, from: TableRef[]) {
  if (Array.isArray(node)) {
    for (const n of node) returned(n, info, from);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, raw] of Object.entries(node as Node)) {
    if (key === "FuncCall" && (names((raw as Node).funcname).at(-1) ?? "").toLowerCase() === "count") continue;
    if (key === "SubLink") continue; // a subquery's own select list is checked as its own SelectStmt
    if (key === "ColumnRef") {
      const fields = ((raw as Node).fields as unknown[] | undefined) ?? [];
      if (fields.some((f) => (f as Node)?.A_Star !== undefined)) {
        const parts = names(fields);
        info.stars.push({ qualifier: parts.length ? (parts.at(-1) as string) : null, from });
        continue;
      }
      const ref = columnRef({ ColumnRef: raw });
      if (ref) info.returned.push(ref);
      continue;
    }
    returned(raw, info, from);
  }
}

export async function validatePostgres(sql: string): Promise<StatementCheck> {
  if (!sql.trim()) return { ok: false, kind: "empty", message: "There's no statement to run." };
  let parsed: { stmts?: { stmt?: Node }[] };
  try {
    parsed = await parse(sql);
  } catch (error) {
    const e = error as { message?: string; sqlDetails?: { cursorPosition?: number } };
    const position = e.sqlDetails?.cursorPosition;
    return {
      ok: false,
      kind: "syntax",
      message: e.message ?? "The SQL couldn't be parsed.",
      ...(position !== undefined ? { position: position + 1 } : {}),
    };
  }
  const stmts = parsed.stmts ?? [];
  if (stmts.length === 0) return { ok: false, kind: "empty", message: "There's no statement to run." };
  if (stmts.length > 1) {
    return { ok: false, kind: "multiple_statements", message: "Send one statement at a time." };
  }
  const stmt = stmts[0]?.stmt ?? {};
  const kind = Object.keys(stmt)[0] ?? "";
  if (kind !== "SelectStmt") {
    const what = kind.replace(/Stmt$/, "").toUpperCase() || "That statement";
    return { ok: false, kind: "not_a_query", message: `${what} isn't allowed: OpenDash only runs SELECT queries.` };
  }

  const info: StatementInfo = {
    tables: [],
    literals: [],
    aggregates: [],
    joins: 0,
    references: [],
    returned: [],
    stars: [],
    params: [],
    identifiers: [],
  };
  // Names written in the statement: String nodes (column, function and type name parts) and the name properties.
  // Literals are A_Const nodes, never String ones, so no value lands here.
  const identifiers = new Set<string>();
  const params = new Set<number>();
  const functions = new Set<string>();
  const operators = new Set<string>();
  const types = new Set<string>();
  let problem: StatementCheck | null = null;
  const fail = (k: Exclude<StatementCheck, { ok: true }>["kind"], message: string) => {
    problem ??= { ok: false, kind: k, message };
  };

  /**
   * Checks one SELECT and records what it returns. The branches of UNION / INTERSECT / EXCEPT (larg, rarg) are bare
   * SelectStmt objects in the parse tree, without the { SelectStmt: … } wrapper, so they're handled here explicitly.
   */
  const selectStmt = (node: Node, scope: ReadonlySet<string>) => {
    if (node.intoClause) return fail("creates_table", "SELECT INTO creates a table; OpenDash only reads.");
    if ((node.lockingClause as unknown[] | undefined)?.length) {
      return fail("locks_rows", "FOR UPDATE / FOR SHARE locks rows; OpenDash only reads.");
    }
    const from = (node.fromClause as unknown[] | undefined) ?? [];
    if (from.length > 1) info.joins += from.length - 1;
    // What the statement returns: columns in the select list (outside count(), which returns no values), and
    // stars. Whole-row references (to_jsonb(u)) are single-name refs the gateway resolves against aliases.
    // Its stars read the tables in its FROM, never a CTE it can see (a CTE's columns are its own query's).
    const visible = withNames(node, scope).all;
    const direct: TableRef[] = [];
    for (const f of from) directTables(f, direct);
    const tables = direct.filter((t) => t.schema !== null || !visible.has(t.name));
    for (const target of (node.targetList as unknown[] | undefined) ?? []) returned(target, info, tables);
    for (const branch of [node.larg, node.rarg]) {
      if (branch && typeof branch === "object") selectStmt(branch as Node, visible);
    }
  };

  /**
   * The CTE names a query can see, as Postgres resolves them: its own WITH's, and those of the queries around it. A
   * CTE's body sees the ones before it in its WITH (all of them, itself included, when it's RECURSIVE), so in
   * `with users as (select … from users)` the inner users is the table. One name for the whole statement, as before,
   * let a CTE named like a table hide that table from every check, wherever it was written.
   */
  const withNames = (node: Node, scope: ReadonlySet<string>) => {
    const clause = node.withClause as { ctes?: unknown[]; recursive?: boolean } | undefined;
    const defs = (clause?.ctes ?? [])
      .map((c) => (c as { CommonTableExpr?: Node }).CommonTableExpr)
      .filter((d): d is Node => !!d && typeof d.ctename === "string");
    const all = new Set([...scope, ...defs.map((d) => d.ctename as string)]);
    return { defs, all, recursive: clause?.recursive === true };
  };

  const visit = (value: unknown, scope: ReadonlySet<string>) => {
    if (problem) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, scope);
      return;
    }
    if (!value || typeof value !== "object") return;
    // A query with a WITH: each CTE's body is read with the names it can see, the query itself with all of them.
    const own = withNames(value as Node, scope);
    own.defs.forEach((d, i) => {
      identifiers.add(d.ctename as string);
      const sees = own.recursive
        ? own.all
        : new Set([...scope, ...own.defs.slice(0, i).map((x) => x.ctename as string)]);
      visit(d.ctequery, sees);
      visit(d.aliascolnames, sees);
    });
    const inner = own.all;
    for (const [key, raw] of Object.entries(value as Node)) {
      if (key === "withClause") continue;
      const node = raw as Node;
      if (WRITES.has(key))
        return fail("writes_data", "The query changes data (in a WITH clause); OpenDash only reads.");
      if (key === "SelectStmt") {
        selectStmt(node, inner);
        if (problem) return;
      }
      if (key === "JoinExpr") info.joins += 1;
      // A table, unless it names a CTE this query can see.
      if (key === "RangeVar" && (typeof node.schemaname === "string" || !inner.has(node.relname as string))) {
        info.tables.push({
          schema: (node.schemaname as string | undefined) ?? null,
          name: node.relname as string,
          alias: ((node.alias as { aliasname?: string } | undefined)?.aliasname ?? null) as string | null,
        });
      }
      // A table sample's method (tablesample system (10)) is a function too: checked like a call.
      if (key === "RangeTableSample") {
        const parts = names(node.method);
        if (parts.length > 1 && parts[0] !== "pg_catalog") {
          return fail(
            "denied_function",
            `${parts.join(".")} isn't a built-in sampling method; OpenDash runs built-in ones only.`,
          );
        }
        if (parts.at(-1)) functions.add(parts.at(-1) as string);
      }
      if (key === "FuncCall") {
        const parts = names(node.funcname);
        // Names as the parser read them: unquoted ones are folded already, a quoted one ("PEEK") is another name.
        const exact = parts.at(-1) ?? "";
        const fn = exact.toLowerCase();
        if (denied(fn)) return fail("denied_function", `${fn}() isn't allowed in OpenDash queries.`);
        // A function named with its schema is the database's own (or an extension's): only pg_catalog's are built in.
        if (parts.length > 1 && parts[0] !== "pg_catalog") {
          return fail(
            "denied_function",
            `${parts.join(".")}() isn't a built-in function; OpenDash runs built-in ones only.`,
          );
        }
        functions.add(exact);
        if (["sum", "avg", "count", "min", "max"].includes(fn) && !node.agg_star) {
          for (const arg of (node.args as unknown[] | undefined) ?? []) {
            const ref = columnRef(arg);
            if (ref) info.aggregates.push({ fn, ...ref });
          }
        }
      }
      if (key === "ColumnRef") {
        const ref = columnRef({ ColumnRef: node });
        if (ref) info.references.push(ref);
      }
      if (key === "ParamRef" && typeof node.number === "number") params.add(node.number);
      if (key === "String" && typeof node.sval === "string") identifiers.add(node.sval);
      for (const prop of ["relname", "schemaname", "aliasname", "ctename"]) {
        if (typeof node[prop] === "string") identifiers.add(node[prop] as string);
      }
      if (key === "ResTarget" && typeof node.name === "string") identifiers.add(node.name);
      // Operators and types run functions too (an operator's code, a type's input or cast): the server is asked
      // about them as about calls (`refuseCalls`); one named with a schema outside pg_catalog is refused here.
      // A cast's or a column definition's type is a bare `typeName` property; elsewhere a { TypeName } node.
      // Operators are named in an expression (A_Expr), a subquery comparison (x = any (select …), SubLink's
      // operName) and an ordering (order by x using <, SortBy's useOp).
      const named =
        key === "A_Expr"
          ? { kind: "operator", list: node.name }
          : key === "SubLink"
            ? { kind: "operator", list: node.operName }
            : key === "SortBy"
              ? { kind: "operator", list: node.useOp }
              : key === "TypeName" || key === "typeName"
                ? { kind: "type", list: node.names }
                : null;
      // Comparisons the parser writes no operator for: case x when y, x in (select …).
      if (
        (key === "CaseExpr" && node.arg) ||
        (key === "SubLink" && !node.operName && node.subLinkType === "ANY_SUBLINK")
      ) {
        operators.add("=");
      }
      if (named?.list) {
        const parts = names(named.list);
        const exact = parts.at(-1);
        if (parts.length > 1 && parts[0] !== "pg_catalog") {
          return fail(
            "denied_function",
            `${parts.join(".")} isn't a built-in ${named.kind}; OpenDash runs built-in ones only.`,
          );
        }
        if (exact) (named.kind === "operator" ? operators : types).add(exact);
      }
      if (key === "A_Expr") {
        const op = names(node.name)[0];
        const left = columnRef(node.lexpr);
        const right = columnRef(node.rexpr);
        const push = (ref: { qualifier: string | null; column: string } | null, found: ReturnType<typeof valuesOf>) => {
          if (ref && (found.values.length || found.params.length)) info.literals.push({ ...ref, ...found });
        };
        if (node.kind === "AEXPR_OP" && op === "/") {
          const [left, right] = [divisionSide(node.lexpr), divisionSide(node.rexpr)];
          if (left && right) info.divisions = [...(info.divisions ?? []), { left, right }];
        }
        if (node.kind === "AEXPR_OP" && (op === "=" || op === "<>" || op === "!=")) {
          push(left ?? right, valuesOf([left ? node.rexpr : node.lexpr]));
        } else if (node.kind === "AEXPR_IN" && left) {
          push(left, valuesOf((node.rexpr as { List?: { items?: unknown[] } })?.List?.items ?? []));
        } else if ((node.kind === "AEXPR_OP_ANY" || node.kind === "AEXPR_OP_ALL") && left && op === "=") {
          // c = any($1) with a list parameter, or c = any(array['a', 'b'])
          const array = (node.rexpr as { A_ArrayExpr?: { elements?: unknown[] } })?.A_ArrayExpr?.elements;
          push(left, valuesOf(array ?? [node.rexpr]));
        }
      }
      visit(raw, inner);
    }
  };
  visit(stmt, new Set());
  if (problem) return problem;
  info.params = [...params].sort((a, b) => a - b);
  info.identifiers = [...identifiers];
  info.functions = [...functions].sort();
  info.operators = [...operators].sort();
  info.types = [...types].sort();
  return { ok: true, info };
}

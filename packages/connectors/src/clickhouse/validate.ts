/**
 * The statement check for ClickHouse, from the server's own analysis (tree.ts): `EXPLAIN AST` says what kind of
 * statement it is, `EXPLAIN QUERY TREE` what it reads and returns. The rules match Postgres's: one SELECT (or UNION),
 * nothing that writes or reaches outside the database, plus what ClickHouse adds:
 *   - no FORMAT / INTO OUTFILE (OpenDash reads the result itself) and no SETTINGS clause (OpenDash sets the limits);
 *   - no table functions (url, s3, remote, file, mysql…) beyond a few that generate rows;
 *   - no sleep;
 *   - no outer joins for a readonly = 1 user whose server's joins don't return NULL (session.ts).
 * Columns come back resolved to their base tables, so personal-data checks see through CTEs and subqueries.
 */
import type { QueryParam, StatementCheck, StatementInfo } from "../dialect";
import { QueryError } from "../dialect";
import { type ClickHouseSession, queryText } from "./session";
import { analyse, parseTree, structureProblem, type TreeNode } from "./tree";

/** Table functions that only generate rows. Every other one reads files, URLs or other databases. */
const SAFE_TABLE_FUNCTIONS = new Set([
  "numbers",
  "numbers_mt",
  "zeros",
  "zeros_mt",
  "generateseries",
  "generate_series",
]);
/**
 * Scalar functions that read data no table node shows (dictionaries, Join-engine tables, files) or the server's
 * filesystem, and sleep. Dictionaries matter most: dictGet reads table data past the catalog and personal-data rules.
 */
const DENIED_FUNCTIONS = [/^dict/i, /^joinget/i, /^file$/i, /^filesystem/i, /^sleep(eachrow)?$/i];

/** The format queryText asks for, which therefore shows up in EXPLAIN AST. */
const EXPLAIN_FORMAT = "TabSeparatedRaw";

/** Names written in the statement, from the server's syntax tree: identifiers, functions and aliases, not literals. */
function astIdentifiers(roots: TreeNode[]): string[] {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop() as TreeNode;
    stack.push(...n.children);
    const m = /^(?:Identifier|TableIdentifier|Function) (\S+)/.exec(n.label);
    if (m?.[1]) for (const part of m[1].replace(/`/g, "").split(".")) out.add(part);
    const alias = /\(alias ([^)]+)\)/.exec(n.label)?.[1];
    if (alias) out.add(alias.replace(/`/g, ""));
  }
  return [...out];
}

/** {name:Type} placeholders, outside string literals and comments. */
export function placeholderNames(sql: string): string[] {
  const code = sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...code.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1] as string))];
}

/**
 * Quoted identifiers (`…` or "…") with line breaks, other control characters or backslash escapes. ClickHouse's
 * explain output prints names as they are, one node per line, so such a name could forge nodes in it.
 */
export function unsafeIdentifier(sql: string): string | null {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (c === "'") {
      // String literal: skip it (escapes inside are fine, and ClickHouse prints literals escaped).
      i += 1;
      while (i < sql.length && sql[i] !== "'") i += sql[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "`" || c === '"') {
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== c) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
        if (sql[i] === "\\" || /[\u0000-\u001f\u007f]/.test(sql[i] as string))
          return sql.slice(start, Math.min(i + 12, sql.length));
        i += 1;
      }
      i += 1;
    } else i += 1;
  }
  return null;
}

/** Query parameters as the client sends them: values by name. */
export const paramValues = (params: QueryParam[]) => Object.fromEntries(params.map((p) => [p.name, p.value]));

function astProblem(roots: TreeNode[]): StatementCheck | null {
  const root = roots[0];
  if (!root) return { ok: false, kind: "empty", message: "There's no statement to run." };
  const kind = /^(\w+)/.exec(root.label)?.[1] ?? "";
  if (kind !== "SelectWithUnionQuery") {
    const what = kind.replace(/Query$/, "").toUpperCase() || "That statement";
    return { ok: false, kind: "not_a_query", message: `${what} isn't allowed: OpenDash only runs SELECT queries.` };
  }
  // The client adds FORMAT TabSeparatedRaw to read the explain output, so the root's last child is that; anything
  // more is a FORMAT or INTO OUTFILE of the statement's own (a second FORMAT is already a syntax error).
  const last = root.children.at(-1);
  if (root.children.length !== 2 || last?.label !== `Identifier ${EXPLAIN_FORMAT}`) {
    return {
      ok: false,
      kind: "denied_clause",
      message: "FORMAT and INTO OUTFILE aren't allowed: OpenDash reads the result itself.",
    };
  }
  // AST labels are "Kind [name] (children N)"; compare by kind.
  const kindOf = (n: TreeNode) => n.label.split(" ")[0];
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop() as TreeNode;
    stack.push(...n.children);
    if (kindOf(n) === "Set") {
      return {
        ok: false,
        kind: "denied_clause",
        message: "A SETTINGS clause isn't allowed: OpenDash sets the limits.",
      };
    }
    if (kindOf(n) === "TableExpression") {
      const fn = n.children.find((c) => c.label.startsWith("Function "));
      const name = fn ? (/^Function (\S+)/.exec(fn.label)?.[1] ?? "") : "";
      if (fn && !SAFE_TABLE_FUNCTIONS.has(name.toLowerCase())) {
        return {
          ok: false,
          kind: "denied_function",
          message: `${name}() reads from outside the database's tables; OpenDash doesn't run it.`,
        };
      }
    }
    const fn = /^Function (\S+)/.exec(n.label)?.[1];
    if (fn && DENIED_FUNCTIONS.some((re) => re.test(fn))) {
      return {
        ok: false,
        kind: "denied_function",
        message: /^dict|^joinget/i.test(fn)
          ? `${fn}() reads data outside the tables OpenDash learned; query the tables themselves.`
          : `${fn}() isn't allowed in OpenDash queries.`,
      };
    }
  }
  return null;
}

export async function validateClickHouse(
  sql: string,
  context: {
    session: () => Promise<unknown>;
    params: QueryParam[];
    timeoutMs: number;
    signal?: AbortSignal;
    parseError: (error: unknown, where?: import("./dialect").ErrorStage) => import("../dialect").QueryErrorInfo;
  },
): Promise<
  StatementCheck | { ok: false; kind: "server"; error: import("../dialect").QueryErrorInfo; identifiers?: string[] }
> {
  if (!sql.trim()) return { ok: false, kind: "empty", message: "There's no statement to run." };
  const session = (await context.session()) as ClickHouseSession;
  const timing = { timeoutMs: context.timeoutMs, ...(context.signal ? { signal: context.signal } : {}) };
  // The server's canonical one-line form of the statement: comments and heredocs gone, names escaped the same way
  // every time. Everything below reads it, and it's what runs, so neither our lexer nor a difference between the
  // checked and the executed text can disagree with the server's own reading.
  let canonical: string;
  try {
    canonical = (
      await queryText(session, "SELECT formatQuerySingleLine({q:String})", { ...timing, params: { q: sql } })
    ).replace(/\n$/, "");
  } catch (error) {
    const info = context.parseError(error, { stage: "parse" });
    if (info.kind === "syntax") {
      const multiple = /Multi-statements are not allowed/i.test(info.message);
      return {
        ok: false,
        kind: multiple ? "multiple_statements" : "syntax",
        message: multiple ? "Send one statement at a time." : info.message,
        ...(info.position ? { position: info.position } : {}),
      };
    }
    return { ok: false, kind: "server", error: info };
  }
  const used = placeholderNames(canonical);
  const missing = used.filter((n) => !context.params.some((p) => p.name === n));
  if (missing.length) {
    return {
      ok: false,
      kind: "server",
      error: {
        kind: "other",
        message: `The SQL uses ${missing.map((n) => `{${n}}`).join(", ")} but no parameter has ${missing.length === 1 ? "that name" : "those names"}.`,
      },
    };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
  if (/[\u0000-\u001f\u007f]/.test(canonical) || unsafeIdentifier(canonical) !== null) {
    return {
      ok: false,
      kind: "denied_clause",
      message: "Quoted names can't contain line breaks, control characters or backslash escapes; use plain names.",
    };
  }
  const options = { ...timing, params: paramValues(context.params) };
  let ast: string;
  try {
    ast = await queryText(session, `EXPLAIN AST ${canonical}`, options);
  } catch (error) {
    // The canonical text already parsed, so treat whatever this says as coming from analysis, not the SQL.
    const info = context.parseError(error, { stage: "analyse", sql: canonical });
    if (info.kind === "syntax") {
      const multiple = /Multi-statements are not allowed/i.test(info.message);
      return {
        ok: false,
        kind: multiple ? "multiple_statements" : "syntax",
        message: multiple ? "Send one statement at a time." : info.message,
        ...(info.position ? { position: info.position } : {}),
      };
    }
    // Table functions reaching outside are refused by the server's grants before it even parses them for us.
    const source = /grant (?:READ|WRITE) ON (\w+)/i.exec(info.message)?.[1];
    if (info.kind === "permission" && source) {
      return {
        ok: false,
        kind: "denied_function",
        message: `${source.toLowerCase()}() reads from outside the database's tables; OpenDash doesn't run it.`,
      };
    }
    return { ok: false, kind: "server", error: info };
  }
  const astRoots = parseTree(ast, 1);
  const identifiers = astIdentifiers(astRoots);
  if (structureProblem(astRoots, "ast")) {
    return { ok: false, kind: "not_a_query", message: "OpenDash couldn't read the server's analysis of this query." };
  }
  const problem = astProblem(astRoots);
  if (problem) return problem;

  let tree: string;
  try {
    tree = await queryText(session, `EXPLAIN QUERY TREE ${canonical}`, options);
  } catch (error) {
    const info =
      error instanceof QueryError ? error.info : context.parseError(error, { stage: "analyse", sql: canonical });
    return { ok: false, kind: "server", error: info, identifiers };
  }
  const a = analyse(parseTree(tree, 2));
  if (a.untrusted) {
    return {
      ok: false,
      kind: "not_a_query",
      message: `OpenDash couldn't trace this query's columns (${a.untrusted}), so it doesn't run it.`,
    };
  }
  const outside = a.tableFunctions.find((f) => !SAFE_TABLE_FUNCTIONS.has(f.toLowerCase()));
  if (outside) {
    return {
      ok: false,
      kind: "denied_function",
      message: `${outside}() reads from outside the database's tables; OpenDash doesn't run it.`,
    };
  }
  // A readonly = 1 user runs with its server's join_use_nulls: if that's off, an outer join's missing rows come back
  // as 0 and '' instead of NULL, and an average or a count over them is quietly wrong.
  if (a.outerJoins > 0 && session.fixed && !session.fixed.joinNulls) {
    return {
      ok: false,
      kind: "denied_clause",
      message:
        "This server's outer joins return 0 and '' instead of NULL for missing rows, so LEFT, RIGHT and FULL joins aren't allowed here. Use an inner join, or a subquery with IN or NOT IN.",
    };
  }
  // Qualifiers are database.table, which is also each table's alias here, so the gateway resolves them directly.
  const split = (fq: string) => {
    const parts = fq.split(".");
    return { qualifier: parts.slice(0, -1).join("."), column: parts.at(-1) as string };
  };
  // A query without FROM reads system.one, a one-row table with a single 0: no data, so not a table to ground.
  const tables = a.tables.filter((t) => !(t.database === "system" && t.table === "one"));
  const info: StatementInfo = {
    tables: tables.map((t) => ({
      schema: t.database,
      name: t.table,
      alias: `${t.database}.${t.table}`,
      final: t.final,
    })),
    literals: a.literals.map((l) => ({ ...split(l.column), values: l.values, params: [] })),
    aggregates: a.aggregates.map((g) => ({ fn: g.fn, ...split(g.column) })),
    aggregated: [...a.aggregated].map(split),
    joins: a.joins,
    references: [...a.referenced].map(split),
    returned: [...a.returned].map(split),
    stars: [],
    params: used,
    identifiers,
    // What runs: the canonical text that was checked.
    sql: canonical,
  };
  return { ok: true, info };
}

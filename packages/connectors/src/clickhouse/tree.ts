/**
 * Reading ClickHouse's own analysis of a statement (`EXPLAIN AST` and `EXPLAIN QUERY TREE`), which stands in for a
 * SQL parser: there's none for ClickHouse in JavaScript, and the server's analyzer is better anyway. It has already
 * resolved every column to the table it comes from, through CTEs, subqueries and aliases.
 *
 * Both outputs are indented text, one node per line: `FUNCTION id: 5, function_name: sum, …` under `ARGUMENTS`,
 * `LIST`, `PROJECTION`… This module parses that text into a tree and answers what the gateway needs: the tables read,
 * the base columns each output value is computed from, literals compared with columns, and aggregates.
 */

export interface TreeNode {
  /** QUERY, COLUMN, FUNCTION, TABLE… or a section heading: PROJECTION, ARGUMENTS, JOIN TREE, WHERE… */
  label: string;
  attrs: Record<string, string>;
  /** The rest of the line for lines that aren't nodes, e.g. "country LowCardinality(String)" under PROJECTION COLUMNS. */
  text: string;
  children: TreeNode[];
}

/** Splits "id: 2, column_name: country, result_type: Tuple(String, String)" at the top-level ", key: ". */
function parseAttrs(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    // Strings are ClickHouse literals: 'DE', with \' and \\ escaped inside.
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0 && rest[i + 1] === " " && /^[a-z_]+: /.test(rest.slice(i + 2))) {
      parts.push(rest.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(rest.slice(start));
  for (const part of parts) {
    const m = /^([a-z_]+): ([\s\S]*)$/.exec(part.trim());
    if (m) attrs[m[1] as string] = m[2] as string;
  }
  return attrs;
}

/** Parses indented explain output. `width` is the indent per level: 2 for QUERY TREE, 1 for AST. */
export function parseTree(text: string, width: number): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { depth: number; node: TreeNode }[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const depth = Math.floor((raw.length - raw.trimStart().length) / width);
    const line = raw.trim();
    // "FUNCTION id: 5, …" is a node with attributes; "PROJECTION COLUMNS" or "Function sum (children 1)" isn't.
    const m = /^([A-Z_ ]+?) id: (.*)$/.exec(line);
    const node: TreeNode = m
      ? { label: (m[1] as string).trim(), attrs: parseAttrs(`id: ${m[2]}`), text: "", children: [] }
      : { label: line, attrs: {}, text: line, children: [] };
    while (stack.length && (stack.at(-1) as { depth: number }).depth >= depth) stack.pop();
    if (stack.length) (stack.at(-1) as { node: TreeNode }).node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  }
  return roots;
}

function* walk(node: TreeNode): Generator<TreeNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/** The strings in a constant: 'DE' → [DE]; Tuple_('DE', 'FR') → [DE, FR]. Numbers and others → []. */
export function constantStrings(value: string): string[] {
  return [...value.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => (m[1] as string).replace(/\\(.)/g, "$1"));
}

export interface AnalysedStatement {
  /** The tables read; `final` when every read of it says FINAL (a ReplacingMergeTree's newest rows only). */
  tables: { database: string; table: string; final: boolean }[];
  tableFunctions: string[];
  /** Base columns (database.table.column) whose values reach the result, other than through count() / uniq(). */
  returned: Set<string>;
  /** Every base column the statement touches anywhere. */
  referenced: Set<string>;
  literals: { column: string; values: string[] }[];
  aggregates: { fn: string; column: string }[];
  /** Base columns read anywhere inside an aggregate's arguments: sum(x * sign), sumIf(x, …). */
  aggregated: Set<string>;
  joins: number;
  /** LEFT, RIGHT and FULL joins, whose missing rows are NULL only with join_use_nulls. */
  outerJoins: number;
  /** Why the analysis can't be trusted, when it can't: a column from an unknown kind of source, or a malformed tree. */
  untrusted: string | null;
}

/** The node kinds a column's source_id may point at, and that this module knows how to trace. */
const SOURCES = ["QUERY", "UNION", "TABLE", "TABLE_FUNCTION", "ARRAY_JOIN", "LAMBDA", "JOIN"];

/**
 * The explain text is lines, and names (aliases, columns, tables) are printed as they are, so a name with a line
 * break could forge nodes. Names like that are refused before explaining (validate.ts) and kept out of the catalog;
 * this is the second guard: the tree must add up. Every LIST has the number of nodes it declares, every AST node
 * the number of children, there's one root, each query has one of each section and as many output names as outputs.
 */
export function structureProblem(roots: TreeNode[], kind: "ast" | "tree"): string | null {
  if (roots.length !== 1) return "more than one root";
  for (const n of roots.flatMap((r) => [...walk(r)])) {
    if (kind === "ast") {
      const declared = /\(children (\d+)\)$/.exec(n.label)?.[1];
      if (declared !== undefined && Number(declared) !== n.children.length)
        return `${n.label} has ${n.children.length}`;
      continue;
    }
    if (n.label === "LIST" && Number(n.attrs.nodes) !== n.children.length) return "a list's size";
    if (n.label === "QUERY") {
      const sections = n.children.map((c) => c.label);
      if (new Set(sections).size !== sections.length) return "a repeated section";
      const names = n.children.find((c) => c.label === "PROJECTION COLUMNS")?.children.length ?? 0;
      const items =
        n.children.find((c) => c.label === "PROJECTION")?.children.find((c) => c.label === "LIST")?.children.length ??
        0;
      if (names !== items) return "output names and outputs";
    }
  }
  return null;
}

/**
 * Aggregates whose result is a count, never a value of their argument: an exact list (with their If forms), not a
 * prefix, so a combinator (-State, -Array, -ForEach…) or anything new is assumed to carry values.
 */
const COUNTING = new Set(
  ["count", "countDistinct", "uniq", "uniqExact", "uniqCombined", "uniqCombined64", "uniqHLL12", "uniqTheta"].flatMap(
    (f) => [f.toLowerCase(), `${f.toLowerCase()}if`],
  ),
);

export function analyse(roots: TreeNode[]): AnalysedStatement {
  const byId = new Map<string, TreeNode>();
  const all = roots.flatMap((r) => [...walk(r)]);
  for (const n of all) {
    // A node is listed in full once; later mentions (GROUP BY reusing a projection column) repeat its id.
    if (n.attrs.id && SOURCES.includes(n.label)) {
      if (!byId.has(n.attrs.id)) byId.set(n.attrs.id, n);
    }
  }
  const section = (n: TreeNode, label: string) => n.children.find((c) => c.label === label);
  const tableName = (t: TreeNode) => t.attrs.table_name ?? "";
  const base = (t: TreeNode, column: string) => `${tableName(t)}.${column}`;

  /**
   * The projection items of a QUERY, in order, and their names. "name Type" lines are ambiguous for names with
   * spaces or punctuation (and types have spaces too), so only plain identifiers are kept; others are blank, and a
   * reference to them falls back to every output of the query.
   */
  const projection = (q: TreeNode) => {
    const list = section(q, "PROJECTION")?.children.find((c) => c.label === "LIST");
    const names = (section(q, "PROJECTION COLUMNS")?.children ?? []).map((c) => {
      const name = /^([A-Za-z_][A-Za-z0-9_]*) /.exec(c.text)?.[1];
      return name ?? "";
    });
    return { items: list?.children ?? [], names };
  };
  /** The position of an output name, only when it's a plain identifier that appears exactly once. */
  const indexOfName = (names: string[], column: string) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(column) && names.filter((n) => n === column).length === 1
      ? names.indexOf(column)
      : -1;

  let untrusted: string | null = structureProblem(roots, "tree");
  const memo = new Map<TreeNode, Set<string>>();
  const visiting = new Set<TreeNode>();
  const union = (sets: Set<string>[]) => new Set(sets.flatMap((s) => [...s]));

  /** The base columns that flow into a node's value. */
  const flow = (n: TreeNode): Set<string> => {
    const cached = memo.get(n);
    if (cached) return cached;
    if (visiting.has(n)) return new Set();
    visiting.add(n);
    let out: Set<string>;
    switch (n.label) {
      case "COLUMN": {
        const source = byId.get(n.attrs.source_id ?? "");
        const column = n.attrs.column_name ?? "";
        if (!source) {
          // Fail closed: a column we can't trace could carry anything.
          untrusted ??= `the source of ${column || "a column"} isn't known`;
          out = new Set();
        } else if (source.label === "TABLE") out = new Set([base(source, column)]);
        else if (source.label === "QUERY" || source.label === "UNION") out = outputFlow(source, column);
        // JOIN … USING, ARRAY JOIN and lambda arguments: everything under the source, to be safe.
        else out = union(source.children.map(flow));
        break;
      }
      case "CONSTANT":
        // The analyzer folds scalar subqueries and constant expressions into constants, and keeps what they came
        // from under EXPRESSION: (select email from users limit 1) arrives here as the email itself. Follow it.
        out = union(n.children.filter((c) => c.label === "EXPRESSION").flatMap((e) => e.children.map(flow)));
        break;
      case "FUNCTION":
        out =
          n.attrs.function_type === "aggregate" && COUNTING.has((n.attrs.function_name ?? "").toLowerCase())
            ? new Set()
            : union(n.children.map(flow));
        break;
      case "QUERY":
      case "UNION":
        // A scalar subquery inside an expression: whatever it returns.
        out = allOutputs(n);
        break;
      default:
        out = union(n.children.map(flow));
    }
    visiting.delete(n);
    memo.set(n, out);
    return out;
  };

  /** What flows into one named output of a QUERY or UNION. */
  const outputFlow = (q: TreeNode, column: string): Set<string> => {
    if (q.label === "UNION") {
      const queries = (section(q, "QUERIES")?.children.find((c) => c.label === "LIST")?.children ?? []).filter(
        (c) => c.label === "QUERY" || c.label === "UNION",
      );
      const first = queries[0];
      const index = first ? indexOfName(projection(first).names, column) : -1;
      return union(queries.map((member) => (index >= 0 ? flowAt(member, index) : allOutputs(member))));
    }
    const { items, names } = projection(q);
    const index = indexOfName(names, column);
    return index >= 0 && items[index] ? flow(items[index] as TreeNode) : union(items.map(flow));
  };

  const flowAt = (q: TreeNode, index: number): Set<string> => {
    if (q.label === "UNION") {
      const queries = section(q, "QUERIES")?.children.find((c) => c.label === "LIST")?.children ?? [];
      return union(queries.map((m) => flowAt(m, index)));
    }
    const item = projection(q).items[index];
    return item ? flow(item) : new Set();
  };

  const allOutputs = (q: TreeNode): Set<string> => {
    if (q.label === "UNION") {
      const queries = section(q, "QUERIES")?.children.find((c) => c.label === "LIST")?.children ?? [];
      return union(queries.map(allOutputs));
    }
    return union(projection(q).items.map(flow));
  };

  const root = roots[0];
  const returned = root ? allOutputs(root) : new Set<string>();

  const unique = new Map<string, AnalysedStatement["tables"][number]>();
  for (const n of all) {
    if (n.label !== "TABLE" || !n.attrs.table_name) continue;
    const name = tableName(n);
    const dot = name.indexOf(".");
    const final = n.attrs.final === "1";
    const had = unique.get(name);
    unique.set(name, {
      database: name.slice(0, dot),
      table: name.slice(dot + 1),
      final: (had?.final ?? true) && final,
    });
  }

  const referenced = new Set<string>();
  const literals: AnalysedStatement["literals"] = [];
  const aggregates: AnalysedStatement["aggregates"] = [];
  const aggregated = new Set<string>();
  for (const n of all) {
    if (n.label === "COLUMN") {
      const source = byId.get(n.attrs.source_id ?? "");
      if (source?.label === "TABLE") referenced.add(base(source, n.attrs.column_name ?? ""));
    }
    if (n.label !== "FUNCTION") continue;
    const args =
      n.children.find((c) => c.label === "ARGUMENTS")?.children.find((c) => c.label === "LIST")?.children ?? [];
    const fn = (n.attrs.function_name ?? "").toLowerCase();
    if (["equals", "notequals", "in", "notin", "has"].includes(fn) && args.length === 2) {
      const [a, b] = args as [TreeNode, TreeNode];
      const column = a.label === "COLUMN" ? a : b.label === "COLUMN" ? b : null;
      const constant = a.label === "CONSTANT" ? a : b.label === "CONSTANT" ? b : null;
      const columns = column ? [...flow(column)] : [];
      // Only a literal typed in the SQL (or a parameter cast to its type), never a constant folded from a subquery.
      const folded = constant ? [...walk(constant)].some((x) => x.label === "COLUMN" || x.label === "QUERY") : false;
      if (column && constant && !folded && columns.length === 1) {
        const values = constantStrings(constant.attrs.constant_value ?? "");
        if (values.length) literals.push({ column: columns[0] as string, values });
      }
    }
    if (n.attrs.function_type === "aggregate") {
      for (const arg of args)
        for (const x of walk(arg)) if (x.label === "COLUMN") for (const c of flow(x)) aggregated.add(c);
    }
    if (n.attrs.function_type === "aggregate" && ["sum", "avg", "count", "min", "max"].includes(fn)) {
      for (const arg of args) {
        if (arg.label !== "COLUMN") continue;
        const source = byId.get(arg.attrs.source_id ?? "");
        if (source?.label === "TABLE") aggregates.push({ fn, column: base(source, arg.attrs.column_name ?? "") });
      }
    }
  }

  return {
    tables: [...unique.values()],
    tableFunctions: all.filter((n) => n.label === "TABLE_FUNCTION").map((n) => n.attrs.table_function_name ?? "?"),
    returned,
    referenced,
    literals,
    aggregates,
    aggregated,
    joins: all.filter((n) => n.label === "JOIN").length,
    outerJoins: all.filter((n) => n.label === "JOIN" && /^(LEFT|RIGHT|FULL)$/.test(n.attrs.kind ?? "")).length,
    untrusted,
  };
}

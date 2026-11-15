// An App's code check's rules, on the syntax tree (not regexes over text): the secure step, typed figures, style, imports.
// A builder gets each failure with its file, line and a fix it can act on.
import ts from "typescript";

export interface Finding {
  rule: "secure" | "typed-figure" | "style" | "import";
  file: string;
  line: number;
  message: string;
}

const BANNED_CALLS = new Set(["eval", "fetch", "importScripts", "Function"]);
const BANNED_NEW = new Set([
  "Function",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "RTCPeerConnection",
  "Worker",
  "SharedWorker",
  "Image",
]);
const BANNED_IDS = new Set([
  "parent",
  "top",
  "opener",
  "location",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document",
]);
/** Globals an App may not index into by a computed name (`window["fe" + "tch"]`): every name it uses is checked. */
const GLOBAL_OBJECTS = new Set(["window", "self", "globalThis", "document", "navigator", "frames"]);
const BANNED_PROPS = new Set([
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "postMessage",
  "sendBeacon",
  "cookie",
  "parent",
  "top",
  "opener",
  "location",
]);
const LAYOUT_PROPS = new Set([
  "width",
  "height",
  "pageSize",
  "size",
  "offset",
  "limit",
  "cols",
  "gap",
  "min",
  "max",
  "step",
  "style",
  "span",
  "rows",
  "key",
]);
// A figure in fixed text: money, a percentage, a number with separators, or a decimal. A plain whole number (an id,
// a year, "Top 10") isn't one.
const FIGURE = /(\$\s?\d)|(\d\s?%)|(\d{1,3}(,\d{3})+)|(\d+\.\d+)/;
const COLOUR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch)\(/i;
// Elements the runtime's lockdown refuses to create: caught here, so it's a build error with a fix, not a crash.
const BANNED_TAGS = new Set([
  "a",
  "area",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "form",
  "object",
  "embed",
  "script",
  "audio",
  "video",
  "source",
  "track",
  "portal",
]);

export function checkRules(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2022,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const add = (rule: Finding["rule"], n: ts.Node, message: string) => out.push({ rule, file, line: at(n), message });
    const insideCall = (n: ts.Node, name: string) => {
      for (let p = n.parent; p; p = p.parent)
        if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === name) return true;
      return false;
    };
    const insideLayoutProp = (n: ts.Node) => {
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isJsxAttribute(p) && LAYOUT_PROPS.has(p.name.getText(sf))) return true;
        if (ts.isPropertyAssignment(p) && LAYOUT_PROPS.has(p.name.getText(sf))) return true;
      }
      return false;
    };

    // Names the file declares itself (a local "top" isn't window.top).
    const declared = new Set<string>();
    const collect = (n: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(n) ||
          ts.isParameter(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isBindingElement(n) ||
          ts.isImportSpecifier(n) ||
          ts.isImportClause(n)) &&
        n.name &&
        ts.isIdentifier(n.name)
      )
        declared.add(n.name.text);
      ts.forEachChild(n, collect);
    };
    collect(sf);

    const visit = (n: ts.Node): void => {
      // ---- imports
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier &&
        ts.isStringLiteral(n.moduleSpecifier)
      ) {
        const m = n.moduleSpecifier.text;
        if (!(m.startsWith("./") || m.startsWith("../") || m === "react" || m === "@opendash/app"))
          add("import", n, `Imports are limited to its own files, react and @opendash/app; remove “${m}”.`);
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
        add("secure", n, "Dynamic import() isn't allowed in an App.");
      // ---- the secure step
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && BANNED_CALLS.has(n.expression.text))
        add("secure", n, `${n.expression.text}() isn't allowed: an App reads data only through useQuery.`);
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        /^set(Timeout|Interval)$/.test(n.expression.text) &&
        n.arguments[0] &&
        ts.isStringLiteralLike(n.arguments[0])
      )
        add("secure", n, `${n.expression.text} with a string runs it as code; pass a function.`);
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && BANNED_NEW.has(n.expression.text))
        add("secure", n, `new ${n.expression.text}() isn't allowed in an App.`);
      // A banned global, read as itself: not a property's name (`x.top`), a key (`{ top: 1 }`) or a declaration.
      const isName = (n: ts.Identifier) =>
        (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) ||
        (ts.isPropertyAssignment(n.parent) && n.parent.name === n) ||
        ts.isBindingElement(n.parent) ||
        ts.isVariableDeclaration(n.parent) ||
        ts.isParameter(n.parent) ||
        ts.isJsxAttribute(n.parent) ||
        ts.isShorthandPropertyAssignment(n.parent);
      if (ts.isIdentifier(n) && BANNED_IDS.has(n.text) && !declared.has(n.text) && !isName(n))
        add("secure", n, `“${n.text}” isn't allowed: the frame has no parent, storage or cookies of its own.`);
      if (ts.isPropertyAccessExpression(n) && BANNED_PROPS.has(n.name.text) && !ts.isJsxAttribute(n.parent)) {
        const obj = n.expression.getText(sf);
        if (
          ["window", "document", "self", "globalThis", "navigator"].includes(obj) ||
          ["innerHTML", "outerHTML", "insertAdjacentHTML", "postMessage", "sendBeacon"].includes(n.name.text)
        )
          add("secure", n, `${obj}.${n.name.text} isn't allowed in an App.`);
      }
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        ts.isIdentifier(n.tagName) &&
        BANNED_TAGS.has(n.tagName.text)
      )
        add(
          "secure",
          n,
          `<${n.tagName.text}> isn't available in an App.${n.tagName.text === "a" ? " Use the kit's links, which open through OpenDash." : ""}`,
        );
      if (ts.isElementAccessExpression(n)) {
        // Through parentheses and casts: (window as any)["fe" + "tch"] is window["fe" + "tch"].
        let target: ts.Expression = n.expression;
        while (
          ts.isParenthesizedExpression(target) ||
          ts.isAsExpression(target) ||
          ts.isTypeAssertionExpression(target) ||
          ts.isNonNullExpression(target) ||
          ts.isSatisfiesExpression(target)
        )
          target = target.expression;
        if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text) && !declared.has(target.text))
          add("secure", n, `${target.text}[…] isn't allowed in an App. name what you use.`);
      }
      if (ts.isJsxAttribute(n) && n.name.getText(sf) === "dangerouslySetInnerHTML")
        add("secure", n, "dangerouslySetInnerHTML isn't allowed: render text, not HTML from data.");
      if (
        ts.isPropertyAccessExpression(n) &&
        n.expression.getText(sf) === "document" &&
        /^(write|writeln)$/.test(n.name.text)
      )
        add("secure", n, "document.write isn't allowed.");

      // ---- typed figures: numbers belong in queries or declared assumptions
      if (ts.isArrayLiteralExpression(n) && !insideCall(n, "useAssumption")) {
        const els = n.elements;
        if (
          els.length >= 3 &&
          els.every((e) => ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)))
        )
          add(
            "typed-figure",
            n,
            "An array of numbers is typed data. Read it with useQuery, or declare it with useAssumption.",
          );
        else if (
          els.length >= 3 &&
          els.every(
            (e) =>
              ts.isObjectLiteralExpression(e) &&
              e.properties.some(
                (p) =>
                  ts.isPropertyAssignment(p) &&
                  ts.isNumericLiteral(p.initializer) &&
                  !LAYOUT_PROPS.has(p.name.getText(sf)),
              ),
          )
        )
          add("typed-figure", n, "A table of numbers is typed data. Read it with useQuery.");
      }
      if (ts.isJsxText(n) && FIGURE.test(n.text))
        add(
          "typed-figure",
          n,
          `A figure in fixed text (“${n.text.trim().slice(0, 40)}”). Put the number in a Value from a query or derive().`,
        );
      if (
        ts.isStringLiteralLike(n) &&
        ts.isJsxAttribute(n.parent) &&
        ["title", "label", "subtitle", "hint", "placeholder"].includes(n.parent.name.getText(sf)) &&
        FIGURE.test(n.text)
      )
        add("typed-figure", n, `A figure in a ${n.parent.name.getText(sf)} (“${n.text.slice(0, 40)}”). Use a Value.`);
      if (
        ts.isJsxAttribute(n) &&
        ["value", "of"].includes(n.name.getText(sf)) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        ts.isNumericLiteral(n.initializer.expression)
      )
        add("typed-figure", n, "A typed number passed as a value. Use a query cell, derive() or useAssumption().");
      // ---- style: colours come from the kit's tokens
      if (ts.isStringLiteralLike(n) && COLOUR.test(n.text) && !insideLayoutProp(n.parent ?? n))
        add(
          "style",
          n,
          `A colour literal (“${n.text.slice(0, 30)}”). Use the kit's tokens, var(--accent) and friends.`,
        );
      if (ts.isStringLiteralLike(n) && COLOUR.test(n.text) && insideLayoutProp(n))
        add("style", n, `A colour literal in a style (“${n.text.slice(0, 30)}”). Use var(--…) tokens.`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * OpenDash's own skills: ways of working that ship with the code, in the Agent Skills shape (a name, when to
 * use it, its steps), beside the ones a team approves. They're in the knowledge folder at /skills/opendash/<name>/SKILL.md
 * and listed in the analyst's skills. Versioned with the code: bump `version` when a body changes,
 * so a run's record says which it followed. A skill earns a file of its own when more than one agent can use it; an
 * agent's own method stays in its prompt.
 */
import { appDesign } from "./app-design";
import { buildAnApp } from "./build-an-app";
import { investigateAChange } from "./investigate-a-change";
import { reactAppCraft } from "./react-app-craft";

export interface BuiltinSkill {
  /** Its folder's name, kebab-case. */
  name: string;
  title: string;
  version: number;
  /** When to use it, as a team skill's "use it when" says it. */
  description: string;
  body: string;
  /**
   * Files beside its SKILL.md, read when the work needs them (Agent Skills' references, one level deep): served at
   * /skills/opendash/<name>/<file>, at the skill's version.
   */
  references?: { file: string; title: string; body: string }[];
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [investigateAChange];

/**
 * OpenDash's reference skills: readable in the folder like the others, but not in the skills list every question gets
 * (it stays as it was). Another skill names them where they're needed: build-an-app points at the two after it. It's
 * here itself for its own references (services.md), which it names by path: a skill given in the prompt is still a
 * folder, or a path it points at reads nothing.
 */
export const REFERENCE_SKILLS: BuiltinSkill[] = [buildAnApp, appDesign, reactAppCraft];

/** Where the knowledge folder serves OpenDash's own skills; a team skill can't be named this. */
export const BUILTIN_FOLDER = "/skills/opendash";

export const builtinPath = (s: Pick<BuiltinSkill, "name">) => `${BUILTIN_FOLDER}/${s.name}/SKILL.md`;

/** A built-in's id in the run's record: not a team item's (they're ids of the database's), so never linked as one. */
export const builtinId = (s: Pick<BuiltinSkill, "name">) => `opendash/${s.name}`;

/** Its file as the folder serves it: the Agent Skills frontmatter, then its steps. */
export const skillFile = (s: BuiltinSkill) =>
  `---\nname: ${s.name}\ndescription: ${s.description}\nversion: ${s.version}\n---\n\n${s.body}`;

export { appDesign, investigateAChange, reactAppCraft };

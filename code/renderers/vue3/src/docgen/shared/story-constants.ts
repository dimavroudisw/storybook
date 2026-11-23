import {
  type ESTreeNode as Node,
  type ReferenceContext,
  unwrapExpression,
} from 'storybook/internal/csf-tools';

import { collectFreeExpression } from '../story-docs/transform-template/forward-setup.ts';
import {
  isFunctionExpression,
  isResolvable,
  printValue,
  RESOLVABLE_GLOBALS,
} from './classify-value.ts';

/** A `const` the story file declares at module level, which a snippet can declare again. */
export interface StoryConstant {
  /** The value it is declared with, as the snippet prints it. */
  source: string;
  /** The other story constants that value reads, which the snippet declares before it. */
  uses: string[];
  /** Where the story file declares it, which orders the snippet's declarations. */
  start: number;
}

export type StoryConstants = ReadonlyMap<string, StoryConstant>;

const NO_NAMES: ReadonlySet<string> = new Set();

/** The names an expression reads from the scope it is written in, but JavaScript's globals. */
export function referencedNames(node: Node): string[] | undefined {
  const free = new Set<string>();
  if (!collectFreeExpression(node, NO_NAMES, free)) {
    return undefined;
  }
  return [...free].filter((name) => !RESOLVABLE_GLOBALS.has(name));
}

/**
 * The module-level constants the story's arg values read, each with the constants it reads in turn.
 *
 * An arg written as `lines.length` or as `` `<pre>${lines.join('\n')}</pre>` `` means nothing where
 * the snippet lands unless `lines` is declared there too, so the snippet carries the declaration
 * over. Only a `const` whose value the snippet can print qualifies: an import, a `let`, a
 * destructured name or a value reading one of those is left for the caller to report.
 *
 * @example `const lines = ['a']; args: { count: lines.length }` → `lines` declared as `['a']`
 */
export function collectStoryConstants(
  args: Record<string, Node>,
  ctx: ReferenceContext
): StoryConstants {
  const constants = new Map<string, StoryConstant>();
  const rejected = new Set<string>();
  const bindings = ctx.editor.scopes.program.bindings;

  const declarable = (name: string, visiting: Set<string>): boolean => {
    if (constants.has(name)) {
      return true;
    }
    // A constant that reads itself through another has no order to be declared in.
    if (rejected.has(name) || visiting.has(name)) {
      return false;
    }

    const binding = bindings.get(name);
    const declarator =
      binding?.constant &&
      binding.node.type === 'VariableDeclarator' &&
      binding.node.id.type === 'Identifier'
        ? binding.node
        : undefined;
    const init = declarator?.init ? unwrapExpression(declarator.init) : undefined;
    const uses = init && referencedNames(init);
    if (!init || !uses) {
      rejected.add(name);
      return false;
    }

    visiting.add(name);
    const readable =
      uses.every((used) => declarable(used, visiting)) &&
      (isFunctionExpression(init) || isResolvable(init, new Set(uses)));
    visiting.delete(name);
    if (!readable) {
      rejected.add(name);
      return false;
    }

    constants.set(name, {
      source: printValue(init),
      uses,
      start: (declarator as Node & { start: number }).start,
    });
    return true;
  };

  for (const value of Object.values(args)) {
    for (const name of referencedNames(unwrapExpression(value)) ?? []) {
      declarable(name, new Set());
    }
  }

  return constants;
}

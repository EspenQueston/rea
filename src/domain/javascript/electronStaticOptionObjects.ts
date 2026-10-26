import * as t from "@babel/types";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStableInitializer,
  type JavaScriptBindingIndex,
} from "./javascriptSemanticState.js";

/** Lexical candidates alone do not establish that object contents are intact. */
const optionObjectCandidate = (
  input: t.Node | undefined,
  index: JavaScriptBindingIndex,
):
  | {
      readonly object: t.ObjectExpression;
      readonly references: readonly OptionObjectReference[];
    }
  | undefined => {
  if (input === undefined) return undefined;
  let node = unwrapJavaScriptExpression(input).node;
  const seen = new Set<t.Node>();
  const references: OptionObjectReference[] = [];
  while (t.isIdentifier(node)) {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const binding = index.bindingForReferenceAt(node);
    if (binding === undefined) return undefined;
    const initializer = semanticStableInitializer(binding, index.bindings);
    if (
      binding.mutable ||
      binding.declarationKinds.size !== 1 ||
      !binding.declarationKinds.has("const") ||
      initializer === undefined ||
      initializer.projection.length !== 0
    )
      return undefined;
    const sameActivation = semanticBindingAtRead(
      binding,
      node,
      index.bindings.parentsByNode,
    ).hasDefiniteInitializer;
    if (
      !sameActivation &&
      (!initializedBeforeEnclosingFunction(
        node,
        initializer.node,
        index.bindings.parentsByNode,
      ) ||
        exportedModuleBinding(
          binding.name,
          initializer.node,
          index.bindings.program,
          index.bindings.parentsByNode,
        ))
    )
      return undefined;
    references.push({ node, sameActivation });
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isObjectExpression(node) ? { object: node, references } : undefined;
};

type OptionObjectReference = {
  readonly node: t.Identifier;
  /** False when a nested function reads a const declared before it. */
  readonly sameActivation: boolean;
};

/**
 * A nested function can only read an outer const after its declaration ran,
 * so a completed read observes that initializer. Only accept declarations that
 * end before the function starts; hoisted or interleaved orders stay unknown.
 */
const initializedBeforeEnclosingFunction = (
  read: t.Node,
  initializer: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  let owner = parents.get(read);
  while (owner !== undefined && !t.isFunction(owner))
    owner = parents.get(owner);
  return (
    owner !== undefined &&
    typeof initializer.end === "number" &&
    typeof owner.start === "number" &&
    initializer.end <= owner.start
  );
};

/** Importers can change an exported object before a later activation reads it. */
const exportedModuleBinding = (
  name: string,
  initializer: t.Node,
  program: t.Program,
  parents: WeakMap<t.Node, t.Node>,
): boolean => {
  let declaration = parents.get(initializer);
  while (declaration !== undefined && !t.isVariableDeclaration(declaration))
    declaration = parents.get(declaration);
  const owner =
    declaration === undefined ? undefined : parents.get(declaration);
  if (t.isExportNamedDeclaration(owner)) return true;
  if (owner !== program) return false;
  return program.body.some(
    (statement) =>
      (t.isExportNamedDeclaration(statement) &&
        statement.source == null &&
        statement.specifiers.some(
          (specifier) =>
            t.isExportSpecifier(specifier) && specifier.local.name === name,
        )) ||
      (t.isExportDefaultDeclaration(statement) &&
        t.isIdentifier(statement.declaration) &&
        statement.declaration.name === name),
  );
};

/** Avoid building mutation facts for parameters, missing or unresolved objects. */
export const hasElectronOptionObjectCandidate = (
  input: t.Node | undefined,
  index: JavaScriptBindingIndex,
): boolean => optionObjectCandidate(input, index) !== undefined;

/** Select an inert const object using the shared lexical and mutation owner. */
export const resolveElectronOptionObject = (
  input: t.Node | undefined,
  site: t.Node,
  index: JavaScriptBindingIndex,
  propertyPath: readonly string[] = [],
): t.ObjectExpression | undefined => {
  const candidate = optionObjectCandidate(input, index);
  if (candidate === undefined) return undefined;
  for (const { node, sameActivation } of candidate.references) {
    if (sameActivation) {
      if (index.referenceMayHaveChangedAt(site, node, propertyPath))
        return undefined;
      continue;
    }
    // Other activations can run in any order, including repeated calls of
    // this function, so any relevant write or escape keeps the object unknown.
    // The constructor argument itself is the one escape that follows the read.
    const { resolution, effects } = index.effectsForReferenceAt(
      site,
      node,
      propertyPath,
    );
    if (
      resolution !== "resolved" ||
      effects.length > 1 ||
      effects.some(
        ({ kind, timing }) => kind !== "escape" || timing !== "after",
      )
    )
      return undefined;
  }
  return candidate.object;
};

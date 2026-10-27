import * as t from "@babel/types";
import { semanticKnownSymbolKey } from "./javascriptSemanticPropertyKeys.js";
import {
  createAmbientPathResolver,
  retainSemanticAmbientEffect,
} from "./javascriptSemanticAmbientWrites.js";
import { isIntrinsicMapLookup } from "./javascriptSemanticMapOperations.js";
import {
  isIntrinsicTypedArrayConstruction,
  isTypedArrayNumericIndex,
} from "./javascriptSemanticTypedArrays.js";

import {
  semanticGlobalProcessOrigin,
  semanticGlobalProcessPathOrigin,
  semanticOriginalGlobalProcessAt,
  semanticMutableBuiltinOrigin,
  semanticRequireExportsIdentity,
  semanticRequireOrigin,
  semanticRequireLoaderAt,
  hasSemanticCreateRequireFactoryOrigin,
} from "./javascriptSemanticRequireOrigin.js";

import {
  resolveSemanticBindingState,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  clearSemanticValueCaches,
  evaluateSemanticBinding,
  evaluateSemanticExpression,
} from "./javascriptSemanticValues.js";
import { semanticContainer } from "./javascriptSemanticSlots.js";
import {
  semanticProjectedSourceFactsAtRead,
  semanticShiftCapturedSelections,
  semanticNormalizeCapturedSelections,
  type SemanticCapturedSelection,
} from "./javascriptSemanticProjectedSources.js";

import {
  semanticArrayPropertyReferences,
  semanticClassCandidates,
  semanticClassPropertyReferences,
  semanticClassAccessorReferences,
  semanticObjectPropertyReferences,
  semanticObjectAccessorReferences,
  type JavaScriptSemanticObjectReference,
} from "./javascriptSemanticObjectReferences.js";
import {
  semanticIterationSources,
  semanticPropertyReadSources,
  type SemanticIterationSource,
  type SemanticPropertyReadSource,
} from "./javascriptSemanticIterationSources.js";
import { semanticGetterReceiverReferences } from "./javascriptSemanticGetterResults.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import {
  semanticMutationInitializers,
  semanticBindingAtRead,
  semanticCaptureOrderingIdentity,
  semanticScopeExitEffect,
} from "./javascriptSemanticMutationInitializers.js";
import { semanticCoercionOperands } from "./javascriptSemanticLanguageInvocations.js";
import { SEMANTIC_ALIAS_SELECTION_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  semanticCopiedReferencePath,
  semanticKnownArrayIteration,
  semanticReferenceSourcesInactive,
  semanticSelectedReferenceSlot,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  joinSemanticPropertyPaths,
  SemanticPropertyPathCoverage,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import {
  traverseJavaScriptValueAstSteps,
  childNodes,
} from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteSiteReadsFirst,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  SEMANTIC_MEMBER_MUTATION_WORKLIST_LIMIT,
  SEMANTIC_MEMBER_MUTATION_TOTAL_STEPS_LIMIT,
  SEMANTIC_MEMBER_MUTATION_FIXPOINT_ROUNDS_LIMIT,
} from "./javascriptSemanticResourceLimits.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
interface MutationSelectionContext {
  readonly memberReadAt?: t.Node | undefined;
  readonly capturedSelections?:
    | readonly SemanticCapturedSelection[]
    | undefined;
}

type ValueEffect = "write" | "escape";

/** Only replacing or possibly selecting an iterator-bearing prototype slot changes iteration. */
const arrayPrototypeIterationMayChange = (path: PropertyPath): boolean => {
  // Array.prototype and Object.prototype are on native arrays' prototype
  // chain. Their default constructor.prototype pairs return to the same owner.
  let offset = 0;
  while (path[offset] === "constructor" && path[offset + 1] === "prototype")
    offset += 2;
  const key = path[offset];
  return (
    key === undefined ||
    key === null ||
    typeof key === "object" ||
    semanticArrayIndex(key) !== null ||
    key === "__proto__"
  );
};

/** Preserve uncertainty from property writes and references exposed to calls, yielding during traversal and fixpoint iteration. */

/** Accessor selection uses the same slots, prototype shadowing and array indices as aliases. */
const localAccessorMethods = (
  root: t.Node,
  path: PropertyPath,
  accessor: "get" | "set",
  state: JavaScriptSemanticAnalysisState,
  keyMayExist: (
    key: PropertyPath[number] | undefined,
    kind: "get" | "set",
  ) => boolean,
  lookup: "prototype" | "own" = "prototype",
): readonly (t.ObjectMethod | t.ClassMethod)[] | undefined => {
  if (!keyMayExist(path.at(-1), accessor)) return [];
  const methods = new Set<t.ObjectMethod | t.ClassMethod>();
  const pending = [{ node: root, path }];
  const examined = new WeakMap<t.Node, Set<string>>();
  let selections = 0;
  
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const current = pending[cursor]!;
    const node = unwrapJavaScriptExpression(current.node).node;
    const key = JSON.stringify(current.path);
    const paths = examined.get(node) ?? new Set<string>();
    if (paths.has(key)) continue;
    paths.add(key);
    examined.set(node, paths);
    
    if (++selections > SEMANTIC_ALIAS_SELECTION_LIMIT) {
      state.valueResourceLimits.add("alias-selections");
      return undefined;
    }
    
    if (
      (t.isObjectMethod(node) || t.isClassMethod(node)) &&
      current.path.length === 0
    ) {
      methods.add(node);
      continue;
    }
    
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined) continue;
      const selected = semanticBindingAtRead(
        binding,
        node,
        state.parentsByNode,
      ).binding;
      for (const source of [
        ...selected.initializers,
        ...selected.referenceInitializers,
      ])
        pending.push({
          node: source.node,
          path: [...source.projection, ...current.path],
        });
    } else if (
      t.isMemberExpression(node) ||
      t.isOptionalMemberExpression(node)
    ) {
      pending.push({
        node: node.object,
        path: [
          semanticStaticPropertyKey(node.property, node.computed),
          ...current.path,
        ],
      });
    } else if (
      current.path.length > 0 &&
      (t.isObjectExpression(node) || t.isArrayExpression(node))
    ) {
      const [selected, ...remaining] = current.path;
      const references = t.isArrayExpression(node)
        ? semanticArrayPropertyReferences(node, [selected!])
        : remaining.length === 0
          ? semanticObjectAccessorReferences(
              node,
              selected!,
              state,
              accessor,
              lookup,
            )
          : semanticObjectPropertyReferences(node, [selected!], state);
      for (const source of references)
        pending.push({
          node: source.node,
          path: [...source.path, ...remaining],
        });
    } else if (
      (t.isClass(node) || t.isNewExpression(node)) &&
      current.path.length > 0
    ) {
      const [selected, ...remaining] = current.path;
      const owners = t.isClass(node)
        ? [node]
        : semanticClassCandidates(node.callee, state);
      for (const owner of owners) {
        const selection = {
          owner,
          kind: t.isClass(node) ? ("static" as const) : ("instance" as const),
        };
        const references =
          remaining.length > 0
            ? semanticClassPropertyReferences(selection, [selected!], state)
            : lookup === "own"
              ? []
              : semanticClassAccessorReferences(
                  selection,
                  selected!,
                  state,
                  accessor,
                );
        for (const source of references)
          pending.push({
            node: source.node,
            path: [...source.path, ...remaining],
          });
      }
    }
  }
  
  return Array.from(methods);
};

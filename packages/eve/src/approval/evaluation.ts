import type { ApprovalContext } from "#approval/definition.js";

export interface ApprovalGrant {
  readonly toolName: string;
  readonly interactionId: string;
}

export interface OnceApproval {
  readonly grantable: boolean;
}

interface Evaluation {
  readonly grants: readonly ApprovalGrant[];
  readonly recheck?: boolean;
}

// Enumerable symbols survive policy context spreads without entering JSON or the public type.
const evaluationKey = Symbol("eve.approval-evaluation");
type EvaluatedContext = ApprovalContext & { readonly [evaluationKey]?: Evaluation };

// Credit goes to once() only when a policy returns these exact objects, not an equal status.
const onceGranted = Object.freeze({ type: "not-applicable" as const });
const onceRequired = Object.freeze({ type: "user-approval" as const });

function withEvaluation<T extends ApprovalContext>(context: T, evaluation: Evaluation): T {
  return { ...context, [evaluationKey]: Object.freeze(evaluation) };
}

export function withApprovalGrants<T extends ApprovalContext>(
  context: T,
  grants: readonly ApprovalGrant[],
): T {
  return withEvaluation(context, {
    grants: Object.freeze(
      grants.map(({ toolName, interactionId }) => Object.freeze({ toolName, interactionId })),
    ),
    recheck: approvalEvaluation(context)?.recheck,
  });
}

export function evaluateOnce(context: ApprovalContext): typeof onceGranted | typeof onceRequired {
  const granted = approvalEvaluation(context)?.grants.some(
    (grant) => grant.toolName === context.toolName,
  );
  return granted === true ? onceGranted : onceRequired;
}

/** Which once() decision a policy returned, if its result is one. */
export function onceOutcome(status: unknown): "granted" | "required" | undefined {
  if (status === onceGranted) return "granted";
  if (status === onceRequired) return "required";
  return undefined;
}

function approvalEvaluation(context: ApprovalContext): Evaluation | undefined {
  return (context as EvaluatedContext)[evaluationKey];
}

export function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  return withEvaluation(context, {
    grants: approvalEvaluation(context)?.grants ?? [],
    recheck: true,
  });
}

export function inheritApprovalContext<T extends ApprovalContext>(
  source: ApprovalContext,
  context: T,
): T {
  const evaluation = approvalEvaluation(source);
  if (evaluation === undefined || approvalEvaluation(context) === evaluation) return context;
  return { ...context, [evaluationKey]: evaluation };
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return approvalEvaluation(context)?.recheck === true;
}

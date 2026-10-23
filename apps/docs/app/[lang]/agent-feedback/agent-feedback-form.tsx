"use client";

import { Button } from "@vercel/geistdocs/components/button";
import { Bot, ChevronDown, Info, Undo2, X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AgentFeedbackReport,
  type IncludedItems,
  decodeReportHash,
  deployTargetLabels,
  frequencyLabels,
  includeEverything,
  outcomeLabels,
  reportLimits,
  reviewReport,
  triggerReasonLabels,
} from "@/lib/agent-feedback/report";
import type { SubmitResult } from "@/lib/agent-feedback/submit";
import { cn } from "@/lib/utils";
import { submitAgentFeedback } from "./action";

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** `null` until hydrated: the report lives in the URL hash, which the server never sees. */
const useHash = () =>
  useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => null,
  );

const FAILED_MESSAGE = "Couldn’t send feedback. Try again in a few minutes.";
const RATE_LIMITED_MESSAGE =
  "Too many reports were sent from this network. Try again in a few minutes.";

const submit = async (previous: SubmitResult | undefined, formData: FormData) => {
  try {
    return await submitAgentFeedback(previous, formData);
  } catch {
    return { status: "failed" } satisfies SubmitResult;
  }
};

export const AgentFeedbackForm = ({ enabled }: { enabled: boolean }) => {
  const hash = useHash();
  const [sent, setSent] = useState(false);

  if (hash === null) return <AgentFeedbackFormFallback />;
  if (!enabled) return <UnavailableState />;
  if (sent) return <SentState />;

  const report = decodeReportHash(hash);
  if (!report) {
    return <EmptyState invalid={new URLSearchParams(hash.slice(1)).has("report")} />;
  }

  return <EditableReport initialReport={report} key={hash} onSent={() => setSent(true)} />;
};

type SubmitIssue = { message: string; focusId?: string };

const EditableReport = ({
  initialReport,
  onSent,
}: {
  initialReport: AgentFeedbackReport;
  onSent: () => void;
}) => {
  const [result, formAction, pending] = useActionState(submit, undefined);
  const id = useId();
  const [report, setReport] = useState(initialReport);
  const [included, setIncluded] = useState(() => includeEverything(initialReport));
  const [edited, setEdited] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const issueRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (result?.status !== "sent") return;
    window.history.replaceState(null, "", window.location.pathname);
    onSent();
  }, [result, onSent]);

  // The agent won't reopen the report, so leaving after editing loses the review.
  useEffect(() => {
    if (!edited || pending || result?.status === "sent") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited, pending, result]);

  const reviewed = reviewReport(report, included);
  const issue = getSubmitIssue(report, included, reviewed, id);
  const shownIssue = attemptedSubmit ? issue : undefined;

  const update = <K extends keyof AgentFeedbackReport>(field: K, value: AgentFeedbackReport[K]) =>
    setReport((current) => ({ ...current, [field]: value }));
  const updateSetup = (setup: Partial<AgentFeedbackReport["setup"]>) =>
    setReport((current) => ({ ...current, setup: { ...current.setup, ...setup } }));
  const updateListItem = (field: "steps" | "observed", index: number, value: string) =>
    update(
      field,
      report[field].map((item, i) => (i === index ? value : item)),
    );
  const toggle = (field: "steps" | "observed", index: number) => {
    setEdited(true);
    setIncluded((current) => ({
      ...current,
      [field]: current[field].map((value, i) => (i === index ? !value : value)),
    }));
  };

  if (result?.status === "disabled") return <UnavailableState />;
  if (result?.status === "preview") return <PreviewState />;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-6 border-gray-alpha-400 border-t pt-6 pb-40 sm:pb-32"
      noValidate
      onChange={() => setEdited(true)}
      onSubmit={(event) => {
        // The button stays focusable while sending, so block repeat submits here.
        if (pending) {
          event.preventDefault();
          return;
        }
        setAttemptedSubmit(true);
        if (!issue) return;
        event.preventDefault();
        const target = issue.focusId ? document.getElementById(issue.focusId) : null;
        (target ?? issueRef.current)?.focus();
      }}
    >
      <input
        name="structuredReport"
        type="hidden"
        value={reviewed.success ? JSON.stringify(reviewed.data) : ""}
      />

      <section
        aria-label={`Report from ${report.agent}`}
        className="flex flex-col gap-5 pl-7 lg:pl-0"
      >
        <header className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-gray-900 text-label-13">
            <Bot aria-hidden="true" size={14} />
            Report from {report.agent}
          </p>
          <div className="pr-9">
            <InlineText
              className="text-heading-20"
              id={`${id}-title`}
              label="Summary"
              maxLength={reportLimits.title}
              onChange={(value) => update("title", value)}
              pending={pending}
              singleLine
              value={report.title}
            />
          </div>
        </header>

        <ReportSection label="Steps to reproduce">
          <ol className="flex flex-col gap-2">
            {report.steps.map((step, index) => (
              <ReportLine
                id={`${id}-steps-${index}`}
                key={index}
                label={`Reproduction step ${index + 1}`}
                marker={`${index + 1}.`}
                maxLength={reportLimits.step}
                onChange={(value) => updateListItem("steps", index, value)}
                onToggle={() => toggle("steps", index)}
                pending={pending}
                selected={included.steps[index] ?? false}
                value={step}
              />
            ))}
          </ol>
        </ReportSection>

        <ReportSection label="What happened">
          <ul className="flex flex-col gap-2">
            {report.observed.map((item, index) => (
              <ReportLine
                id={`${id}-observed-${index}`}
                key={index}
                label={`Observed result ${index + 1}`}
                marker="•"
                maxLength={reportLimits.observed}
                onChange={(value) => updateListItem("observed", index, value)}
                onToggle={() => toggle("observed", index)}
                pending={pending}
                selected={included.observed[index] ?? false}
                value={item}
              />
            ))}
          </ul>
        </ReportSection>

        <ReportSection label="What was expected">
          <ul>
            <ReportLine
              id={`${id}-expected`}
              label="Expected result"
              maxLength={reportLimits.expected}
              onChange={(value) => update("expected", value)}
              pending={pending}
              selected
              value={report.expected}
            />
          </ul>
        </ReportSection>

        {report.comparison !== undefined ? (
          <ReportSection label="Workaround or control">
            <ul>
              <ReportLine
                id={`${id}-comparison`}
                label="Workaround or control"
                maxLength={reportLimits.comparison}
                onChange={(value) => update("comparison", value)}
                onToggle={() => {
                  setEdited(true);
                  setIncluded((current) => ({ ...current, comparison: !current.comparison }));
                }}
                pending={pending}
                selected={included.comparison}
                value={report.comparison}
              />
            </ul>
          </ReportSection>
        ) : null}

        <details className="group/attached">
          <summary className="-mx-1 flex w-fit cursor-pointer list-none items-center gap-1.5 rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-details-marker]:hidden">
            <h3 className="flex items-center gap-1.5 text-gray-900 text-label-13">
              <Info aria-hidden="true" size={14} />
              Attached to this report
            </h3>
            <ChevronDown
              aria-hidden="true"
              className="shrink-0 text-gray-700 transition-transform group-open/attached:rotate-180"
              size={14}
            />
          </summary>
          <dl className="grid grid-cols-1 gap-4 pt-3 pr-9 sm:grid-cols-3">
            <ReportDetail label="eve version" value={report.eveVersion} />
            <ReportDetailSelect
              label="Trigger"
              onChange={(triggerReason) => update("triggerReason", triggerReason)}
              options={triggerReasonLabels}
              pending={pending}
              value={report.triggerReason}
            />
            <ReportDetailSelect
              label="Deploy target"
              onChange={(deployTarget) => updateSetup({ deployTarget })}
              options={deployTargetLabels}
              pending={pending}
              value={report.setup.deployTarget}
            />
            {report.setup.channel !== undefined ? (
              <ReportDetailText
                id={`${id}-channel`}
                label="Channel"
                maxLength={reportLimits.shortName}
                onChange={(channel) => updateSetup({ channel })}
                pending={pending}
                value={report.setup.channel}
              />
            ) : null}
            {report.setup.connection !== undefined ? (
              <ReportDetailText
                id={`${id}-connection`}
                label="Connection"
                maxLength={reportLimits.shortName}
                onChange={(connection) => updateSetup({ connection })}
                pending={pending}
                value={report.setup.connection}
              />
            ) : null}
            <ReportDetailSelect
              label="Frequency"
              onChange={(frequency) => update("frequency", frequency)}
              options={frequencyLabels}
              pending={pending}
              value={report.frequency}
            />
            <ReportDetailSelect
              label="Outcome"
              onChange={(outcome) => update("outcome", outcome)}
              options={outcomeLabels}
              pending={pending}
              value={report.outcome}
            />
            {report.setup.relevantFeatures?.map((feature, index) => (
              <ReportDetailText
                id={`${id}-relevantFeatures-${index}`}
                key={index}
                label={`Feature ${index + 1}`}
                maxLength={reportLimits.feature}
                onChange={(value) =>
                  updateSetup({
                    relevantFeatures: report.setup.relevantFeatures?.map((current, i) =>
                      i === index ? value : current,
                    ),
                  })
                }
                pending={pending}
                value={feature}
              />
            ))}
          </dl>
        </details>
      </section>

      {result?.status === "failed" ? (
        <p
          className="rounded-md border border-red-400 bg-red-100 px-3 py-2 text-copy-14 text-red-900"
          role="alert"
        >
          {result.rateLimited ? RATE_LIMITED_MESSAGE : FAILED_MESSAGE}
        </p>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-20 border-gray-alpha-400 border-t bg-background-100/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-stretch gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
          <p
            aria-live="polite"
            className={cn(
              "min-w-0 text-copy-13 outline-none",
              shownIssue ? "text-red-900" : "text-gray-900",
            )}
            ref={issueRef}
            tabIndex={-1}
          >
            {shownIssue?.message ?? "No other data from your project or machine is attached."}
          </p>
          <Button
            className="w-full shrink-0 sm:w-auto"
            loading={pending}
            size="large"
            typeName="submit"
          >
            Send feedback
          </Button>
        </div>
      </div>
    </form>
  );
};

const fieldLabels: Partial<Record<PropertyKey, string>> = {
  title: "summary",
  steps: "reproduction step",
  observed: "actual result",
  expected: "expected result",
  comparison: "workaround or control",
  channel: "channel",
  connection: "connection",
  relevantFeatures: "feature",
};

/** Maps indices in the reviewed lists back to the lines the reviewer sees. */
const keptIndices = (values: readonly string[], included?: readonly boolean[]) =>
  values.flatMap((value, index) => ((included?.[index] ?? true) && value.trim() ? [index] : []));

const getSubmitIssue = (
  report: AgentFeedbackReport,
  included: IncludedItems,
  reviewed: ReturnType<typeof reviewReport>,
  id: string,
): SubmitIssue | undefined => {
  const issue = reviewed.error?.issues[0];
  if (!issue) return undefined;

  const [field, index] = issue.path[0] === "setup" ? issue.path.slice(1) : issue.path;
  const label = field === undefined ? undefined : fieldLabels[field];
  if (!label) return { message: "This report can’t be sent as edited." };

  let focusId: string | undefined = `${id}-${String(field)}`;
  if (field === "steps" || field === "observed") {
    const shown =
      typeof index === "number"
        ? keptIndices(report[field], included[field])[index]
        : included[field].indexOf(true);
    focusId = shown !== undefined && shown >= 0 ? `${focusId}-${shown}` : undefined;
  } else if (field === "relevantFeatures" && typeof index === "number") {
    const shown = keptIndices(report.setup.relevantFeatures ?? [])[index];
    focusId = shown === undefined ? undefined : `${focusId}-${shown}`;
  }

  const message =
    issue.code === "too_big"
      ? `Shorten the ${label} to ${issue.maximum} characters.`
      : issue.code === "too_small" && issue.origin === "array"
        ? `Keep at least one ${label}.`
        : `Fill in the ${label} before sending.`;
  return { message, focusId };
};

const SentState = () => {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <StatusMessage headingRef={headingRef} title="Feedback sent">
      Thanks, this helps improve eve. You can close this tab.
    </StatusMessage>
  );
};

const UnavailableState = () => (
  <StatusMessage boxed title="Agent feedback is disabled">
    This report has not been sent. You can close this tab.
  </StatusMessage>
);

const PreviewState = () => (
  <StatusMessage boxed title="Sending is off on this deployment">
    Reports are only sent from eve.dev. This report has not been sent.
  </StatusMessage>
);

const EmptyState = ({ invalid }: { invalid: boolean }) => (
  <StatusMessage boxed title={invalid ? "Report link unavailable" : "No report to review"}>
    {invalid
      ? "This report link could not be read."
      : "When agent feedback is enabled in your project, your coding agent uses this page to share reports for you to review."}
  </StatusMessage>
);

const StatusMessage = ({
  boxed = false,
  children,
  headingRef,
  title,
}: {
  boxed?: boolean;
  children: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  title: string;
}) => (
  <div
    aria-live="polite"
    className={cn(
      "flex flex-col gap-2",
      boxed && "min-h-48 rounded-lg border border-gray-alpha-400 px-6 py-6",
    )}
    role="status"
  >
    <h2 className="text-gray-1000 text-heading-20 outline-none" ref={headingRef} tabIndex={-1}>
      {title}
    </h2>
    <p className="max-w-prose text-pretty text-copy-16 text-gray-900">{children}</p>
  </div>
);

const fieldClassName =
  "w-full min-w-0 rounded-md border border-gray-alpha-400 bg-background-100 px-3 py-2 text-gray-1000 outline-none transition-colors hover:border-gray-alpha-500 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed read-only:cursor-default";

const ReportSection = ({ children, label }: { children: ReactNode; label: string }) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 className="text-gray-900 text-label-13" id={headingId}>
        {label}
      </h3>
      {children}
    </section>
  );
};

/** A textarea that grows with its content. */
const InlineText = ({
  className,
  id,
  label,
  maxLength,
  onChange,
  pending,
  readOnly = false,
  singleLine = false,
  value,
}: {
  className?: string;
  id?: string;
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  pending: boolean;
  readOnly?: boolean;
  singleLine?: boolean;
  value: string;
}) => (
  <textarea
    aria-label={label}
    className={cn(fieldClassName, "field-sizing-content resize-none text-pretty", className)}
    id={id}
    maxLength={maxLength}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={singleLine ? (event) => event.key === "Enter" && event.preventDefault() : undefined}
    readOnly={pending || readOnly}
    rows={1}
    value={value}
  />
);

const ReportLine = ({
  id,
  label,
  marker,
  maxLength,
  onChange,
  onToggle,
  pending,
  selected,
  value,
}: {
  id?: string;
  label: string;
  marker?: string;
  maxLength: number;
  onChange: (value: string) => void;
  onToggle?: () => void;
  pending: boolean;
  selected: boolean;
  value: string;
}) => {
  const lowerLabel = label.toLowerCase();
  const ToggleIcon = selected ? X : Undo2;

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_1.75rem] items-start gap-x-2">
      {marker ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-full mr-2 w-[1.125rem] pt-2.5 text-right text-copy-14 tabular-nums",
            selected ? "text-gray-700" : "text-gray-600",
          )}
        >
          {marker}
        </span>
      ) : null}
      <InlineText
        className={cn("text-copy-14", !selected && "text-gray-700 line-through")}
        id={id}
        label={label}
        maxLength={maxLength}
        onChange={onChange}
        pending={pending}
        readOnly={!selected}
        value={value}
      />
      {onToggle ? (
        <button
          aria-label={
            selected ? `Remove ${lowerLabel} from report` : `Restore ${lowerLabel} to report`
          }
          className="mt-1.5 flex size-7 items-center justify-center justify-self-end rounded-md text-gray-800 outline-none hover:bg-gray-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:text-gray-700"
          disabled={pending}
          onClick={onToggle}
          type="button"
        >
          <ToggleIcon aria-hidden="true" size={14} />
        </button>
      ) : null}
    </li>
  );
};

const ReportDetail = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <dt className="text-gray-900 text-label-13">{label}</dt>
    <dd className="flex min-h-10 items-center break-words text-copy-14 text-gray-1000">{value}</dd>
  </div>
);

const ReportDetailText = ({
  id,
  label,
  maxLength,
  onChange,
  pending,
  value,
}: {
  id: string;
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  pending: boolean;
  value: string;
}) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <dt className="text-gray-900 text-label-13">
      <label htmlFor={id}>{label}</label>
    </dt>
    <dd>
      <input
        className={cn(fieldClassName, "h-10 text-copy-14")}
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        readOnly={pending}
        value={value}
      />
    </dd>
  </div>
);

const ReportDetailSelect = <T extends string>({
  label,
  onChange,
  options,
  pending,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: Record<T, string>;
  pending: boolean;
  value: T;
}) => {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-gray-900 text-label-13">
        <label htmlFor={id}>{label}</label>
      </dt>
      <dd>
        <select
          className={cn(fieldClassName, "h-10 text-copy-14")}
          disabled={pending}
          id={id}
          // The options are the only values the select can produce.
          onChange={(event) => onChange(event.target.value as T)}
          value={value}
        >
          {Object.entries<string>(options).map(([optionValue, optionLabel]) => (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
};

export const AgentFeedbackFormFallback = () => (
  <div aria-busy="true" role="status">
    <span className="sr-only">Loading feedback report</span>
    <div aria-hidden="true" className="flex flex-col gap-5 border-gray-alpha-400 border-t pt-6">
      <div className="h-3.5 w-32 animate-pulse rounded bg-gray-alpha-200" />
      <div className="h-11 w-full animate-pulse rounded bg-gray-alpha-200" />
      <div className="h-3.5 w-28 animate-pulse rounded bg-gray-alpha-200" />
      <div className="h-22 w-full animate-pulse rounded bg-gray-alpha-200" />
    </div>
  </div>
);

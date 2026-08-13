import { STEPS, type StepId } from "@/components/onboarding/step-tabs";

export function stepIndex(step: StepId) {
  return STEPS.findIndex((s) => s.id === step);
}

export function nextStep(step: StepId): StepId | null {
  const i = stepIndex(step);
  return i < STEPS.length - 1 ? STEPS[i + 1]!.id : null;
}

export function prevStep(step: StepId): StepId | null {
  const i = stepIndex(step);
  return i > 0 ? STEPS[i - 1]!.id : null;
}

export function progressLabel(step: StepId) {
  const i = stepIndex(step);
  const total = STEPS.length;
  if (i <= 0) return "Setup · about a minute";
  if (i >= total - 1) return "Last step";
  if (i >= total - 2) return "Almost done";
  return `Step ${i + 1} of ${total}`;
}

/** Canonical `provider/model-id` identity used by settings, pickers and diagnostics. */
export function modelIdentity(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

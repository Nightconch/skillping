import type { PayloadEstimates30d } from "./domain.js";

export const PAYLOAD_ESTIMATOR_VERSION = "byte_div_2_v1" as const;

export const emptyPayloadEstimates = (): PayloadEstimates30d => ({
  review_payload_count: 0,
  estimated_tokens_p50: null,
  estimated_tokens_p95: null,
  estimated_tokens_max: null,
  critical_payload_count: 0,
  normal_limit_exceeded_count: 0,
  critical_limit_exceeded_count: 0,
  estimator_version: PAYLOAD_ESTIMATOR_VERSION,
});

export function measurePayloadText(payload: string) {
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  return {
    payloadBytes,
    estimatedTokens: Math.ceil(payloadBytes / 2),
    estimatorVersion: PAYLOAD_ESTIMATOR_VERSION,
  };
}

export type ResidentControlEvent =
  | { readonly kind: "talk_pressed"; readonly occurredAt: string }
  | { readonly kind: "talk_released"; readonly occurredAt: string }
  | { readonly kind: "cancel_pressed"; readonly occurredAt: string }
  | {
      readonly kind: "tail_complete";
      readonly generationId: number;
      readonly occurredAt: string;
    };

export type ResidentControlResult = "accepted" | "ignored_busy" | "ignored_stale" | "noop";

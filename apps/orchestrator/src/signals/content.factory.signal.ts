import { defineSignal } from '@temporalio/workflow';

export type ContentFactoryReviewDecision = 'approve' | 'reject';

export type ContentFactoryReviewSignal = {
  decision: ContentFactoryReviewDecision;
  note?: string;
  operator?: string;
};

export const contentFactoryReviewSignal =
  defineSignal<[ContentFactoryReviewSignal]>('contentFactoryReview');

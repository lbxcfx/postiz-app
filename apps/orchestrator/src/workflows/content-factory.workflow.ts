import { condition, proxyActivities, setHandler } from '@temporalio/workflow';
import { ContentFactoryActivity } from '@gitroom/orchestrator/activities/content-factory.activity';
import {
  contentFactoryReviewSignal,
  ContentFactoryReviewSignal,
} from '@gitroom/orchestrator/signals/content.factory.signal';

export type ContentFactoryInput = {
  organizationId: string;
  operatorId: string;
  integrationId: string;
  collectParams: {
    platform: 'xhs' | 'dy';
    keywords: string;
    startPage?: number;
    pageLimit?: number;
    queryHash?: string;
  };
  productProfile?: Record<string, unknown>;
  scheduleAt?: string;
  workflowId?: string;
  draftId?: string;
};

const {
  collectContent,
  analyzeContent,
  generateDraft,
  updateDraftReviewState,
  publishContent,
  markWorkflowFailed,
} = proxyActivities<ContentFactoryActivity>({
  taskQueue: 'main',
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '30 seconds',
  },
});

export async function contentFactoryWorkflow(input: ContentFactoryInput) {
  let reviewSignal: ContentFactoryReviewSignal | null = null;
  setHandler(contentFactoryReviewSignal, (payload) => {
    reviewSignal = payload;
  });

  try {
    const collectResult = await collectContent(input);
    const analysisResult = collectResult.hasVideo
      ? await analyzeContent({
          organizationId: input.organizationId,
          sourceContentIds: collectResult.sourceContentIds,
        })
      : null;

    let draft = await generateDraft({
      ...input,
      sourceContentIds: collectResult.sourceContentIds,
      analysisResult,
      existingDraftId: input.draftId,
    });

    let rejectionCount = 0;
    while (true) {
      await condition(() => !!reviewSignal);
      const current = reviewSignal!;
      reviewSignal = null;

      if (current.decision === 'approve') {
        await updateDraftReviewState({
          draftId: draft.id,
          reviewStatus: 'APPROVED',
          reviewedBy: current.operator || input.operatorId,
          reviewNote: current.note,
        });
        break;
      }

      rejectionCount += 1;
      await updateDraftReviewState({
        draftId: draft.id,
        reviewStatus: 'REGENERATING',
        reviewedBy: current.operator || input.operatorId,
        reviewNote: current.note,
      });

      draft = await generateDraft({
        ...input,
        sourceContentIds: collectResult.sourceContentIds,
        analysisResult,
        regenerateHint: current.note,
        existingDraftId: draft.id,
      });

      if (rejectionCount >= 3) {
        await updateDraftReviewState({
          draftId: draft.id,
          reviewStatus: 'REJECTED',
          reviewedBy: current.operator || input.operatorId,
          reviewNote: current.note,
        });
        return {
          status: 'rejected',
          draftId: draft.id,
        };
      }
    }

    const publishResult = await publishContent({
      organizationId: input.organizationId,
      draftId: draft.id,
      integrationId: input.integrationId,
      scheduleAt: input.scheduleAt,
    });

    return {
      status: 'completed',
      draftId: draft.id,
      publishResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'workflow failed';
    await markWorkflowFailed({
      organizationId: input.organizationId,
      workflowId: input.workflowId || '',
      reason: message,
    });
    throw error;
  }
}

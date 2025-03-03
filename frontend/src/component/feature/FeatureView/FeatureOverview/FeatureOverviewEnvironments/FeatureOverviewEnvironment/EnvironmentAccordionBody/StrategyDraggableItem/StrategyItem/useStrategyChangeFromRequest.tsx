import { usePendingChangeRequests } from 'hooks/api/getters/usePendingChangeRequests/usePendingChangeRequests';

export const useStrategyChangeFromRequest = (
    projectId: string,
    featureId: string,
    environment: string,
    strategyId: string
) => {
    const { draft } = usePendingChangeRequests(projectId);

    const environmentDraft = draft?.find(
        draft => draft.environment === environment
    );
    const feature = environmentDraft?.features.find(
        feature => feature.name === featureId
    );
    const change = feature?.changes.find(change => {
        if (
            change.action === 'updateStrategy' ||
            change.action === 'deleteStrategy'
        ) {
            return change.payload.id === strategyId;
        }
    });

    return change;
};

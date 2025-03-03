import { MouseEvent, useContext, useState, VFC } from 'react';
import {
    IconButton,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    Tooltip,
} from '@mui/material';
import { AddToPhotos as CopyIcon, Lock } from '@mui/icons-material';
import { IFeatureStrategy, IFeatureStrategyPayload } from 'interfaces/strategy';
import { useRequiredPathParam } from 'hooks/useRequiredPathParam';
import { IFeatureEnvironment } from 'interfaces/featureToggle';
import AccessContext from 'contexts/AccessContext';
import { CREATE_FEATURE_STRATEGY } from 'component/providers/AccessProvider/permissions';
import { ConditionallyRender } from 'component/common/ConditionallyRender/ConditionallyRender';
import { useFeature } from 'hooks/api/getters/useFeature/useFeature';
import useFeatureStrategyApi from 'hooks/api/actions/useFeatureStrategyApi/useFeatureStrategyApi';
import useToast from 'hooks/useToast';
import { useFeatureImmutable } from 'hooks/api/getters/useFeature/useFeatureImmutable';
import { formatUnknownError } from 'utils/formatUnknownError';
import { useChangeRequestAddStrategy } from 'hooks/useChangeRequestAddStrategy';
import { ChangeRequestDialogue } from '../../../../../../../../../changeRequest/ChangeRequestConfirmDialog/ChangeRequestConfirmDialog';
import { CopyStrategyMessage } from '../../../../../../../../../changeRequest/ChangeRequestConfirmDialog/ChangeRequestMessages/CopyStrategyMessage';
import { useChangeRequestsEnabled } from 'hooks/useChangeRequestsEnabled';

interface ICopyStrategyIconMenuProps {
    environmentId: string;
    environments: IFeatureEnvironment['name'][];
    strategy: IFeatureStrategyPayload;
}

export const CopyStrategyIconMenu: VFC<ICopyStrategyIconMenuProps> = ({
    environmentId,
    environments,
    strategy,
}) => {
    const projectId = useRequiredPathParam('projectId');
    const featureId = useRequiredPathParam('featureId');

    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const { addStrategyToFeature } = useFeatureStrategyApi();
    const { setToastData, setToastApiError } = useToast();
    const { refetchFeature } = useFeature(projectId, featureId);
    const { refetchFeature: refetchFeatureImmutable } = useFeatureImmutable(
        projectId,
        featureId
    );
    const onClose = () => {
        setAnchorEl(null);
    };
    const { hasAccess } = useContext(AccessContext);
    const { isChangeRequestConfigured } = useChangeRequestsEnabled(projectId);

    const {
        changeRequestDialogDetails,
        onChangeRequestAddStrategyClose,
        onChangeRequestAddStrategy,
        onChangeRequestAddStrategyConfirm,
    } = useChangeRequestAddStrategy(projectId, featureId, 'addStrategy');

    const onCopyStrategy = async (targetEnvironment: string) => {
        const { id, ...strategyCopy } = {
            ...strategy,
            targetEnvironment,
        };
        if (isChangeRequestConfigured(targetEnvironment)) {
            await onChangeRequestAddStrategy(
                targetEnvironment,
                {
                    id,
                    ...strategyCopy,
                },
                environmentId
            );
            return;
        }

        try {
            await addStrategyToFeature(
                projectId,
                featureId,
                targetEnvironment,
                strategy
            );
            refetchFeature();
            refetchFeatureImmutable();
            setToastData({
                title: `Strategy created`,
                text: `Successfully copied a strategy to ${targetEnvironment}`,
                type: 'success',
            });
        } catch (error) {
            setToastApiError(formatUnknownError(error));
        }
        onClose();
    };

    const enabled = environments.some(environment =>
        hasAccess(CREATE_FEATURE_STRATEGY, projectId, environment)
    );

    return (
        <div>
            <ChangeRequestDialogue
                isOpen={changeRequestDialogDetails.isOpen}
                onClose={onChangeRequestAddStrategyClose}
                environment={changeRequestDialogDetails?.environment}
                onConfirm={onChangeRequestAddStrategyConfirm}
                messageComponent={
                    <CopyStrategyMessage
                        fromEnvironment={
                            changeRequestDialogDetails.fromEnvironment!
                        }
                        payload={changeRequestDialogDetails.strategy!}
                    />
                }
            />
            <Tooltip
                title={`Copy to another environment${
                    enabled ? '' : ' (Access denied)'
                }`}
            >
                <div>
                    <IconButton
                        size="large"
                        id={`copy-strategy-icon-menu-${strategy.id}`}
                        aria-controls={open ? 'basic-menu' : undefined}
                        aria-haspopup="true"
                        aria-expanded={open ? 'true' : undefined}
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                            setAnchorEl(event.currentTarget);
                        }}
                        disabled={!enabled}
                    >
                        <CopyIcon />
                    </IconButton>
                </div>
            </Tooltip>
            <Menu
                id="basic-menu"
                anchorEl={anchorEl}
                open={open}
                onClose={onClose}
                MenuListProps={{
                    'aria-labelledby': `copy-strategy-icon-menu-${strategy.id}`,
                }}
            >
                {environments.map(environment => {
                    const access = hasAccess(
                        CREATE_FEATURE_STRATEGY,
                        projectId,
                        environment
                    );

                    return (
                        <Tooltip
                            title={
                                access
                                    ? ''
                                    : "You don't have access to add a strategy to this environment"
                            }
                            key={environment}
                        >
                            <div>
                                <MenuItem
                                    onClick={() => onCopyStrategy(environment)}
                                    disabled={!access}
                                >
                                    <ConditionallyRender
                                        condition={!access}
                                        show={
                                            <ListItemIcon>
                                                <Lock fontSize="small" />
                                            </ListItemIcon>
                                        }
                                    />
                                    <ListItemText>
                                        Copy to {environment}
                                    </ListItemText>
                                </MenuItem>
                            </div>
                        </Tooltip>
                    );
                })}
            </Menu>
        </div>
    );
};

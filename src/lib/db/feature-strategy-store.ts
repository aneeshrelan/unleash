import { Knex } from 'knex';
import EventEmitter from 'events';
import { v4 as uuidv4 } from 'uuid';
import metricsHelper from '../util/metrics-helper';
import { DB_TIME } from '../metric-events';
import { Logger, LogProvider } from '../logger';
import NotFoundError from '../error/notfound-error';
import {
    FeatureToggleWithEnvironment,
    IConstraint,
    IEnvironmentOverview,
    IFeatureOverview,
    IFeatureStrategy,
    IFeatureToggleClient,
    IStrategyConfig,
    ITag,
} from '../types/model';
import { IFeatureStrategiesStore } from '../types/stores/feature-strategies-store';
import { PartialDeep, PartialSome } from '../types/partial';
import FeatureToggleStore from './feature-toggle-store';
import { ensureStringValue } from '../util/ensureStringValue';
import { mapValues } from '../util/map-values';
import { IFlagResolver } from '../types/experimental';

const COLUMNS = [
    'id',
    'feature_name',
    'project_name',
    'environment',
    'strategy_name',
    'parameters',
    'constraints',
    'created_at',
];
/*
const mapperToColumnNames = {
    createdAt: 'created_at',
    featureName: 'feature_name',
    strategyName: 'strategy_name',
};
*/

const T = {
    features: 'features',
    featureStrategies: 'feature_strategies',
    featureStrategySegment: 'feature_strategy_segment',
    featureEnvs: 'feature_environments',
};

interface IFeatureStrategiesTable {
    id: string;
    feature_name: string;
    project_name: string;
    environment: string;
    strategy_name: string;
    parameters: object;
    constraints: string;
    sort_order: number;
    created_at?: Date;
}

function mapRow(row: IFeatureStrategiesTable): IFeatureStrategy {
    return {
        id: row.id,
        featureName: row.feature_name,
        projectId: row.project_name,
        environment: row.environment,
        strategyName: row.strategy_name,
        parameters: mapValues(row.parameters || {}, ensureStringValue),
        constraints: (row.constraints as unknown as IConstraint[]) || [],
        createdAt: row.created_at,
        sortOrder: row.sort_order,
    };
}

function mapInput(input: IFeatureStrategy): IFeatureStrategiesTable {
    return {
        id: input.id,
        feature_name: input.featureName,
        project_name: input.projectId,
        environment: input.environment,
        strategy_name: input.strategyName,
        parameters: input.parameters,
        constraints: JSON.stringify(input.constraints || []),
        created_at: input.createdAt,
        sort_order: input.sortOrder,
    };
}

interface StrategyUpdate {
    strategy_name: string;
    parameters: object;
    constraints: string;
}

function mapStrategyUpdate(
    input: Partial<IStrategyConfig>,
): Partial<StrategyUpdate> {
    const update: Partial<StrategyUpdate> = {};
    if (input.name !== null) {
        update.strategy_name = input.name;
    }
    if (input.parameters !== null) {
        update.parameters = input.parameters;
    }
    update.constraints = JSON.stringify(input.constraints || []);
    return update;
}

class FeatureStrategiesStore implements IFeatureStrategiesStore {
    private db: Knex;

    private logger: Logger;

    private readonly timer: Function;

    private flagResolver: IFlagResolver;

    constructor(
        db: Knex,
        eventBus: EventEmitter,
        getLogger: LogProvider,
        flagResolver: IFlagResolver,
    ) {
        this.db = db;
        this.logger = getLogger('feature-toggle-store.ts');
        this.timer = (action) =>
            metricsHelper.wrapTimer(eventBus, DB_TIME, {
                store: 'feature-toggle-strategies',
                action,
            });
        this.flagResolver = flagResolver;
    }

    async delete(key: string): Promise<void> {
        await this.db(T.featureStrategies).where({ id: key }).del();
    }

    async deleteAll(): Promise<void> {
        await this.db(T.featureStrategies).delete();
    }

    destroy(): void {}

    async exists(key: string): Promise<boolean> {
        const result = await this.db.raw(
            `SELECT EXISTS(SELECT 1 FROM ${T.featureStrategies} WHERE id = ?) AS present`,
            [key],
        );
        const { present } = result.rows[0];
        return present;
    }

    async get(key: string): Promise<IFeatureStrategy> {
        const row = await this.db(T.featureStrategies)
            .where({ id: key })
            .first();

        if (!row) {
            throw new NotFoundError(`Could not find strategy with id=${key}`);
        }

        return mapRow(row);
    }

    async createStrategyFeatureEnv(
        strategyConfig: PartialSome<IFeatureStrategy, 'id' | 'createdAt'>,
    ): Promise<IFeatureStrategy> {
        const strategyRow = mapInput({ id: uuidv4(), ...strategyConfig });
        const rows = await this.db<IFeatureStrategiesTable>(T.featureStrategies)
            .insert(strategyRow)
            .returning('*');
        return mapRow(rows[0]);
    }

    async removeAllStrategiesForFeatureEnv(
        featureName: string,
        environment: string,
    ): Promise<void> {
        await this.db('feature_strategies')
            .where({ feature_name: featureName, environment })
            .del();
    }

    async getAll(): Promise<IFeatureStrategy[]> {
        const stopTimer = this.timer('getAll');
        const rows = await this.db
            .select(COLUMNS)
            .from<IFeatureStrategiesTable>(T.featureStrategies);

        stopTimer();
        return rows.map(mapRow);
    }

    async getStrategiesForFeatureEnv(
        projectId: string,
        featureName: string,
        environment: string,
    ): Promise<IFeatureStrategy[]> {
        const stopTimer = this.timer('getForFeature');
        const rows = await this.db<IFeatureStrategiesTable>(T.featureStrategies)
            .where({
                project_name: projectId,
                feature_name: featureName,
                environment,
            })
            .orderBy([
                { column: 'sort_order', order: 'asc' },
                { column: 'created_at', order: 'asc' },
            ]);
        stopTimer();
        return rows.map(mapRow);
    }

    async getFeatureToggleWithEnvs(
        featureName: string,
        archived: boolean = false,
    ): Promise<FeatureToggleWithEnvironment> {
        return this.loadFeatureToggleWithEnvs(featureName, archived, false);
    }

    async getFeatureToggleWithVariantEnvs(
        featureName: string,
        archived: boolean = false,
    ): Promise<FeatureToggleWithEnvironment> {
        return this.loadFeatureToggleWithEnvs(featureName, archived, true);
    }

    async loadFeatureToggleWithEnvs(
        featureName: string,
        archived: boolean,
        withEnvironmentVariants: boolean,
    ): Promise<FeatureToggleWithEnvironment> {
        const stopTimer = this.timer('getFeatureAdmin');
        const rows = await this.db('features_view')
            .where('name', featureName)
            .modify(FeatureToggleStore.filterByArchived, archived);
        stopTimer();
        if (rows.length > 0) {
            const featureToggle = rows.reduce((acc, r) => {
                if (acc.environments === undefined) {
                    acc.environments = {};
                }

                acc.name = r.name;
                acc.impressionData = r.impression_data;
                acc.description = r.description;
                acc.project = r.project;
                acc.stale = r.stale;

                acc.createdAt = r.created_at;
                acc.lastSeenAt = r.last_seen_at;
                acc.type = r.type;
                if (!acc.environments[r.environment]) {
                    acc.environments[r.environment] = {
                        name: r.environment,
                    };
                }
                const env = acc.environments[r.environment];

                const variants = r.variants || [];
                variants.sort((a, b) => a.name.localeCompare(b.name));
                if (withEnvironmentVariants) {
                    env.variants = variants;
                }
                acc.variants = variants;

                env.enabled = r.enabled;
                env.type = r.environment_type;
                env.sortOrder = r.environment_sort_order;
                if (!env.strategies) {
                    env.strategies = [];
                }
                if (r.strategy_id) {
                    const found = env.strategies.find(
                        (strategy) => strategy.id === r.strategy_id,
                    );
                    if (!found) {
                        env.strategies.push(
                            FeatureStrategiesStore.getAdminStrategy(r),
                        );
                    }
                }
                if (r.segments) {
                    this.addSegmentIdsToStrategy(env, r);
                }
                acc.environments[r.environment] = env;
                return acc;
            }, {});
            featureToggle.environments = Object.values(
                featureToggle.environments,
            ).sort((a, b) => {
                // @ts-expect-error
                return a.sortOrder - b.sortOrder;
            });
            featureToggle.environments = featureToggle.environments.map((e) => {
                e.strategies = e.strategies.sort(
                    (a, b) => a.sortOrder - b.sortOrder,
                );
                return e;
            });
            featureToggle.archived = archived;
            return featureToggle;
        }
        throw new NotFoundError(
            `Could not find feature toggle with name ${featureName}`,
        );
    }

    private addSegmentIdsToStrategy(
        feature: PartialDeep<IFeatureToggleClient>,
        row: Record<string, any>,
    ) {
        const strategy = feature.strategies.find(
            (s) => s.id === row.strategy_id,
        );
        if (!strategy) {
            return;
        }
        if (!strategy.segments) {
            strategy.segments = [];
        }
        strategy.segments.push(row.segments);
    }

    private static getEnvironment(r: any): IEnvironmentOverview {
        return {
            name: r.environment,
            enabled: r.enabled,
            type: r.environment_type,
            sortOrder: r.environment_sort_order,
        };
    }

    private addTag(
        feature: Record<string, any>,
        row: Record<string, any>,
    ): void {
        const tags = feature.tags || [];
        const newTag = FeatureStrategiesStore.rowToTag(row);
        feature.tags = [...tags, newTag];
    }

    private isNewTag(
        feature: Record<string, any>,
        row: Record<string, any>,
    ): boolean {
        return (
            row.tag_type &&
            row.tag_value &&
            !feature.tags?.some(
                (tag) =>
                    tag.type === row.tag_type && tag.value === row.tag_value,
            )
        );
    }

    private static rowToTag(r: any): ITag {
        return {
            value: r.tag_value,
            type: r.tag_type,
        };
    }

    async getFeatureOverview(
        projectId: string,
        archived: boolean = false,
    ): Promise<IFeatureOverview[]> {
        let selectColumns = [
            'features.name as feature_name',
            'features.type as type',
            'features.created_at as created_at',
            'features.last_seen_at as last_seen_at',
            'features.stale as stale',
            'feature_environments.enabled as enabled',
            'feature_environments.environment as environment',
            'environments.type as environment_type',
            'environments.sort_order as environment_sort_order',
        ];

        if (this.flagResolver.isEnabled('toggleTagFiltering')) {
            selectColumns = [
                ...selectColumns,
                'ft.tag_value as tag_value',
                'ft.tag_type as tag_type',
            ];
        }

        let query = this.db('features')
            .where({ project: projectId })
            .select(selectColumns)
            .modify(FeatureToggleStore.filterByArchived, archived)
            .leftJoin(
                'feature_environments',
                'feature_environments.feature_name',
                'features.name',
            )
            .leftJoin(
                'environments',
                'feature_environments.environment',
                'environments.name',
            );

        if (this.flagResolver.isEnabled('toggleTagFiltering')) {
            query = query.leftJoin(
                'feature_tag as ft',
                'ft.feature_name',
                'features.name',
            );
        }

        const rows = await query;

        if (rows.length > 0) {
            const overview = rows.reduce((acc, r) => {
                if (acc[r.feature_name] !== undefined) {
                    acc[r.feature_name].environments.push(
                        FeatureStrategiesStore.getEnvironment(r),
                    );
                    if (this.isNewTag(acc[r.feature_name], r)) {
                        this.addTag(acc[r.feature_name], r);
                    }
                } else {
                    acc[r.feature_name] = {
                        type: r.type,
                        name: r.feature_name,
                        createdAt: r.created_at,
                        lastSeenAt: r.last_seen_at,
                        stale: r.stale,
                        environments: [
                            FeatureStrategiesStore.getEnvironment(r),
                        ],
                    };
                    if (this.isNewTag(acc[r.feature_name], r)) {
                        this.addTag(acc[r.feature_name], r);
                    }
                }
                return acc;
            }, {});

            return Object.values(overview).map((o: IFeatureOverview) => ({
                ...o,
                environments: o.environments
                    .filter((f) => f.name)
                    .sort((a, b) => {
                        if (a.sortOrder === b.sortOrder) {
                            return a.name.localeCompare(b.name);
                        }
                        return a.sortOrder - b.sortOrder;
                    }),
            }));
        }
        return [];
    }

    async getStrategyById(id: string): Promise<IFeatureStrategy> {
        const strat = await this.db(T.featureStrategies).where({ id }).first();
        if (strat) {
            return mapRow(strat);
        }
        throw new NotFoundError(`Could not find strategy with id: ${id}`);
    }

    async updateSortOrder(id: string, sortOrder: number): Promise<void> {
        await this.db<IFeatureStrategiesTable>(T.featureStrategies)
            .where({ id })
            .update({ sort_order: sortOrder });
    }

    async updateStrategy(
        id: string,
        updates: Partial<IFeatureStrategy>,
    ): Promise<IFeatureStrategy> {
        const update = mapStrategyUpdate(updates);
        const row = await this.db<IFeatureStrategiesTable>(T.featureStrategies)
            .where({ id })
            .update(update)
            .returning('*');
        return mapRow(row[0]);
    }

    private static getAdminStrategy(
        r: any,
        includeId: boolean = true,
    ): IStrategyConfig {
        const strategy = {
            name: r.strategy_name,
            constraints: r.constraints || [],
            parameters: r.parameters,
            sortOrder: r.sort_order,
            id: r.strategy_id,
        };
        if (!includeId) {
            delete strategy.id;
        }
        return strategy;
    }

    async deleteConfigurationsForProjectAndEnvironment(
        projectId: String,
        environment: String,
    ): Promise<void> {
        await this.db(T.featureStrategies)
            .where({ project_name: projectId, environment })
            .del();
    }

    async setProjectForStrategiesBelongingToFeature(
        featureName: string,
        newProjectId: string,
    ): Promise<void> {
        await this.db(T.featureStrategies)
            .where({ feature_name: featureName })
            .update({ project_name: newProjectId });
    }

    async getStrategiesBySegment(
        segmentId: number,
    ): Promise<IFeatureStrategy[]> {
        const stopTimer = this.timer('getStrategiesBySegment');
        const rows = await this.db
            .select(this.prefixColumns())
            .from<IFeatureStrategiesTable>(T.featureStrategies)
            .join(
                T.featureStrategySegment,
                `${T.featureStrategySegment}.feature_strategy_id`,
                `${T.featureStrategies}.id`,
            )
            .where(`${T.featureStrategySegment}.segment_id`, '=', segmentId);
        stopTimer();
        return rows.map(mapRow);
    }

    prefixColumns(): string[] {
        return COLUMNS.map((c) => `${T.featureStrategies}.${c}`);
    }
}

module.exports = FeatureStrategiesStore;
export default FeatureStrategiesStore;

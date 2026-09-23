import type { Db, IndexDescription } from 'mongodb';

export const DOMAIN_INDEXES = {
  projects: [
    {
      key: { provider: 1, owner: 1, repository: 1 },
      name: 'projects_provider_owner_repository_unique',
      unique: true,
    },
    { key: { createdAt: -1, _id: -1 }, name: 'projects_created_at_id' },
  ],
  deployments: [
    {
      key: { sourceWebhookEventId: 1 },
      name: 'deployments_source_webhook_event_unique',
      unique: true,
      partialFilterExpression: { sourceWebhookEventId: { $type: 'string' } },
    },
    {
      key: { projectId: 1, createdAt: -1, _id: -1 },
      name: 'deployments_project_created_at_id',
    },
    {
      key: { 'ci.status': 1, 'ci.leaseExpiresAt': 1, _id: 1 },
      name: 'deployments_ci_lease_expiry',
      partialFilterExpression: { 'ci.status': { $exists: true } },
    },
    {
      key: { 'release.status': 1, 'release.leaseExpiresAt': 1, _id: 1 },
      name: 'deployments_release_lease_expiry',
      partialFilterExpression: { 'release.status': { $exists: true } },
    },
    { key: { createdAt: -1, _id: -1 }, name: 'deployments_created_at_id' },
  ],
  webhookEvents: [
    {
      key: { provider: 1, deliveryId: 1 },
      name: 'webhook_events_provider_delivery_unique',
      unique: true,
    },
    {
      key: { processingStatus: 1, updatedAt: 1, _id: 1 },
      name: 'webhook_events_processing_updated_id',
    },
    { key: { createdAt: -1, _id: -1 }, name: 'webhook_events_created_at_id' },
  ],
} as const satisfies Record<string, readonly IndexDescription[]>;

export async function ensureDomainIndexes(db: Db): Promise<void> {
  await db.collection('projects').createIndexes([...DOMAIN_INDEXES.projects]);
  await db.collection('deployments').createIndexes([...DOMAIN_INDEXES.deployments]);
  await db.collection('webhookEvents').createIndexes([...DOMAIN_INDEXES.webhookEvents]);
}

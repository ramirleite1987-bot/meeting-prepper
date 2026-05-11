import { randomUUID } from 'node:crypto';
import { LinearAdapter } from '../adapters/linear.adapter.js';
import type {
  LinearIssueContext,
  LinearProjectContext,
  LinearProjectSummary,
} from '../adapters/types.js';
import { queries } from '../db/index.js';

interface LinearProjectReader {
  initialize(): Promise<void>;
  listProjects(limit?: number): Promise<LinearProjectSummary[]>;
  getProjectContext(projectId: string, issueLimit?: number): Promise<LinearProjectContext>;
}

export interface LinearProjectImportResult {
  imported: number;
  projectId: string;
}

export class LinearContextService {
  private initialized = false;

  constructor(private readonly adapter: LinearProjectReader = new LinearAdapter()) {}

  async listProjects(): Promise<LinearProjectSummary[]> {
    await this.ensureInitialized();
    return this.adapter.listProjects();
  }

  async importProjectContext(
    clientId: string,
    projectId: string,
  ): Promise<LinearProjectImportResult> {
    await this.ensureInitialized();

    const context = await this.adapter.getProjectContext(projectId);
    const rows = [
      projectToContextRow(clientId, context.project),
      ...context.issues.map((issue) => issueToContextRow(clientId, issue)),
    ];

    const statement = queries.upsertExternalContext();
    for (const row of rows) {
      statement.run(row);
    }

    return { imported: rows.length, projectId };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.adapter.initialize();
    this.initialized = true;
  }
}

function projectToContextRow(clientId: string, project: LinearProjectSummary) {
  return {
    id: randomUUID(),
    clientId,
    source: 'linear',
    externalId: `project:${project.id}`,
    title: `Linear project: ${project.name}`,
    content: [project.description, project.content].filter(Boolean).join('\n\n'),
    occurredAt: project.updatedAt.toISOString(),
    metadata: JSON.stringify({
      kind: 'project',
      projectId: project.id,
      url: project.url,
    }),
  };
}

function issueToContextRow(clientId: string, issue: LinearIssueContext) {
  return {
    id: randomUUID(),
    clientId,
    source: 'linear',
    externalId: `issue:${issue.id}`,
    title: `${issue.identifier}: ${issue.title}`,
    content: issue.description || '',
    occurredAt: issue.updatedAt.toISOString(),
    metadata: JSON.stringify({
      kind: 'issue',
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
    }),
  };
}

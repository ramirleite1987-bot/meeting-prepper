import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinearAdapter } from '../../../src/adapters/linear.adapter.js';

// Mock the Linear SDK
vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn().mockImplementation(() => mockLinearClient),
}));

const mockLinearClient = {
  viewer: Promise.resolve({ id: 'user-1' }),
  teams: vi.fn(),
  projects: vi.fn(),
  project: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  issue: vi.fn(),
  users: vi.fn(),
};

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    identifier: 'ENG-42',
    url: 'https://linear.app/team/ENG-42',
    title: 'Test Issue',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-02'),
    state: Promise.resolve({ name: 'In Progress' }),
    ...overrides,
  };
}

describe('LinearAdapter', () => {
  let adapter: LinearAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LINEAR_API_KEY = 'test-key';
    process.env.LINEAR_TEAM_ID = 'team-1';
    adapter = new LinearAdapter();

    mockLinearClient.teams.mockResolvedValue({ nodes: [{ id: 'team-1' }] });
    mockLinearClient.projects.mockResolvedValue({
      nodes: [
        {
          id: 'project-1',
          name: 'Implementation',
          description: 'Delivery work',
          content: 'Current scope',
          url: 'https://linear.app/project/implementation',
          updatedAt: new Date('2025-01-03'),
        },
      ],
    });
    mockLinearClient.users.mockResolvedValue({ nodes: [] });
  });

  describe('initialize', () => {
    it('should throw if LINEAR_API_KEY is not set', async () => {
      delete process.env.LINEAR_API_KEY;
      const a = new LinearAdapter();
      await expect(a.initialize()).rejects.toThrow('LINEAR_API_KEY');
    });

    it('should initialize successfully with API key', async () => {
      await expect(adapter.initialize()).resolves.not.toThrow();
    });

    it('should fetch teams if LINEAR_TEAM_ID is not set', async () => {
      delete process.env.LINEAR_TEAM_ID;
      const a = new LinearAdapter();
      await a.initialize();
      expect(mockLinearClient.teams).toHaveBeenCalled();
    });
  });

  describe('isAvailable', () => {
    it('should return false when not initialized', async () => {
      const a = new LinearAdapter();
      expect(await a.isAvailable()).toBe(false);
    });

    it('should return true when initialized', async () => {
      await adapter.initialize();
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  describe('createTask', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should create an issue and return a TaskReference', async () => {
      const issue = makeIssue();
      mockLinearClient.createIssue.mockResolvedValue({ issue: Promise.resolve(issue) });
      mockLinearClient.issue.mockResolvedValue(issue);

      const result = await adapter.createTask({
        title: 'Fix bug',
        description: 'It is broken',
        priority: 'high',
        status: 'pending',
        source: 'krisp',
      });

      expect(result.externalId).toBe('ENG-42');
      expect(result.source).toBe('linear');
      expect(result.title).toBe('Test Issue');
      expect(mockLinearClient.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'team-1', title: 'Fix bug', priority: 2 }),
      );
    });

    it('should throw when issue creation returns null', async () => {
      mockLinearClient.createIssue.mockResolvedValue({ issue: Promise.resolve(null) });
      await expect(
        adapter.createTask({ title: 'Test', status: 'pending', source: 'test' }),
      ).rejects.toThrow('Failed to create Linear issue');
    });

    it('should lookup assignee when provided', async () => {
      const issue = makeIssue();
      mockLinearClient.users.mockResolvedValueOnce({ nodes: [{ id: 'user-1' }] });
      mockLinearClient.createIssue.mockResolvedValue({ issue: Promise.resolve(issue) });
      mockLinearClient.issue.mockResolvedValue(issue);

      await adapter.createTask({
        title: 'Task',
        assignee: 'John',
        status: 'pending',
        source: 'test',
      });

      expect(mockLinearClient.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'user-1' }),
      );
    });

    it('should create an issue in the selected project', async () => {
      const issue = makeIssue();
      mockLinearClient.createIssue.mockResolvedValue({ issue: Promise.resolve(issue) });
      mockLinearClient.issue.mockResolvedValue(issue);

      await adapter.createTask({
        title: 'Task',
        status: 'pending',
        source: 'test',
        metadata: { linearProjectId: 'project-1' },
      });

      expect(mockLinearClient.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1' }),
      );
    });
  });

  describe('projects', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should list projects that can be selected for sync', async () => {
      const projects = await adapter.listProjects();

      expect(projects).toEqual([
        {
          id: 'project-1',
          name: 'Implementation',
          description: 'Delivery work',
          content: 'Current scope',
          url: 'https://linear.app/project/implementation',
          updatedAt: new Date('2025-01-03'),
        },
      ]);
      expect(mockLinearClient.projects).toHaveBeenCalledWith({ first: 50 });
    });

    it('should read project content and issues for prep context', async () => {
      const project = {
        id: 'project-1',
        name: 'Implementation',
        description: 'Delivery work',
        content: 'Current scope',
        url: 'https://linear.app/project/implementation',
        updatedAt: new Date('2025-01-03'),
        issues: vi.fn().mockResolvedValue({
          nodes: [
            makeIssue({
              id: 'issue-1',
              identifier: 'ENG-42',
              title: 'Ship onboarding',
              description: 'Finish onboarding flow',
              url: 'https://linear.app/team/ENG-42',
              updatedAt: new Date('2025-01-04'),
            }),
          ],
        }),
      };
      mockLinearClient.project.mockResolvedValue(project);

      const context = await adapter.getProjectContext('project-1');

      expect(context.project.name).toBe('Implementation');
      expect(context.issues).toEqual([
        expect.objectContaining({
          id: 'issue-1',
          identifier: 'ENG-42',
          title: 'Ship onboarding',
        }),
      ]);
      expect(project.issues).toHaveBeenCalledWith({ first: 50 });
    });
  });

  describe('updateTask', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should update an issue and return updated TaskReference', async () => {
      const issue = makeIssue({ title: 'Updated Title' });
      mockLinearClient.updateIssue.mockResolvedValue({});
      mockLinearClient.issue.mockResolvedValue(issue);

      const result = await adapter.updateTask('issue-1', { title: 'Updated Title' });

      expect(result.title).toBe('Updated Title');
      expect(mockLinearClient.updateIssue).toHaveBeenCalledWith(
        'issue-1',
        expect.objectContaining({ title: 'Updated Title' }),
      );
    });

    it('should map priority and dueDate on update', async () => {
      const issue = makeIssue();
      mockLinearClient.updateIssue.mockResolvedValue({});
      mockLinearClient.issue.mockResolvedValue(issue);

      await adapter.updateTask('issue-1', {
        priority: 'urgent',
        dueDate: new Date('2025-06-01'),
      });

      expect(mockLinearClient.updateIssue).toHaveBeenCalledWith(
        'issue-1',
        expect.objectContaining({ priority: 1, dueDate: '2025-06-01' }),
      );
    });
  });

  describe('API errors and rate limits', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should throw non-rate-limit errors immediately', async () => {
      mockLinearClient.createIssue.mockRejectedValue(new Error('Network failure'));

      await expect(
        adapter.createTask({ title: 'Test', status: 'pending', source: 'test' }),
      ).rejects.toThrow('Network failure');

      expect(mockLinearClient.createIssue).toHaveBeenCalledTimes(1);
    });

    it('should retry on rate limit errors and eventually throw', async () => {
      const rateLimitError = new Error('rate limit exceeded');
      mockLinearClient.createIssue.mockRejectedValue(rateLimitError);

      await expect(
        adapter.createTask({ title: 'Test', status: 'pending', source: 'test' }),
      ).rejects.toThrow('rate limit');

      // Default maxRetries is 3
      expect(mockLinearClient.createIssue).toHaveBeenCalledTimes(3);
    }, 15000);

    it('should succeed on retry after rate limit', async () => {
      const issue = makeIssue();
      mockLinearClient.createIssue
        .mockRejectedValueOnce(new Error('rate limit exceeded'))
        .mockResolvedValueOnce({ issue: Promise.resolve(issue) });
      mockLinearClient.issue.mockResolvedValue(issue);

      const result = await adapter.createTask({ title: 'Test', status: 'pending', source: 'test' });
      expect(result.externalId).toBe('ENG-42');
      expect(mockLinearClient.createIssue).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  describe('getTaskStatus', () => {
    beforeEach(async () => {
      await adapter.initialize();
    });

    it('should map Linear states correctly', async () => {
      const states = [
        { name: 'Backlog', expected: 'backlog' },
        { name: 'Todo', expected: 'todo' },
        { name: 'In Progress', expected: 'in-progress' },
        { name: 'In Review', expected: 'in-review' },
        { name: 'Done', expected: 'done' },
        { name: 'Cancelled', expected: 'cancelled' },
      ];

      for (const { name, expected } of states) {
        mockLinearClient.issue.mockResolvedValueOnce(
          makeIssue({ state: Promise.resolve({ name }) }),
        );
        const status = await adapter.getTaskStatus('issue-1');
        expect(status).toBe(expected);
      }
    });

    it('should default to todo when state is null', async () => {
      mockLinearClient.issue.mockResolvedValueOnce(makeIssue({ state: Promise.resolve(null) }));
      const status = await adapter.getTaskStatus('issue-1');
      expect(status).toBe('todo');
    });
  });

  describe('disconnect', () => {
    it('should clean up client', async () => {
      await adapter.initialize();
      await adapter.disconnect();
      expect(await adapter.isAvailable()).toBe(false);
    });
  });
});

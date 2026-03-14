/**
 * Task file loader for the agent harness orchestrator.
 *
 * Replaces the previous regex-based parseTaskYaml() with a proper YAML parser
 * so that nested structures (agent_spec) are correctly parsed.
 */
import fs from 'fs';
import { parse as parseYaml } from 'yaml';

import { logger } from './logger.js';
import { AgentSpec } from './session-spec.js';

export interface TaskFile {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  parent: string | null;
  deliverables: string[];
  project: string;   // derived from directory path by findAssignedTasks()
  filePath: string;  // absolute path to the YAML file
  agent_spec?: AgentSpec;
}

/**
 * Parse a task YAML file. Returns null if the file is missing required fields
 * or cannot be parsed.
 *
 * Note: `project` and `filePath` are left empty and must be filled in by the
 * caller (findAssignedTasks) which knows the directory context.
 */
export function loadTaskFile(filePath: string): TaskFile | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn({ file: filePath, err }, 'Failed to read task file');
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(content) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ file: filePath, err }, 'Failed to parse task YAML');
    return null;
  }

  if (!parsed?.id || !parsed?.status) {
    logger.warn({ file: filePath }, 'Task file missing required fields (id, status)');
    return null;
  }

  return {
    id: String(parsed.id),
    title: String(parsed.title ?? ''),
    description: String(parsed.description ?? ''),
    status: String(parsed.status),
    priority: String(parsed.priority ?? 'P2'),
    assignee: parsed.assignee != null ? String(parsed.assignee) : null,
    parent: parsed.parent != null ? String(parsed.parent) : null,
    deliverables: Array.isArray(parsed.deliverables)
      ? (parsed.deliverables as unknown[]).map(String)
      : [],
    project: '',   // filled in by caller
    filePath: '',  // filled in by caller
    agent_spec: parsed.agent_spec as AgentSpec | undefined,
  };
}

/**
 * Update the status (and optionally assignee) of a task file in-place.
 * Uses string replacement to preserve the rest of the file as-is.
 */
export function updateTaskStatus(
  filePath: string,
  newStatus: string,
  assignee?: string,
): void {
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/^status:\s*.+$/m, `status: ${newStatus}`);
  content = content.replace(/^updated:\s*.+$/m, `updated: ${new Date().toISOString()}`);
  if (assignee !== undefined) {
    content = content.replace(/^assignee:\s*.+$/m, `assignee: ${assignee}`);
  }
  fs.writeFileSync(filePath, content);
}

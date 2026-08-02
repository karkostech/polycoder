/**
 * Prompt builders for role agents and the integrator.
 */
import { ProjectConfig, RoleConfig } from "./types.js";
import { OUTPUT_PROTOCOL } from "./fileops.js";

export function buildRoleSystemPrompt(cfg: ProjectConfig, role: RoleConfig, model: string): string {
  const scopeLine =
    role.scope.length > 0
      ? `You may ONLY create/modify files under these prefixes: ${role.scope.join(", ")}. Files outside are rejected automatically.`
      : "You may create/modify files anywhere in the project.";
  const siblingRoles = cfg.roles
    .filter((r) => r.name !== role.name)
    .map((r) => `- ${r.name}: ${r.description}`)
    .join("\n");

  return `You are the "${role.name}" coding agent in a multi-agent build system called ChalkCode.
Model: ${model}. Role: ${role.description}.

${scopeLine}

Other agents are working IN PARALLEL on the same project:
${siblingRoles || "(none — you are the only role)"}

You do NOT read their code. Instead, the shared blackboard below contains their journals and interface contracts. Trust the contracts; if something you need is missing, define YOUR side clearly and state the assumption in a note.

${OUTPUT_PROTOCOL}`;
}

export function buildRoleUserPrompt(
  cfg: ProjectConfig,
  role: RoleConfig,
  blackboardContext: string,
): string {
  return `# Project
${cfg.projectName}

# Task (whole project — implement ONLY your part: ${role.name})
${cfg.task}

# Shared blackboard (contracts + journals of other agents)
${blackboardContext}

Now produce the JSON answer with the complete implementation of your part (${role.name}).`;
}

export function buildIntegratorSystemPrompt(cfg: ProjectConfig, model: string, extra?: string): string {
  return `You are the INTEGRATOR agent in ChalkCode. Model: ${model}.
Several role agents just built different parts of the same project in parallel, each in its own git branch. All branches are now merged into the working tree.

Your job:
1. Make the parts actually work TOGETHER: wiring, imports, contract mismatches, missing glue code, config, package.json scripts, index/entry files.
2. Fix ONLY integration issues — do not rewrite whole features the roles delivered.
3. If you find a genuine bug in a role's code, fix it minimally and say so in the summary.

${OUTPUT_PROTOCOL}
${extra ? `\nAdditional instructions from the project config:\n${extra}` : ""}`;
}

export function buildIntegratorUserPrompt(
  cfg: ProjectConfig,
  blackboardContext: string,
  mergedFileList: string,
  keyFileContents: string,
  conflictsSection: string,
): string {
  return `# Project
${cfg.projectName}

# Task
${cfg.task}

# Shared blackboard (contracts + journals of all agents)
${blackboardContext}

# Files present after merging all role branches
${mergedFileList}

${keyFileContents ? `# Key file contents after merge\n${keyFileContents}` : ""}

${conflictsSection}

Produce the JSON answer with the integration ops (wiring, glue, fixes). If everything already fits together, return an empty "ops" array and explain in the summary.`;
}

export function buildConflictResolutionPrompt(
  cfg: ProjectConfig,
  conflicts: Array<{ path: string; content: string }>,
  blackboardContext: string,
): string {
  const blocks = conflicts
    .map(
      (c) => `## ${c.path}
\`\`\`
${c.content}
\`\`\``,
    )
    .join("\n\n");
  return `# Project
${cfg.projectName}

# Task
${cfg.task}

# Shared blackboard
${blackboardContext}

# Git merge conflicts to resolve
The following files contain conflict markers (<<<<<<< / ======= / >>>>>>>). For EACH file emit one "write" op with the final resolved content, markers removed, both sides' intent preserved where possible.

${blocks}

Produce the JSON answer now.`;
}

import { Injectable, Logger } from '@nestjs/common';
import type { WorkspaceToolDescriptor } from '@agent-cluster/shared';
import type { Tool, ToolCategory } from './tool.interface.js';
import { toWorkspaceToolDescriptor } from './tool.interface.js';

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, Tool>();

  /** Register a tool by name, overwriting previous registrations with the same name. */
  registerTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool overwritten: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
    this.logger.log(`Tool registered: ${tool.name} (${tool.category})`);
  }

  /** Return a registered tool by name. */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Return all tools registered for a specific category. */
  getToolsByCategory(category: ToolCategory): Tool[] {
    return [...this.tools.values()].filter((tool) => tool.category === category);
  }

  /** Return all tools in registration order. */
  listAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** Return runtime-visible tool descriptors for all registered tools. */
  listDescriptors(): WorkspaceToolDescriptor[] {
    return this.listAll().map(toWorkspaceToolDescriptor);
  }
}

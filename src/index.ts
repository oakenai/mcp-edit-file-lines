#!/usr/bin/env node
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { approveEdit } from "./utils/approveEdit.js";
import { editFile } from "./utils/fileEditor.js";
import { getLineInfo } from "./utils/lineInfo.js";
import { StateManager } from "./utils/stateManager.js";

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "Usage: ./build/index.js <allowed-directory> [additional-directories...]"
  );
  process.exit(1);
}

// Normalize paths and expand home directory
function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase();
}

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map((dir) =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate directories
await Promise.all(
  args.map(async (dir) => {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
      process.exit(1);
    }
  })
);

// Path validation
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  const isAllowed = allowedDirectories.some((dir) =>
    normalizedRequested.startsWith(dir)
  );
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute}`
    );
  }

  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some((dir) =>
      normalizedReal.startsWith(dir)
    );
    if (!isRealPathAllowed) {
      throw new Error(
        "Access denied - symlink target outside allowed directories"
      );
    }
    return realPath;
  } catch (error) {
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some((dir) =>
        normalizedParent.startsWith(dir)
      );
      if (!isParentAllowed) {
        throw new Error(
          "Access denied - parent directory outside allowed directories"
        );
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema for edit_file
const EditSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
  z.string()
]);

const EditFileArgsSchema = z.object({
  p: z.string(),
  e: z.array(EditSchema),
  dryRun: z.boolean().default(false)
});

// Schema for get_line_info
const GetLineInfoArgsSchema = z.object({
  path: z.string(),
  lineNumbers: z.array(z.number().int().min(1)),
  context: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of context lines before and after")
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Add to server setup section
const stateManager = new StateManager();

// Server setup
const server = new Server(
  {
    name: "edit-file-lines",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "edit_file_lines",
        description:
          "Make line-based edits to a file. Each edit is a tuple of [startLine, endLine, newContent] " +
          "specifying a line range to replace with new content. When dryRun is true, returns a diff " +
          "and a stateId that can be used with approve_edit tool to apply the edit. The stateId is only valid for 1 minute. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(EditFileArgsSchema) as ToolInput
      },
      {
        name: "approve_edit",
        description:
          "Approve and apply a previously validated edit from a dry run with edit_file_lines call using its stateId.",
        inputSchema: zodToJsonSchema(
          z.object({
            stateId: z
              .string()
              .describe("State ID returned from a dry run edit_file_lines call")
          })
        ) as ToolInput
      },
      {
        name: "get_file_lines",
        description:
          "Get information about specific line numbers in a file, including their content " +
          "and optional context lines. Useful for verifying line numbers before making edits. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetLineInfoArgsSchema) as ToolInput
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "edit_file_lines") {
      const parsed = EditFileArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error}`);
      }

      try {
        const validPath = await validatePath(parsed.data.p);
        const result = await editFile(
          { ...parsed.data, p: validPath },
          parsed.data.dryRun
        );

        if (parsed.data.dryRun) {
          const stateId = stateManager.saveState(validPath, parsed.data.e);
          return {
            content: [
              {
                type: "text",
                text: `${result}\nState ID: ${stateId}\nUse this ID with approve_edit to apply the changes.`
              }
            ]
          };
        }

        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }

    if (name === "approve_edit") {
      const parsed = z.object({ stateId: z.string() }).safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error}`);
      }

      try {
        const result = await approveEdit(parsed.data.stateId, stateManager);
        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }

    if (name === "get_file_lines") {
      const parsed = GetLineInfoArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments for get_line_info: ${parsed.error}`);
      }

      try {
        const validPath = await validatePath(parsed.data.path);
        const result = await getLineInfo(
          validPath,
          parsed.data.lineNumbers,
          parsed.data.context
        );
        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Edit File Lines Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

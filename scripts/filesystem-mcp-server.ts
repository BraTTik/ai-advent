import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import fg from 'fast-glob';
import type { Options as FastGlobOptions } from 'fast-glob';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local'),
});

const PORT = process.env.FILESYSTEM_MCP_PORT ? Number(process.env.FILESYSTEM_MCP_PORT) : 3334;
const BASE_DIR = process.env.FILESYSTEM_BASE_DIR 
  ? path.resolve(process.env.FILESYSTEM_BASE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readFileSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});

const readFileLinesSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});

const listDirectorySchema = z.object({
  dirPath: z.string().min(1, 'Directory path is required'),
  recursive: z.boolean().optional().default(false),
});

const findFilesSchema = z.object({
  pattern: z.string().min(1, 'Pattern is required (e.g., *.txt, **/*.js, src/**/*.ts)'),
  searchDir: z.string().optional().default('.'),
  caseSensitive: z.boolean().optional().default(false),
  onlyFiles: z.boolean().optional().default(true),
  onlyDirectories: z.boolean().optional().default(false),
});

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const activeSessions = new Map<string, SessionEntry>();

/**
 * Безопасная нормализация пути - предотвращает выход за пределы BASE_DIR
 */
function safeResolvePath(inputPath: string): string {
  // Убираем ведущие слеши и точки
  const normalized = path.normalize(inputPath);
  const resolved = path.resolve(BASE_DIR, normalized);
  
  // Проверяем, что путь находится внутри BASE_DIR
  if (!resolved.startsWith(BASE_DIR)) {
    throw new Error(`Path ${inputPath} is outside allowed directory`);
  }
  
  return resolved;
}

/**
 * Проверка существования файла/директории
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createFilesystemServer() {
  const server = new McpServer(
    {
      name: 'filesystem-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  // Инструмент для чтения файла
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description: 'Read the contents of a file from the filesystem. Returns the full file content.',
      inputSchema: readFileSchema,
    },
    async ({ filePath, encoding = 'utf8' }) => {
      try {
        const safePath = safeResolvePath(filePath);
        
        if (!(await pathExists(safePath))) {
          throw new Error(`File not found: ${filePath}`);
        }

        const stats = await fs.stat(safePath);
        if (!stats.isFile()) {
          throw new Error(`Path is not a file: ${filePath}`);
        }

        const content = await fs.readFile(safePath, encoding);
        
        const fileInfo = {
          path: filePath,
          absolutePath: safePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          encoding,
        };

        const contentText = encoding === 'base64' 
          ? (content as unknown as Buffer).toString('base64')
          : (content as string);

          console.log(contentText);
        return {
          content: [
            {
              type: 'text' as const,
              text: contentText,
            },
          ],
          structuredContent: {
            ...fileInfo,
            content: contentText,
            isBase64: encoding === 'base64',
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read file ${filePath}: ${errorMessage}`);
      }
    },
  );

  // Инструмент для чтения части файла (по строкам)
  server.registerTool(
    'read_file_lines',
    {
      title: 'Read File Lines',
      description: 'Read specific lines from a file. If startLine and endLine are not provided, reads the entire file.',
      inputSchema: readFileLinesSchema,
    },
    async ({ filePath, startLine, endLine, encoding = 'utf8' }) => {
      try {
        const safePath = safeResolvePath(filePath);
        
        if (!(await pathExists(safePath))) {
          throw new Error(`File not found: ${filePath}`);
        }

        const stats = await fs.stat(safePath);
        if (!stats.isFile()) {
          throw new Error(`Path is not a file: ${filePath}`);
        }

        const content = await fs.readFile(safePath, encoding);
        const contentString = encoding === 'base64'
          ? (content as unknown as Buffer).toString('utf8')
          : (content as string);
        const lines = contentString.split('\n');
        
        const totalLines = lines.length;
        const start = startLine ? Math.max(1, Math.min(startLine, totalLines)) : 1;
        const end = endLine ? Math.max(start, Math.min(endLine, totalLines)) : totalLines;
        
        const selectedLines = lines.slice(start - 1, end);
        const result = selectedLines.join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
          structuredContent: {
            path: filePath,
            absolutePath: safePath,
            totalLines,
            startLine: start,
            endLine: end,
            linesRead: end - start + 1,
            content: result,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read file lines from ${filePath}: ${errorMessage}`);
      }
    },
  );

  // Инструмент для листинга директории
  server.registerTool(
    'list_directory',
    {
      title: 'List Directory',
      description: 'List files and directories in a given path. Can list recursively if recursive is true.',
      inputSchema: listDirectorySchema,
    },
    async ({ dirPath, recursive = false }) => {
      try {
        const safePath = safeResolvePath(dirPath);
        
        if (!(await pathExists(safePath))) {
          throw new Error(`Directory not found: ${dirPath}`);
        }

        const stats = await fs.stat(safePath);
        if (!stats.isDirectory()) {
          throw new Error(`Path is not a directory: ${dirPath}`);
        }

        async function listDir(currentPath: string, currentRelative: string, depth: number = 0): Promise<any[]> {
          const items: any[] = [];
          const entries = await fs.readdir(currentPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            const relativePath = path.join(currentRelative, entry.name).replace(/\\/g, '/');
            const entryStats = await fs.stat(fullPath);

            const item: any = {
              name: entry.name,
              path: relativePath,
              absolutePath: fullPath,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: entryStats.size,
              modified: entryStats.mtime.toISOString(),
            };

            if (entry.isFile()) {
              item.extension = path.extname(entry.name);
            }

            items.push(item);

            if (recursive && entry.isDirectory() && depth < 10) {
              // Ограничение глубины рекурсии для безопасности
              const subItems = await listDir(fullPath, relativePath, depth + 1);
              items.push(...subItems);
            }
          }

          return items;
        }

        const items = await listDir(safePath, dirPath);
        
        const summary = {
          path: dirPath,
          absolutePath: safePath,
          totalItems: items.length,
          files: items.filter(i => i.type === 'file').length,
          directories: items.filter(i => i.type === 'directory').length,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: `Directory listing for ${dirPath}:\n\n` +
                items.map(item => {
                  const icon = item.type === 'directory' ? '📁' : '📄';
                  const size = item.type === 'file' ? ` (${formatFileSize(item.size)})` : '';
                  return `${icon} ${item.path}${size}`;
                }).join('\n'),
            },
          ],
          structuredContent: {
            ...summary,
            items,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list directory ${dirPath}: ${errorMessage}`);
      }
    },
  );

  // Инструмент для поиска файлов по glob шаблону
  server.registerTool(
    'find_files',
    {
      title: 'Find Files',
      description: 'Search for files and directories using glob patterns (e.g., *.txt, **/*.js, src/**/*.ts). Supports standard glob syntax with wildcards.',
      inputSchema: findFilesSchema,
    },
    async ({ pattern, searchDir = '.', caseSensitive = false, onlyFiles = true, onlyDirectories = false }) => {
      try {
        const safeSearchDir = safeResolvePath(searchDir);
        
        if (!(await pathExists(safeSearchDir))) {
          throw new Error(`Search directory not found: ${searchDir}`);
        }

        const stats = await fs.stat(safeSearchDir);
        if (!stats.isDirectory()) {
          throw new Error(`Search path is not a directory: ${searchDir}`);
        }

        // Строим полный путь для поиска
        const searchPattern = path.join(safeSearchDir, pattern);
        
        // Настройки для fast-glob
        const globOptions: FastGlobOptions = {
          cwd: safeSearchDir,
          caseSensitiveMatch: caseSensitive,
          onlyFiles: onlyFiles && !onlyDirectories,
          onlyDirectories: onlyDirectories,
          absolute: true,
          stats: false,
        };

        const foundPaths = await fg(pattern, globOptions);
        
        // Получаем информацию о каждом найденном файле/директории
        const filesInfo = await Promise.all(
          foundPaths.map(async (filePath) => {
            try {
              const stats = await fs.stat(filePath);
              const relativePath = path.relative(BASE_DIR, filePath).replace(/\\/g, '/');
              
              const info: any = {
                path: relativePath,
                absolutePath: filePath,
                type: stats.isDirectory() ? 'directory' : 'file',
                size: stats.size,
                modified: stats.mtime.toISOString(),
              };

              if (stats.isFile()) {
                info.extension = path.extname(filePath);
              }

              return info;
            } catch (error) {
              // Если файл был удален между поиском и получением статистики
              return {
                path: path.relative(BASE_DIR, filePath).replace(/\\/g, '/'),
                absolutePath: filePath,
                type: 'unknown',
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );

        // Фильтруем только те, которые находятся в BASE_DIR (дополнительная проверка безопасности)
        const safeFiles = filesInfo.filter(file => 
          file.absolutePath && file.absolutePath.startsWith(BASE_DIR)
        );

        const summary = {
          pattern,
          searchDirectory: searchDir,
          totalFound: safeFiles.length,
          files: safeFiles.filter(f => f.type === 'file').length,
          directories: safeFiles.filter(f => f.type === 'directory').length,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${safeFiles.length} item(s) matching pattern "${pattern}" in ${searchDir}:\n\n` +
                safeFiles.map(file => {
                  const icon = file.type === 'directory' ? '📁' : '📄';
                  const size = file.type === 'file' ? ` (${formatFileSize(file.size)})` : '';
                  const error = file.error ? ` [ERROR: ${file.error}]` : '';
                  return `${icon} ${file.path}${size}${error}`;
                }).join('\n'),
            },
          ],
          structuredContent: {
            ...summary,
            items: safeFiles,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to find files with pattern "${pattern}": ${errorMessage}`);
      }
    },
  );

  return server;
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function cleanupSession(sessionId?: string) {
  if (!sessionId) {
    return;
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return;
  }

  void entry.transport.close().catch(() => undefined);
  void entry.server.close().catch(() => undefined);
  activeSessions.delete(sessionId);
}

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: ['Content-Type', 'mcp-session-id'],
  }),
);

const ensureSessionTransport = async (req: Request, res: Response) => {
  const rawSessionId = req.headers['mcp-session-id'];
  const sessionId = (Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId)?.trim();

  if (sessionId) {
    const entry = activeSessions.get(sessionId);
    if (entry) {
      return entry;
    }

    // Session is unknown (maybe server restarted). Allow re-initialization if request is initialize.
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session ID' },
        id: null,
      });
      return null;
    }
  } else if (!isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Initialization request required' },
      id: null,
    });
    return null;
  }

  const server = createFilesystemServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      activeSessions.set(newSessionId, { server, transport });
    },
    onsessionclosed: (closedSessionId) => {
      cleanupSession(closedSessionId);
    },
  });

  transport.onclose = () => {
    cleanupSession(transport.sessionId);
  };

  await server.connect(transport);
  return { server, transport };
};

const handlePost = async (req: Request, res: Response) => {
  try {
    const entry = await ensureSessionTransport(req, res);
  
    if (!entry) {
      return;
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP POST request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error in MCP transport',
        },
        id: null,
      });
    }
  }
};

const handleSessionRequest = async (req: Request, res: Response) => {
  const sessionId = (req.headers['mcp-session-id'] as string | undefined)?.trim();
  if (!sessionId || !activeSessions.has(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }

  const entry = activeSessions.get(sessionId)!;

  try {
    await entry.transport.handleRequest(req, res);
  } catch (error) {
    console.error('MCP session request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error in MCP transport',
        },
        id: null,
      });
    }
  }
};

app.post('/mcp', handlePost);
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Filesystem MCP server is running. Point your MCP client to /mcp',
    baseDirectory: BASE_DIR,
  });
});

const serverInstance = app.listen(PORT, () => {
  console.log(`Filesystem MCP server listening on http://localhost:${PORT}`);
  console.log(`Base directory: ${BASE_DIR}`);
});

const shutdown = async () => {
  console.log('Shutting down Filesystem MCP server...');
  await Promise.all(
    [...activeSessions.values()].map(async ({ transport, server }) => {
      await transport.close();
      await server.close();
    }),
  );
  activeSessions.clear();
  serverInstance.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


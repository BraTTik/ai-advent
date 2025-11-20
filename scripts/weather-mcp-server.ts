import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local'),
});

const PORT = process.env.WEATHER_MCP_PORT ? Number(process.env.WEATHER_MCP_PORT) : 3333;
const WEATHER_API_BASE = process.env.WEATHER_API_BASE ?? 'https://api.weatherapi.com/v1/current.json';
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

const weatherSchema = z.object({
  location: z.string().min(1, 'Location is required'),
});

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const activeSessions = new Map<string, SessionEntry>();

function createWeatherServer() {
  const server = new McpServer(
    {
      name: 'weather-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    'current_weather',
    {
      title: 'Current Weather',
      description:
        'Get current weather for US Zipcode, UK Postcode, Canada Postalcode, IP address, Latitude/Longitude (decimal degree) or city name.',
      inputSchema: weatherSchema,
    },
    async ({ location }) => {

      console.log({ location });
      if (!WEATHER_API_KEY) {
        throw new Error('Set WEATHER_API_KEY to query WeatherAPI');
      }

      const search = new URLSearchParams();
      search.set('q', location);
      search.set('key', WEATHER_API_KEY);

      const url = new URL(`${WEATHER_API_BASE}/current.json`);
      url.search = search.toString();

      try {
      
        console.log(url.toString())
      const response = await fetch(url.toString());
      if (!response.ok) {
        console.log("not ok")
        const text = await response.text();
        throw new Error(`Weather API failed (${response.status}): ${text}`);
      }


      const data = (await response.json()) as any;
      console.log(data);
      if (!data.current) {
        throw new Error('Weather API returned an unexpected payload');
      }

      console.log(data);
      const { current } = data;

      const temperatureC = current.temp_c;
      const temperatureF = current.temp_f;
      const feelsLikeC = current.feelslike_c;
      const feelsLikeF = current.feelslike_f;
      const windKph = current.wind_kph;
      const windMph = current.wind_mph;
      const humidity = current.humidity;
      const conditionText = current.condition?.text ?? 'Unknown';

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Weather for ${location}:\n` +
              `• Condition: ${conditionText}\n` +
              `• Temperature: ${temperatureC}°C (${temperatureF}°F)\n` +
              `• Feels like: ${feelsLikeC}°C (${feelsLikeF}°F)\n` +
              `• Humidity: ${humidity}%\n` +
              `• Wind: ${windKph} km/h (${windMph} mph)`,
          },
        ],
        structuredContent: {
          location,
          condition: conditionText,
          temperatureC,
          temperatureF,
          feelsLikeC,
          feelsLikeF,
          humidity,
          windKph,
          windMph,
        },
      };

    } catch (e) {
      console.log(e)
      throw e
    }
    },
  );

  return server;
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

  const server = createWeatherServer();
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
    message: 'Weather MCP server is running. Point your MCP client to /mcp',
  });
});

const serverInstance = app.listen(PORT, () => {
  console.log(`Weather MCP server listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  console.log('Shutting down Weather MCP server...');
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


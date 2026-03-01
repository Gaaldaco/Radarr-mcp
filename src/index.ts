import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RADARR_URL = process.env.RADARR_URL ?? "http://localhost:7878";
const RADARR_API_KEY = process.env.RADARR_API_KEY ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
// Set TRANSPORT=stdio to use stdin/stdout (e.g. Claude Desktop local mode)
const TRANSPORT = process.env.TRANSPORT ?? "http";

if (!RADARR_API_KEY) {
  console.error("RADARR_API_KEY environment variable is required");
  process.exit(1);
}

const BASE = `${RADARR_URL}/api/v3`;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function radarrFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-Api-Key": RADARR_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Radarr API error ${res.status}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function qs(params: Record<string, string | number | boolean | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // ── Movies ──────────────────────────────────────────────────────────────
  {
    name: "get_movies",
    description:
      "List all movies in the Radarr library, optionally filtered by TMDB ID.",
    inputSchema: {
      type: "object",
      properties: {
        tmdbId: { type: "number", description: "Filter by TMDB movie ID" },
      },
    },
  },
  {
    name: "get_movie",
    description: "Get full details of a single movie by its Radarr ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Radarr movie ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "lookup_movie",
    description:
      "Search for movies on TMDB by title or TMDB ID (prefixed with 'tmdb:'). Returns candidates to add.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "Movie title or 'tmdb:<id>'" },
      },
      required: ["term"],
    },
  },
  {
    name: "add_movie",
    description:
      "Add a movie to the Radarr library for monitoring and download.",
    inputSchema: {
      type: "object",
      properties: {
        tmdbId: { type: "number", description: "TMDB movie ID" },
        title: { type: "string", description: "Movie title" },
        year: { type: "number", description: "Release year" },
        qualityProfileId: {
          type: "number",
          description:
            "Quality profile ID (use get_quality_profiles to list them)",
        },
        rootFolderPath: {
          type: "string",
          description: "Root folder path for the movie",
        },
        monitored: {
          type: "boolean",
          description: "Monitor for download (default true)",
        },
        searchForMovie: {
          type: "boolean",
          description: "Immediately search for the movie (default true)",
        },
        minimumAvailability: {
          type: "string",
          enum: ["tba", "announced", "inCinemas", "released", "deleted"],
          description: "Minimum availability before searching",
        },
      },
      required: ["tmdbId", "title", "year", "qualityProfileId", "rootFolderPath"],
    },
  },
  {
    name: "update_movie",
    description:
      "Update monitoring status and other settings for an existing movie.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Radarr movie ID" },
        monitored: {
          type: "boolean",
          description: "Enable or disable monitoring",
        },
        qualityProfileId: {
          type: "number",
          description: "Change quality profile",
        },
        minimumAvailability: {
          type: "string",
          enum: ["tba", "announced", "inCinemas", "released", "deleted"],
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_movie",
    description: "Remove a movie from Radarr (optionally delete files).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Radarr movie ID" },
        deleteFiles: {
          type: "boolean",
          description: "Also delete files from disk (default false)",
        },
        addImportExclusion: {
          type: "boolean",
          description: "Add to import exclusion list (default false)",
        },
      },
      required: ["id"],
    },
  },
  // ── Calendar ────────────────────────────────────────────────────────────
  {
    name: "get_calendar",
    description:
      "Get movies releasing within a date range (defaults to next 7 days).",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Start date (ISO 8601, e.g. 2024-01-01)",
        },
        end: { type: "string", description: "End date (ISO 8601)" },
        unmonitored: {
          type: "boolean",
          description: "Include unmonitored movies",
        },
      },
    },
  },
  // ── Queue ────────────────────────────────────────────────────────────────
  {
    name: "get_queue",
    description: "Get the current download queue.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default 1)" },
        pageSize: {
          type: "number",
          description: "Results per page (default 20)",
        },
        includeMovie: {
          type: "boolean",
          description: "Include movie details (default true)",
        },
      },
    },
  },
  {
    name: "delete_queue_item",
    description: "Remove an item from the download queue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Queue item ID" },
        removeFromClient: {
          type: "boolean",
          description: "Also remove from download client",
        },
        blocklist: {
          type: "boolean",
          description: "Blocklist this release",
        },
      },
      required: ["id"],
    },
  },
  // ── History ──────────────────────────────────────────────────────────────
  {
    name: "get_history",
    description: "Get paginated download history.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        pageSize: { type: "number" },
        movieId: {
          type: "number",
          description: "Filter by Radarr movie ID",
        },
      },
    },
  },
  // ── Wanted ───────────────────────────────────────────────────────────────
  {
    name: "get_wanted_missing",
    description:
      "Get monitored movies that are missing (not yet downloaded).",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        pageSize: { type: "number" },
        sortKey: {
          type: "string",
          description: "Field to sort by (e.g. 'movies.title')",
        },
      },
    },
  },
  {
    name: "get_wanted_cutoff",
    description:
      "Get movies where the existing file doesn't meet the quality cutoff.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        pageSize: { type: "number" },
      },
    },
  },
  // ── Commands ──────────────────────────────────────────────────────────────
  {
    name: "execute_command",
    description:
      "Execute a Radarr command. Common names: RescanMovie, RefreshMovie, MoviesSearch, DownloadedMoviesScan, MissingMoviesSearch.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Command name" },
        movieIds: {
          type: "array",
          items: { type: "number" },
          description:
            "Movie IDs to operate on (for movie-specific commands)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_command_status",
    description: "Check the status of a previously submitted command.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Command ID" },
      },
      required: ["id"],
    },
  },
  // ── System ────────────────────────────────────────────────────────────────
  {
    name: "get_system_status",
    description:
      "Get Radarr system status (version, OS, .NET runtime, paths, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_health",
    description: "Get system health check results.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_disk_space",
    description:
      "Get disk space information for all configured paths.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Configuration ─────────────────────────────────────────────────────────
  {
    name: "get_quality_profiles",
    description: "List all configured quality profiles.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_root_folders",
    description: "List all configured root folders.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_tags",
    description: "List all tags defined in Radarr.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Indexers & Download Clients ───────────────────────────────────────────
  {
    name: "get_indexers",
    description: "List all configured indexers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_download_clients",
    description: "List all configured download clients.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Movie Files ───────────────────────────────────────────────────────────
  {
    name: "get_movie_files",
    description: "List files associated with a movie.",
    inputSchema: {
      type: "object",
      properties: {
        movieId: { type: "number", description: "Radarr movie ID" },
      },
      required: ["movieId"],
    },
  },
  {
    name: "delete_movie_file",
    description: "Delete a specific movie file from disk.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Movie file ID" },
      },
      required: ["id"],
    },
  },
  // ── Collections ───────────────────────────────────────────────────────────
  {
    name: "get_collections",
    description: "List movie collections tracked by Radarr.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Logs ──────────────────────────────────────────────────────────────────
  {
    name: "get_logs",
    description: "Retrieve Radarr application logs.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        pageSize: { type: "number" },
        level: {
          type: "string",
          enum: ["trace", "debug", "info", "warn", "error", "fatal"],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

async function handleTool(name: string, args: Args): Promise<string> {
  switch (name) {
    // ── Movies ──────────────────────────────────────────────────────────
    case "get_movies": {
      const q = args.tmdbId ? qs({ tmdbId: args.tmdbId as number }) : "";
      return JSON.stringify(await radarrFetch(`/movie${q}`), null, 2);
    }
    case "get_movie": {
      return JSON.stringify(await radarrFetch(`/movie/${args.id}`), null, 2);
    }
    case "lookup_movie": {
      return JSON.stringify(
        await radarrFetch(`/movie/lookup${qs({ term: args.term as string })}`),
        null,
        2
      );
    }
    case "add_movie": {
      const body = {
        tmdbId: args.tmdbId,
        title: args.title,
        year: args.year,
        qualityProfileId: args.qualityProfileId,
        rootFolderPath: args.rootFolderPath,
        monitored: args.monitored ?? true,
        minimumAvailability: args.minimumAvailability ?? "released",
        addOptions: { searchForMovie: args.searchForMovie ?? true },
      };
      return JSON.stringify(
        await radarrFetch("/movie", { method: "POST", body: JSON.stringify(body) }),
        null,
        2
      );
    }
    case "update_movie": {
      const existing = (await radarrFetch(`/movie/${args.id}`)) as Record<
        string,
        unknown
      >;
      const updated = {
        ...existing,
        ...(args.monitored !== undefined && { monitored: args.monitored }),
        ...(args.qualityProfileId !== undefined && {
          qualityProfileId: args.qualityProfileId,
        }),
        ...(args.minimumAvailability !== undefined && {
          minimumAvailability: args.minimumAvailability,
        }),
      };
      return JSON.stringify(
        await radarrFetch(`/movie/${args.id}`, {
          method: "PUT",
          body: JSON.stringify(updated),
        }),
        null,
        2
      );
    }
    case "delete_movie": {
      await radarrFetch(
        `/movie/${args.id}${qs({
          deleteFiles: args.deleteFiles as boolean | undefined,
          addImportExclusion: args.addImportExclusion as boolean | undefined,
        })}`,
        { method: "DELETE" }
      );
      return `Movie ${args.id} deleted successfully.`;
    }
    // ── Calendar ─────────────────────────────────────────────────────────
    case "get_calendar": {
      const now = new Date();
      const weekLater = new Date(now.getTime() + 7 * 86400000);
      return JSON.stringify(
        await radarrFetch(
          `/calendar${qs({
            start:
              (args.start as string | undefined) ??
              now.toISOString().slice(0, 10),
            end:
              (args.end as string | undefined) ??
              weekLater.toISOString().slice(0, 10),
            unmonitored: args.unmonitored as boolean | undefined,
          })}`
        ),
        null,
        2
      );
    }
    // ── Queue ─────────────────────────────────────────────────────────────
    case "get_queue": {
      return JSON.stringify(
        await radarrFetch(
          `/queue${qs({
            page: (args.page as number | undefined) ?? 1,
            pageSize: (args.pageSize as number | undefined) ?? 20,
            includeMovie: (args.includeMovie as boolean | undefined) ?? true,
          })}`
        ),
        null,
        2
      );
    }
    case "delete_queue_item": {
      await radarrFetch(
        `/queue/${args.id}${qs({
          removeFromClient: args.removeFromClient as boolean | undefined,
          blocklist: args.blocklist as boolean | undefined,
        })}`,
        { method: "DELETE" }
      );
      return `Queue item ${args.id} removed.`;
    }
    // ── History ───────────────────────────────────────────────────────────
    case "get_history": {
      if (args.movieId) {
        return JSON.stringify(
          await radarrFetch(
            `/history/movie${qs({ movieId: args.movieId as number })}`
          ),
          null,
          2
        );
      }
      return JSON.stringify(
        await radarrFetch(
          `/history${qs({
            page: (args.page as number | undefined) ?? 1,
            pageSize: (args.pageSize as number | undefined) ?? 20,
          })}`
        ),
        null,
        2
      );
    }
    // ── Wanted ────────────────────────────────────────────────────────────
    case "get_wanted_missing": {
      return JSON.stringify(
        await radarrFetch(
          `/wanted/missing${qs({
            page: (args.page as number | undefined) ?? 1,
            pageSize: (args.pageSize as number | undefined) ?? 20,
            sortKey: args.sortKey as string | undefined,
          })}`
        ),
        null,
        2
      );
    }
    case "get_wanted_cutoff": {
      return JSON.stringify(
        await radarrFetch(
          `/wanted/cutoff${qs({
            page: (args.page as number | undefined) ?? 1,
            pageSize: (args.pageSize as number | undefined) ?? 20,
          })}`
        ),
        null,
        2
      );
    }
    // ── Commands ──────────────────────────────────────────────────────────
    case "execute_command": {
      const body: Record<string, unknown> = { name: args.name };
      if (args.movieIds) body.movieIds = args.movieIds;
      return JSON.stringify(
        await radarrFetch("/command", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        null,
        2
      );
    }
    case "get_command_status": {
      return JSON.stringify(
        await radarrFetch(`/command/${args.id}`),
        null,
        2
      );
    }
    // ── System ────────────────────────────────────────────────────────────
    case "get_system_status":
      return JSON.stringify(await radarrFetch("/system/status"), null, 2);
    case "get_health":
      return JSON.stringify(await radarrFetch("/health"), null, 2);
    case "get_disk_space":
      return JSON.stringify(await radarrFetch("/diskspace"), null, 2);
    // ── Config ────────────────────────────────────────────────────────────
    case "get_quality_profiles":
      return JSON.stringify(await radarrFetch("/qualityprofile"), null, 2);
    case "get_root_folders":
      return JSON.stringify(await radarrFetch("/rootfolder"), null, 2);
    case "get_tags":
      return JSON.stringify(await radarrFetch("/tag"), null, 2);
    // ── Indexers & Download Clients ───────────────────────────────────────
    case "get_indexers":
      return JSON.stringify(await radarrFetch("/indexer"), null, 2);
    case "get_download_clients":
      return JSON.stringify(await radarrFetch("/downloadclient"), null, 2);
    // ── Movie Files ───────────────────────────────────────────────────────
    case "get_movie_files": {
      return JSON.stringify(
        await radarrFetch(
          `/moviefile${qs({ movieId: args.movieId as number })}`
        ),
        null,
        2
      );
    }
    case "delete_movie_file": {
      await radarrFetch(`/moviefile/${args.id}`, { method: "DELETE" });
      return `Movie file ${args.id} deleted.`;
    }
    // ── Collections ───────────────────────────────────────────────────────
    case "get_collections":
      return JSON.stringify(await radarrFetch("/collection"), null, 2);
    // ── Logs ──────────────────────────────────────────────────────────────
    case "get_logs": {
      return JSON.stringify(
        await radarrFetch(
          `/log${qs({
            page: (args.page as number | undefined) ?? 1,
            pageSize: (args.pageSize as number | undefined) ?? 50,
            level: args.level as string | undefined,
          })}`
        ),
        null,
        2
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Build MCP Server instance (shared across transports)
// ---------------------------------------------------------------------------

function createServer() {
  const server = new Server(
    { name: "radarr-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, (args ?? {}) as Args);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

if (TRANSPORT === "stdio") {
  // ── Stdio mode (Claude Desktop / local) ─────────────────────────────────
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Radarr MCP server started (stdio, ${RADARR_URL})`);
} else {
  // ── HTTP + SSE mode (Railway / remote) ──────────────────────────────────
  const app = express();

  // Map of sessionId → SSEServerTransport for multi-session support
  const sessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);

    res.on("close", () => {
      sessions.delete(transport.sessionId);
    });

    const server = createServer();
    await server.connect(transport);
    console.error(`SSE session opened: ${transport.sessionId}`);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessions.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    await transport.handlePostMessage(req, res);
  });

  // Health-check endpoint for Railway
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", radarr: RADARR_URL });
  });

  app.listen(PORT, () => {
    console.error(
      `Radarr MCP server listening on port ${PORT} (SSE, ${RADARR_URL})`
    );
  });
}

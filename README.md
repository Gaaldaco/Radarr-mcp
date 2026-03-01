# Radarr MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to your [Radarr](https://radarr.video) movie library.

## Tools

| Tool | Description |
|------|-------------|
| `get_movies` | List library movies (optional TMDB filter) |
| `get_movie` | Get a movie by Radarr ID |
| `lookup_movie` | Search TMDB by title or `tmdb:<id>` |
| `add_movie` | Add a movie for monitoring/download |
| `update_movie` | Change monitoring, quality profile, etc. |
| `delete_movie` | Remove a movie (optionally delete files) |
| `get_calendar` | Upcoming releases (default: next 7 days) |
| `get_queue` | Current download queue |
| `delete_queue_item` | Remove a queue item |
| `get_history` | Download history |
| `get_wanted_missing` | Monitored but not downloaded |
| `get_wanted_cutoff` | Files below quality cutoff |
| `execute_command` | Run a Radarr command (RescanMovie, etc.) |
| `get_command_status` | Check command progress |
| `get_system_status` | Radarr system info |
| `get_health` | Health checks |
| `get_disk_space` | Disk usage |
| `get_quality_profiles` | List quality profiles |
| `get_root_folders` | List root folders |
| `get_tags` | List tags |
| `get_indexers` | List indexers |
| `get_download_clients` | List download clients |
| `get_movie_files` | Files for a specific movie |
| `delete_movie_file` | Delete a movie file from disk |
| `get_collections` | Movie collections |
| `get_logs` | Application logs |

## Quick Start

### Environment Variables

```bash
RADARR_URL=http://your-radarr-host:7878
RADARR_API_KEY=your_api_key          # Settings → General → Security
TRANSPORT=http                        # "http" (default) or "stdio"
PORT=3000
```

### Local (stdio) – Claude Desktop

```bash
npm install && npm run build
TRANSPORT=stdio RADARR_URL=... RADARR_API_KEY=... node dist/index.js
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "radarr": {
      "command": "node",
      "args": ["/path/to/radarr-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "RADARR_URL": "http://localhost:7878",
        "RADARR_API_KEY": "your_api_key"
      }
    }
  }
}
```

### Remote (HTTP/SSE) – Railway

Deploy via GitHub (see below), then connect Claude to:

```
https://your-service.up.railway.app/sse
```

## Deploy to Railway

1. Fork / push this repo to GitHub.
2. In Railway → **New Project** → **Deploy from GitHub repo** → select this repo.
3. Add environment variables:
   - `RADARR_URL` – your Radarr instance URL
   - `RADARR_API_KEY` – your Radarr API key
   - `TRANSPORT` = `http`
4. Railway auto-detects the `Dockerfile` and deploys.
5. Generate a public domain in Railway (Settings → Networking → Generate Domain).
6. Use the `/sse` endpoint URL in your MCP client.

### Connecting from Claude Desktop (remote)

```json
{
  "mcpServers": {
    "radarr": {
      "url": "https://your-service.up.railway.app/sse"
    }
  }
}
```

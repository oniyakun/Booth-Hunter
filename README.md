# Booth Hunter

AI-powered VRChat asset scout for Booth.pm.

## Features

- Multi-turn autonomous searching: AI evaluates results and refines keywords automatically.
- Real-time data scraping: Live information directly from Booth.pm.
- Cloud synchronization: Persistent chat history and authentication via Supabase.
- OpenAI compatible: Integration with custom API endpoints.

## Environment Variables

Required variables for .env.local and Vercel:

- GEMINI_API_KEY: Your API key.
- GEMINI_API_BASE_URL: Base URL for OpenAI compatible API (ending in /v1).
- GEMINI_MODEL: Model name (default: gemini-3-flash-preview).
- SUPABASE_URL: Your Supabase project URL.
- SUPABASE_ANON_KEY: Your Supabase anonymous key.

## Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run locally using Vercel CLI:
   ```bash
   vercel dev
   ```

Note: vercel dev is required to run the local Serverless Functions in the api directory.

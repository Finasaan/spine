# Spine API - Finasaan Backend Service

The Spine is a Cloudflare Worker that serves as the backend API for the Finasaan application, providing financial data and services through HTTP REST endpoints.

## Features

- **Supabase Integration**: PostgreSQL database connection via Supabase client
- **Companies API**: Access to company data and stock information
- **Mutual Funds API**: Mutual fund listings and NAV data
- **Sectors API**: Industry sector classification data
- **Financial Tips API**: Provides curated financial advice and tips
- **Health Check**: Service health monitoring endpoint
- **CORS Support**: Configured for cross-origin requests from the frontend
- **Simple HTTP API**: Easy to consume REST endpoints

## Database Setup

This service connects to a PostgreSQL database via Supabase. The schema is defined in `src/db/schema.sql`.

### Local Development

For local development, the service connects to a local Supabase instance (Docker). Configure your `.dev.vars` file:

```bash
# Local Supabase connection (Docker container)
SUPABASE_URL=http://localhost:54321
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

### Production Deployment

For production, set the secrets using Wrangler:

```bash
npx wrangler secret put SUPABASE_URL
# Enter your Supabase project URL when prompted

npx wrangler secret put SUPABASE_KEY
# Enter your Supabase anon key when prompted
```

## API Endpoints

### GET /api/financial-tips

Returns a list of financial tips with categories and priorities.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Start an Emergency Fund",
      "description": "Save 3-6 months of expenses for unexpected situations",
      "category": "savings",
      "priority": "high"
    }
  ],
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### GET /api/health

Health check endpoint for monitoring service status.

**Response:**

```json
{
  "status": "healthy",
  "service": "spine",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### GET /api/message

Simple test endpoint returning "Hello Hono!"

## Local Development

### Prerequisites

- Node.js version 24+ (use `nvm use 24`)
- npm or yarn
- Wrangler CLI

### Setup

1. Install dependencies:

```bash
nvm use 24
npm install
```

2. Start the development server:

```bash
npx wrangler dev
```

The API will be available on a random port (e.g., `http://localhost:40345`). Wrangler will display the actual port in the terminal output.

### Testing the API

You can test the endpoints using curl (replace the port with your actual port):

```bash
# Test health check
curl http://localhost:40345/api/health

# Test financial tips
curl http://localhost:40345/api/financial-tips

# Test message endpoint
curl http://localhost:40345/api/message
```

## Running with Core Application

To test the integration with the core frontend application:

1. **Terminal 1** (Spine):

```bash
cd spine
npx wrangler dev
```

2. **Terminal 2** (Core):

```bash
cd core
npx wrangler dev
```

3. Visit the Core frontend URL (displayed in terminal) to see the integration in action
4. The Service bindings will automatically connect when both workers are running

**Note**: When using `npx wrangler dev`, both workers will run on random ports. The Service bindings handle the communication automatically, so you don't need to worry about specific ports.

## Deployment

Deploy to Cloudflare Workers:

```bash
npx wrangler deploy
```

The spine worker can be deployed independently of the core application.

## Type Generation

Generate/synchronize types based on your Worker configuration:

```bash
npx wrangler types
```

## Configuration

The Worker uses TypeScript with Cloudflare bindings. Pass the `CloudflareBindings` as generics when instantiating Hono:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

## CORS Configuration

The API is configured to accept requests from:

- `http://localhost:3000` (local development)
- `https://*.finasaan.com` (production domains)

## Environment Variables

No environment variables are required for basic operation. The API runs with default configuration and returns mock data for the POC.

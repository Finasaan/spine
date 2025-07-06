# Spine API - Finasaan Backend Service

The Spine is a Cloudflare Worker that serves as the backend API for the Finasaan application, providing financial data and services through HTTP REST endpoints.

## Features

- **Financial Tips API**: Provides curated financial advice and tips
- **Health Check**: Service health monitoring endpoint
- **CORS Support**: Configured for cross-origin requests from the frontend
- **Simple HTTP API**: Easy to consume REST endpoints

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

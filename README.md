# Proxy URL Simulation Manager

## Prerequisites

- Node.js 20+
- npm
- Docker (optional, for containerized run)

## Local Installation

```bash
npm install
```

## Start Locally

```bash
npm run start
```

Manager UI/API default URL:

```text
http://localhost:9090
```

## Rate Limit Per Simulated Endpoint

New simulations now default to a max throughput of `3` requests per second per endpoint.

When creating a simulation via API, you can override it with:

- `max_requests_per_second` (integer > 0)

## CORS

To avoid browser CORS issues in deployment, manager API and HTTP simulated endpoints now allow all origins by default.

## Multi-Proxy HTTPS Deployment

For many dynamically created simulations, use one HTTPS/WSS gateway domain and route by simulation ID:

- Primary endpoint returned by API: `https://your-domain/proxy/<PORT-Number>` (or `wss://...` for WS)
- Internal simulation processes still run on dynamic local ports.
- No per-port TLS certificate management is required.

API fields:

- `endpoint`: manager gateway endpoint for client use
- `endpointDirect`: internal direct endpoint (`http://ip:port` or `ws://ip:port`)

## Docker

Build image:

```bash
docker build -t proxy-url .
```

Run container:

```bash
docker run --name proxy-url -p 9090:9090 proxy-url
```

Run detached:

```bash
docker run -d --name proxy-url -p 9090:9090 proxy-url
```

View logs:

```bash
docker logs -f proxy-url
```

Stop container:

```bash
docker stop proxy-url
```

Delete container:

```bash
docker rm proxy-url
```

Delete image:

```bash
docker rmi proxy-url
```

Optional full Docker cleanup:

```bash
docker system prune -a
```

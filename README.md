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
